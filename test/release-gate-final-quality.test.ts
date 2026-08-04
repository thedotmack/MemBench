import { expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { command, type CommandResult as Result } from "./command";
import { registeredMkdtemp } from "./temp-registry";

setDefaultTimeout(30_000);

const projectRoot = join(import.meta.dir, "..");
const gatePath = join(projectRoot, "scripts", "release-gate.sh");
const scannerPath = join(projectRoot, "scripts", "privacy-scan.ts");
const configPath = join(projectRoot, ".gitleaks.toml");

async function repository(): Promise<string> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-gate-final-quality-"));
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
  const root = await registeredMkdtemp(join(tmpdir(), "membench-final-quality-direct-"));
  try {
    const candidate = join(root, "candidate");
    await writeFile(candidate, content);
    return await command(projectRoot, "bun", [scannerPath, "content", name, candidate]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function privateKey(): string {
  return ["tool", "Output"].join("");
}

function multilineJson(): string {
  return ['{"', privateKey(), '"\n:\n{"nested":true}}\n'].join("");
}

test("whitespace-separated JSON keys fail a direct structured scan", async () => {
  expect((await directContentScan("captured.json", multilineJson())).status).toBe(11);
});

const binaryCases: ReadonlyArray<{
  readonly name: string;
  readonly content: () => Uint8Array;
  readonly reason: string;
}> = [
  {
    name: "C0 control",
    content: () => new Uint8Array([65, 1, 66]),
    reason: "binary content present",
  },
  {
    name: "invalid UTF-8",
    content: () => new Uint8Array([195, 40]),
    reason: "binary content present",
  },
  {
    name: "disguised ZIP",
    content: () => new Uint8Array([80, 75, 3, 4, 65]),
    reason: "archive or binary file present",
  },
];

for (const binaryCase of binaryCases.filter(({ name }) => name === "invalid UTF-8")) {
  test(`${binaryCase.name} fails in worktree, index, and history`, async () => {
    const currentRoot = await repository();
    try {
      await writeFile(join(currentRoot, "captured.dat"), binaryCase.content());
      expectFailure(await gate(currentRoot), binaryCase.reason);
    } finally {
      await rm(currentRoot, { recursive: true, force: true });
    }

    const indexRoot = await repository();
    try {
      const captured = join(indexRoot, "captured.dat");
      await writeFile(captured, binaryCase.content());
      expect((await command(indexRoot, "git", ["add", "--", "captured.dat"])).status).toBe(0);
      await writeFile(captured, "synthetic replacement\n");
      expectFailure(await gate(indexRoot), binaryCase.reason);
    } finally {
      await rm(indexRoot, { recursive: true, force: true });
    }

    const historyRoot = await repository();
    try {
      const captured = join(historyRoot, "captured.dat");
      await writeFile(captured, binaryCase.content());
      await configureAuthor(historyRoot);
      expect((await command(historyRoot, "git", ["add", "."])).status).toBe(0);
      expect((await command(historyRoot, "git", ["commit", "-m", "binary control"])).status).toBe(0);
      await writeFile(captured, "synthetic replacement\n");
      expect((await command(historyRoot, "git", ["add", "--", "captured.dat"])).status).toBe(0);
      expectFailure(await gate(historyRoot), `${binaryCase.reason} in repository history`);
    } finally {
      await rm(historyRoot, { recursive: true, force: true });
    }
  });
}

for (const binaryCase of binaryCases.filter(({ name }) => name !== "invalid UTF-8")) {
  test(`${binaryCase.name} fails at the worktree boundary`, async () => {
    const root = await repository();
    try {
      await writeFile(join(root, "captured.dat"), binaryCase.content());
      expectFailure(await gate(root), binaryCase.reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

function populatedTypeScript(): string {
  return ["export const captured = { ", privateKey(), ": { nested: true } };\n"].join("");
}

function populatedMarkdown(): string {
  return ["```json\n{\"", privateKey(), '\": {"nested": true}}\n```\n'].join("");
}

test("populated private fields in TypeScript and Markdown fail direct scans", async () => {
  for (const [name, content] of [
    ["captured.ts", populatedTypeScript()],
    ["captured.md", populatedMarkdown()],
  ] as const) {
    expect((await directContentScan(name, content)).status).toBe(11);
  }
});

test("harmless source concept references remain allowed", async () => {
  const root = await repository();
  try {
    await writeFile(
      join(root, "concept.md"),
      ["The ", privateKey(), " concept names data that public bundles must omit.\n"].join(""),
    );
    const result = await gate(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("release gate: PASS\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("option-like filenames are safe in worktree, index, and history", async () => {
  const root = await repository();
  try {
    const names = ["-", "--", "-n", "--help"] as const;
    for (const name of names) {
      await writeFile(join(root, name), "synthetic content\n");
    }
    expect((await command(root, "git", ["add", "--", ...names.map((name) => `./${name}`)])).status).toBe(0);
    await configureAuthor(root);
    expect((await command(root, "git", ["commit", "-m", "option filename control"])).status).toBe(0);
    const result = await gate(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("release gate: PASS\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
