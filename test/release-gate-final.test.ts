import { expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { command, type CommandResult as Result } from "./command";
import { registeredMkdtemp } from "./temp-registry";

setDefaultTimeout(30_000);

const projectRoot = join(import.meta.dir, "..");
const gatePath = join(projectRoot, "scripts", "release-gate.sh");
const configPath = join(projectRoot, ".gitleaks.toml");

async function repository(): Promise<string> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-gate-final-"));
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

function canonicalUuidShapes(): readonly string[] {
  return [
    ["00000000", "0000", "0000", "0000", "000000000000"].join("-"),
    ["ffffffff", "ffff", "ffff", "ffff", "ffffffffffff"].join("-"),
    ["12345678", "1234", "1234", "0123", "123456789abc"].join("-"),
    ["12345678", "1234", "1234", "c123", "123456789abc"].join("-"),
    ["12345678", "1234", "1234", "f123", "123456789abc"].join("-"),
  ];
}

function toolOutputKey(): string {
  return ["tool", "Output"].join("");
}

function serializedPrivateObject(key: string): string {
  return ['{"', key, '":{"nested":true}}\n'].join("");
}

test("ignored nested private directories fail in workspace and history", async () => {
  const currentRoot = await repository();
  try {
    await writeFile(join(currentRoot, ".gitignore"), "**/.ori/\n");
    const privateRoot = join(currentRoot, "nested", ".ori");
    await mkdir(privateRoot, { recursive: true });
    const marker = join(privateRoot, "marker.txt");
    await writeFile(marker, "synthetic marker\n");
    expect((await command(currentRoot, "git", ["check-ignore", "--quiet", marker])).status).toBe(0);
    expectFailure(await gate(currentRoot), "forbidden private-data path");
  } finally {
    await rm(currentRoot, { recursive: true, force: true });
  }

  const historyRoot = await repository();
  try {
    await writeFile(join(historyRoot, ".gitignore"), "**/.ori/\n");
    const privateRoot = join(historyRoot, "nested", ".ori");
    await mkdir(privateRoot, { recursive: true });
    const marker = join(privateRoot, "marker.txt");
    await writeFile(marker, "synthetic marker\n");
    await configureAuthor(historyRoot);
    expect((await command(historyRoot, "git", ["add", ".gitignore", ".gitleaks.toml"])).status).toBe(0);
    expect((await command(historyRoot, "git", ["add", "-f", marker])).status).toBe(0);
    expect((await command(historyRoot, "git", ["commit", "-m", "nested path control"])).status).toBe(0);
    await rm(join(historyRoot, "nested"), { recursive: true, force: true });
    expect((await command(historyRoot, "git", ["add", "-A"])).status).toBe(0);
    expectFailure(await gate(historyRoot), "forbidden private-data path in repository history");
  } finally {
    await rm(historyRoot, { recursive: true, force: true });
  }
});

test("structured private keys are rejected beneath source-oriented directories", async () => {
  const key = toolOutputKey();
  const cases = [
    ["src/captured.json", serializedPrivateObject(key)],
    ["test/captured.yaml", [`'`, key, `':\n  nested: true\n`].join("")],
    ["docs/captured.yml", ['"', key, '":\n  nested: true\n'].join("")],
    ["scripts/captured.yaml", [key, ":\n  nested:\n    value: true\n"].join("")],
  ] as const;

  for (const [path, content] of cases) {
    const root = await repository();
    try {
      const fixture = join(root, path);
      await mkdir(dirname(fixture), { recursive: true });
      await writeFile(fixture, content);
      expectFailure(await gate(root), "forbidden private-data field");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("schema declarations may name private fields", async () => {
  const root = await repository();
  try {
    const schemaRoot = join(root, "schemas");
    await mkdir(schemaRoot, { recursive: true });
    await writeFile(
      join(schemaRoot, "route.schema.json"),
      ['{"type":"object","properties":{"', toolOutputKey(), '":{"type":"object"}}}\n'].join(
        "",
      ),
    );
    expect((await gate(root)).status).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("src captured JSON remains forbidden in reachable history", async () => {
  const root = await repository();
  try {
    const captured = join(root, "src", "captured.json");
    await mkdir(dirname(captured), { recursive: true });
    await writeFile(captured, serializedPrivateObject(toolOutputKey()));
    await configureAuthor(root);
    expect((await command(root, "git", ["add", "."])).status).toBe(0);
    expect((await command(root, "git", ["commit", "-m", "structured history control"])).status).toBe(0);
    await writeFile(captured, "{}\n");
    expect((await command(root, "git", ["add", "src/captured.json"])).status).toBe(0);
    expectFailure(await gate(root), "forbidden private-data field in repository history");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all canonical UUID classes fail in content and filenames", async () => {
  for (const shape of canonicalUuidShapes()) {
    const contentRoot = await repository();
    try {
      await writeFile(join(contentRoot, "captured.txt"), `${shape}\n`);
      expectFailure(await gate(contentRoot), "unique identifier present");
    } finally {
      await rm(contentRoot, { recursive: true, force: true });
    }

    const filenameRoot = await repository();
    try {
      await writeFile(join(filenameRoot, `${shape}.txt`), "synthetic content\n");
      expectFailure(await gate(filenameRoot), "unique identifier present in filename");
    } finally {
      await rm(filenameRoot, { recursive: true, force: true });
    }
  }
});

test("a representative canonical UUID fails in reachable history", async () => {
  for (const shape of canonicalUuidShapes().slice(0, 1)) {
    const root = await repository();
    try {
      const captured = join(root, "captured.txt");
      await writeFile(captured, `${shape}\n`);
      await configureAuthor(root);
      expect((await command(root, "git", ["add", "."])).status).toBe(0);
      expect((await command(root, "git", ["commit", "-m", "UUID history control"])).status).toBe(0);
      await writeFile(captured, "synthetic replacement\n");
      expect((await command(root, "git", ["add", "captured.txt"])).status).toBe(0);
      expectFailure(await gate(root), "unique identifier present in repository history");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
