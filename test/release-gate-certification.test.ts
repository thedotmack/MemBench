import { expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { command, type CommandResult as Result } from "./command";
import { registeredMkdtemp } from "./temp-registry";

setDefaultTimeout(30_000);

const projectRoot = join(import.meta.dir, "..");
const gatePath = join(projectRoot, "scripts", "release-gate.sh");
const scannerPath = join(projectRoot, "scripts", "privacy-scan.ts");
const configPath = join(projectRoot, ".gitleaks.toml");

async function repository(): Promise<string> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-gate-certification-"));
  expect((await command(root, "git", ["init", "-b", "main"])).status).toBe(0);
  await copyFile(configPath, join(root, ".gitleaks.toml"));
  return root;
}

function gate(root: string): Promise<Result> {
  return command(root, "bash", [gatePath]);
}

function expectFailure(result: Result, reason: string): void {
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`release gate: FAILED (${reason})\n`);
}

async function configureAuthor(root: string): Promise<void> {
  expect((await command(root, "git", ["config", "user.name", "MemBench CI"])).status).toBe(0);
  expect((await command(root, "git", ["config", "user.email", "membench-ci"])).status).toBe(0);
}

async function directContentScan(name: string, content: string): Promise<Result> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-certification-direct-"));
  try {
    const candidate = join(root, "candidate");
    await writeFile(candidate, content);
    return await command(projectRoot, "bun", [scannerPath, "content", name, candidate]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const privateKeyVariants = [
  "raw_prompt",
  "raw-transcript",
  "tool_input",
  "tool-output",
  "local_path",
  "home-directory",
  "private_artifact_location",
] as const;

function serializedPrivateObject(key: string): string {
  return ['{"', key, '":{"nested":true}}\n'].join("");
}

test("Git index blobs cannot be hidden by safe unstaged worktree content", async () => {
  const root = await repository();
  try {
    const captured = join(root, "captured.json");
    await writeFile(captured, serializedPrivateObject(privateKeyVariants[3]));
    expect((await command(root, "git", ["add", "captured.json"])).status).toBe(0);
    await writeFile(captured, "{}\n");
    expectFailure(await gate(root), "forbidden private-data field");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snake_case and kebab-case private keys fail direct structured scans", async () => {
  for (const key of privateKeyVariants) {
    expect((await directContentScan("captured.yaml", `${key}:\n  nested: true\n`)).status).toBe(11);
  }
});

test("a representative normalized private key fails in reachable history", async () => {
  for (const key of privateKeyVariants.slice(0, 1)) {
    const root = await repository();
    try {
      const captured = join(root, "captured.yaml");
      await writeFile(captured, `${key}:\n  nested: true\n`);
      await configureAuthor(root);
      expect((await command(root, "git", ["add", "."])).status).toBe(0);
      expect((await command(root, "git", ["commit", "-m", "key variant control"])).status).toBe(0);
      await writeFile(captured, "safe: true\n");
      expect((await command(root, "git", ["add", "captured.yaml"])).status).toBe(0);
      expectFailure(await gate(root), "forbidden private-data field in repository history");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

function runtimeUuid(): string {
  return ["12345678", "1234", "1234", "0123", "123456789abc"].join("-");
}

function runtimeEmail(): string {
  return ["synthetic-operator", "@", "example", ".", "com"].join("");
}

function runtimeHome(): string {
  return ["/", "root", "/synthetic-operator"].join("");
}

function runtimeSecret(): string {
  const value = ["4f7c9a2e8b6d1f3a", "5c7e9b2d4f6a8c1e"].join("");
  return ["api", "_key = ", '"', value, '"'].join("");
}

test("the release gate source has no blanket scan exemption", async () => {
  const cases = [
    [runtimeUuid(), "unique identifier present"],
    [runtimeEmail(), "email-shaped value present"],
    [runtimeHome(), "absolute home path present"],
    [runtimeSecret(), "secret scan findings"],
  ] as const;

  for (const [leak, reason] of cases) {
    const root = await repository();
    try {
      const copiedGate = join(root, "scripts", "release-gate.sh");
      await mkdir(dirname(copiedGate), { recursive: true });
      await copyFile(gatePath, copiedGate);
      const cleanSource = await readFile(copiedGate, "utf8");
      await writeFile(copiedGate, `${cleanSource}\n# ${leak}\n`);
      expectFailure(await gate(root), reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("blank-line-only text is not classified as binary and NUL content is", async () => {
  const blankRoot = await repository();
  try {
    await writeFile(join(blankRoot, "blank.txt"), "\n\n\n");
    const result = await gate(blankRoot);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("release gate: PASS\n");
  } finally {
    await rm(blankRoot, { recursive: true, force: true });
  }

  const nulRoot = await repository();
  try {
    await writeFile(join(nulRoot, "binary.dat"), new Uint8Array([10, 0, 10]));
    expectFailure(await gate(nulRoot), "binary content present");
  } finally {
    await rm(nulRoot, { recursive: true, force: true });
  }
});
