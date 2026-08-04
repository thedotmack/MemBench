import { expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { command, type CommandResult } from "./command";
import { registeredMkdtemp } from "./temp-registry";

setDefaultTimeout(30_000);

const projectRoot = join(import.meta.dir, "..");
const releaseGate = join(projectRoot, "scripts", "release-gate.sh");
const gitleaksConfig = join(projectRoot, ".gitleaks.toml");

const forbiddenPrivatePaths = [
  ".ori",
  ".claude",
  ".codex",
  "private",
  "artifact",
  "artifacts",
  "run",
  "runs",
  "transcript",
  "transcripts",
  "tool-output",
] as const;

async function makeRepository(): Promise<string> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-release-gate-"));
  const initialized = await command(root, "git", ["init", "-b", "main"]);
  expect(initialized.status).toBe(0);
  await copyFile(gitleaksConfig, join(root, ".gitleaks.toml"));
  return root;
}

function runGate(root: string): Promise<CommandResult> {
  return command(root, "bash", [releaseGate]);
}

function runtimeSecretFixture(): string {
  const candidate = ["4f7c9a2e8b6d1f3a", "5c7e9b2d4f6a8c1e"].join("");
  return ["api", "_key = ", '"', candidate, '"', "\n"].join("");
}

for (const forbiddenPath of forbiddenPrivatePaths) {
  test(`release gate rejects ignored ${forbiddenPath} content`, async () => {
    const root = await makeRepository();
    try {
      const ignoreRules = forbiddenPrivatePaths.map((path) => `${path}/`).join("\n");
      await writeFile(join(root, ".gitignore"), `${ignoreRules}\n`);
      const privateRoot = join(root, forbiddenPath);
      await mkdir(privateRoot, { recursive: true });
      const marker = join(privateRoot, "marker.txt");
      await writeFile(marker, "newly authored synthetic marker\n");

      const ignored = await command(root, "git", ["check-ignore", "--quiet", marker]);
      expect(ignored.status).toBe(0);

      const result = await runGate(root);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("release gate: FAILED (forbidden private-data path)\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("filesystem secret scan fails with a generic redacted message", async () => {
  const root = await makeRepository();
  try {
    await writeFile(join(root, "scanner-positive-control.txt"), runtimeSecretFixture());

    const result = await runGate(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("release gate: FAILED (secret scan findings)\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one-commit history secret scan fails with a generic redacted message", async () => {
  const root = await makeRepository();
  try {
    await writeFile(join(root, "scanner-positive-control.txt"), runtimeSecretFixture());
    expect((await command(root, "git", ["config", "user.name", "MemBench CI"])).status).toBe(0);
    expect((await command(root, "git", ["config", "user.email", "membench-ci"])).status).toBe(0);
    expect((await command(root, "git", ["add", "."])).status).toBe(0);
    expect((await command(root, "git", ["commit", "-m", "scanner positive control"])).status).toBe(0);
    await writeFile(join(root, "scanner-positive-control.txt"), "synthetic replacement\n");
    expect((await command(root, "git", ["add", "scanner-positive-control.txt"])).status).toBe(0);

    const commitCount = await command(root, "git", ["rev-list", "--count", "HEAD"]);
    expect(commitCount.status).toBe(0);
    expect(commitCount.stdout.trim()).toBe("1");

    const result = await runGate(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "release gate: FAILED (secret scan findings in repository history)\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
