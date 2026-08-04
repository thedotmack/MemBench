import { afterEach, describe, expect, test } from "bun:test";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupRegisteredTempRoot, registeredMkdtemp } from "./temp-registry";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await cleanupRegisteredTempRoot(roots.pop() as string);
});

async function run(command: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...command], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function fakeScanner(exitCode: number): Promise<string> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-scanner-"));
  roots.push(root);
  const path = join(root, "fake-scanner.sh");
  await writeFile(path, `#!/usr/bin/env bash\nprintf 'synthetic-sensitive-marker\\n'\nprintf 'synthetic-sensitive-marker\\n' >&2\nexit ${exitCode}\n`);
  await chmod(path, 0o700);
  return path;
}

async function longScanner(kind: "sleep" | "huge", pidFile?: string): Promise<string> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-long-scanner-"));
  roots.push(root);
  const path = join(root, "fake-long-scanner.sh");
  const body = kind === "huge"
    ? "exec yes synthetic-sensitive-marker\n"
    : `printf '%s' "$$" > "${pidFile as string}"\nexec sleep 30\n`;
  await writeFile(path, `#!/usr/bin/env bash\n${body}`);
  await chmod(path, 0o700);
  return path;
}

async function stubbornScanner(directPidFile: string, descendantPidFile: string): Promise<string> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-stubborn-scanner-"));
  roots.push(root);
  const path = join(root, "fake-stubborn-scanner.sh");
  await writeFile(path, `#!/usr/bin/env bash
trap '' TERM INT HUP
bash -c 'trap "" TERM INT HUP; printf "%s" "$$" > "${descendantPidFile}"; while :; do sleep 1; done' &
printf '%s' "$$" > "${directPidFile}"
while :; do sleep 1; done
`);
  await chmod(path, 0o700);
  return path;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("redacted scanner wrapper", () => {
  test("maps clean, finding, scanner error, and missing binary to bounded statuses", async () => {
    const clean = await run(["bash", "scripts/trufflehog-redacted.sh", "filesystem", "."], { TRUFFLEHOG_BIN: await fakeScanner(0) });
    expect(clean).toEqual({ exitCode: 0, stdout: "trufflehog: clean\n", stderr: "" });

    const finding = await run(["bash", "scripts/trufflehog-redacted.sh", "filesystem", "."], { TRUFFLEHOG_BIN: await fakeScanner(183) });
    expect(finding.exitCode).toBe(10);
    expect(finding.stderr).toBe("trufflehog: findings detected (details redacted)\n");
    expect(finding.stdout + finding.stderr).not.toContain("synthetic-sensitive-marker");

    const scannerError = await run(["bash", "scripts/trufflehog-redacted.sh"], { TRUFFLEHOG_BIN: await fakeScanner(7) });
    expect(scannerError.exitCode).toBe(11);
    expect(scannerError.stderr).toBe("trufflehog: scanner error (details redacted)\n");

    const missing = await run(["bash", "scripts/trufflehog-redacted.sh"], { TRUFFLEHOG_BIN: "" });
    expect(missing).toEqual({ exitCode: 11, stdout: "", stderr: "trufflehog: scanner unavailable\n" });
  });

  test("bounds huge output and timeout without a buffered finding file", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-wrapper-output-"));
    roots.push(root);
    const result = await run(["bash", "scripts/trufflehog-redacted.sh"], {
      TRUFFLEHOG_BIN: await longScanner("huge"),
      TRUFFLEHOG_TIMEOUT_SECONDS: "1",
      TMPDIR: root,
    });
    expect(result).toEqual({ exitCode: 11, stdout: "", stderr: "trufflehog: scanner timeout (details redacted)\n" });
    expect(await readdir(root)).toEqual([]);
  });

  test("TERM terminates and reaps the active scanner and exposes only bounded status", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-wrapper-term-"));
    roots.push(root);
    const pidFile = join(root, "scanner.pid");
    const scanner = await longScanner("sleep", pidFile);
    const child = Bun.spawn(["bash", "scripts/trufflehog-redacted.sh"], {
      cwd: process.cwd(),
      env: { ...process.env, TRUFFLEHOG_BIN: scanner, TRUFFLEHOG_TIMEOUT_SECONDS: "30" },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await readFile(pidFile, "utf8")).length > 0) break; } catch { /* scanner has not started */ }
      await Bun.sleep(20);
    }
    const scannerPid = Number(await readFile(pidFile, "utf8"));
    expect(processExists(scannerPid)).toBeTrue();
    child.kill("SIGTERM");
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode).toBe(11);
    expect(stdout).toBe("");
    expect(stderr).toBe("trufflehog: scanner interrupted (details redacted)\n");
    expect(processExists(scannerPid)).toBeFalse();
  });

  test("hard timeout kills a TERM-ignoring scanner process group and remains elapsed-time bounded", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-wrapper-hard-timeout-"));
    roots.push(root);
    const directPidFile = join(root, "direct.pid");
    const descendantPidFile = join(root, "descendant.pid");
    const scanner = await stubbornScanner(directPidFile, descendantPidFile);
    const started = performance.now();
    const result = await run(["bash", "scripts/trufflehog-redacted.sh"], {
      TRUFFLEHOG_BIN: scanner,
      TRUFFLEHOG_TIMEOUT_SECONDS: "1",
    });
    const elapsed = performance.now() - started;
    expect(result).toEqual({ exitCode: 11, stdout: "", stderr: "trufflehog: scanner timeout (details redacted)\n" });
    expect(elapsed).toBeLessThan(3_500);
    const directPid = Number(await readFile(directPidFile, "utf8"));
    const descendantPid = Number(await readFile(descendantPidFile, "utf8"));
    for (let attempt = 0; attempt < 50 && (processExists(directPid) || processExists(descendantPid)); attempt += 1) {
      await Bun.sleep(20);
    }
    expect(processExists(directPid)).toBeFalse();
    expect(processExists(descendantPid)).toBeFalse();
  });
});

describe("workflow policy", () => {
  test("pins all actions and exact toolchain while separating live evaluation", async () => {
    const ci = await readFile(".github/workflows/ci.yml", "utf8");
    const live = await readFile(".github/workflows/live-eval.yml", "utf8");
    for (const workflow of [ci, live]) {
      expect(workflow).toContain("permissions:\n  contents: read");
      for (const match of workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/gu)) {
        expect(match[1]).toMatch(/^[a-f0-9]{40}$/u);
      }
      expect(workflow).toContain("bun-version: 1.3.9");
      expect(workflow).toContain("persist-credentials: false");
    }
    expect(ci).toContain("pull_request:");
    expect(ci).toContain("bun install --frozen-lockfile");
    expect(ci).toContain("bun audit --audit-level=high");
    expect(ci).toContain("gitleaks dir .");
    expect(ci).toContain("gitleaks git .");
    expect(live).not.toContain("pull_request:");
    expect(live).toContain("environment: live-evaluation");
    expect(live).toContain("default: false");

    const installer = await readFile("scripts/install-gitleaks.sh", "utf8");
    expect(installer).toContain("VERSION='8.30.1'");
    expect(installer).toContain("551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb");
    expect(installer).not.toMatch(/curl[^\n]*\|/u);
  });

  test("live preflight is dry by default and refuses flags plus a credential without a verified sandbox", async () => {
    const dry = await run(["bun", "scripts/live-preflight.ts"]);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("dry preflight only");
    const attempted = await run(["bun", "scripts/live-preflight.ts"], {
      MEMBENCH_LIVE_REQUESTED: "true",
      MEMBENCH_OPERATOR_CONFIRMED: "true",
      OPENROUTER_API_KEY: "synthetic-provider-credential",
    });
    expect(attempted.exitCode).toBe(2);
    expect(attempted.stderr).toBe("MemBench live evaluation refused: no verified live sandbox backend is configured.\n");
    expect(attempted.stdout + attempted.stderr).not.toContain("synthetic-provider-credential");
  });
});

describe("offline quickstart", () => {
  test("README command generates a credential-free deterministic allowlisted bundle", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-demo-"));
    roots.push(root);
    const destination = join(root, "bundle");
    const result = await run(["bun", "run", "demo", "--output", destination], { OPENROUTER_API_KEY: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^MemBench offline synthetic bundle: sha256:[a-f0-9]{64}\n$/u);
    expect((await readdir(destination)).sort()).toEqual([
      "manifest.json", "release-attestation.json", "release-provenance.json", "report.json", "report.junit.xml", "report.md",
    ]);
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("bun run demo --output");
    expect(readme).toContain("no network request");
    expect(readme).toContain("unavailable by default");
  });
});
