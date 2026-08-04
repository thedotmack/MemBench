import { expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { command, type CommandResult as Result } from "./command";
import { registeredMkdtemp } from "./temp-registry";

setDefaultTimeout(30_000);

const projectRoot = join(import.meta.dir, "..");
const gatePath = join(projectRoot, "scripts", "release-gate.sh");
const configPath = join(projectRoot, ".gitleaks.toml");

interface RouteMetadataDeclaration {
  responseId: string;
  toolCallId: string;
}

async function repository(): Promise<string> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-gate-hardening-"));
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

function uuidShape(): string {
  return ["12345678", "1234", "8123", "a123", "123456789abc"].join("-");
}

function emailShape(): string {
  return ["synthetic-operator", "@", "example", ".", "com"].join("");
}

function unixHomeShape(): string {
  return ["/", "root", "/synthetic-operator"].join("");
}

function windowsHomeShape(): string {
  return ["C:", "\\", "Users", "\\", "synthetic-operator"].join("");
}

function responseKey(): string {
  return ["response", "Id"].join("");
}

function serializedPrivateObject(key: string): string {
  return ['{"', key, '":{"nested":true}}\n'].join("");
}

function routeDeclaration(): string {
  const response = ["response", "Id"].join("");
  const toolCall = ["tool", "Call", "Id"].join("");
  return [
    "export interface RouteMetadata {",
    `  ${response}: string;`,
    `  ${toolCall}: string;`,
    "}",
    "",
  ].join("\n");
}

test("clean synthetic repository passes", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "safe.txt"), "newly authored synthetic content\n");
    const result = await gate(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("release gate: PASS\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source run paths and route declarations are allowed", async () => {
  const root = await repository();
  try {
    const sourceRoot = join(root, "src", "run");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, "route.ts"),
      routeDeclaration(),
    );
    expect((await gate(root)).status).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serialized private route fields remain forbidden", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "public-result.json"), serializedPrivateObject(responseKey()));
    expectFailure(await gate(root), "forbidden private-data field");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlink, archive, binary, and oversized controls fail closed", async () => {
  const cases: ReadonlyArray<{
    readonly prepare: (root: string) => Promise<unknown>;
    readonly reason: string;
  }> = [
    {
      prepare: async (root) => {
        await writeFile(join(root, "target.txt"), "synthetic target\n");
        return symlink("target.txt", join(root, "link.txt"));
      },
      reason: "symbolic link present",
    },
    {
      prepare: (root) => writeFile(join(root, "fixture.zip"), "synthetic text\n"),
      reason: "archive or binary file present",
    },
    {
      prepare: (root) => writeFile(join(root, "fixture.dat"), new Uint8Array([0, 1, 2])),
      reason: "binary content present",
    },
    {
      prepare: (root) => writeFile(join(root, "fixture.txt"), new Uint8Array(1048577).fill(120)),
      reason: "oversized file present",
    },
  ];

  for (const entry of cases) {
    const root = await repository();
    try {
      await entry.prepare(root);
      expectFailure(await gate(root), entry.reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("UUID v8, Unix home, Windows home, and email content fail closed", async () => {
  const cases = [
    [uuidShape(), "unique identifier present"],
    [unixHomeShape(), "absolute home path present"],
    [windowsHomeShape(), "absolute home path present"],
    [emailShape(), "email-shaped value present"],
  ] as const;

  for (const [content, reason] of cases) {
    const root = await repository();
    try {
      await writeFile(join(root, "fixture.txt"), `${content}\n`);
      expectFailure(await gate(root), reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

const filenameCases = [
  ["UUID", `${uuidShape()}.txt`, "unique identifier present in filename"],
  ["email", `${emailShape()}.txt`, "email-shaped value present in filename"],
  ["Windows profile", `${windowsHomeShape()}.txt`, "absolute home path present in filename"],
] as const;

for (const [label, name, reason] of filenameCases) {
  test(`${label} shape in a filename fails closed`, async () => {
    const root = await repository();
    try {
      await writeFile(join(root, name), "synthetic content\n");
      expectFailure(await gate(root), reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const excludedRoot of ["node_modules", "dist", "build", "coverage", ".cache"] as const) {
  test(`tracked ${excludedRoot} files are scanned unconditionally`, async () => {
    const root = await repository();
    try {
      await writeFile(join(root, ".gitignore"), `${excludedRoot}/\n`);
      const generatedRoot = join(root, excludedRoot);
      await mkdir(generatedRoot, { recursive: true });
      const artifact = join(generatedRoot, "public-result.json");
      await writeFile(artifact, serializedPrivateObject(responseKey()));
      expect((await command(root, "git", ["add", "-f", artifact])).status).toBe(0);
      expectFailure(await gate(root), "forbidden private-data field");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

const historyCases: ReadonlyArray<{
  readonly name: string;
  readonly path: () => string;
  readonly content: () => string | Uint8Array;
  readonly reason: string;
}> = [
  {
    name: "UUID content",
    path: () => "fixture.txt",
    content: uuidShape,
    reason: "unique identifier present in repository history",
  },
  {
    name: "UUID filename",
    path: () => `${uuidShape()}.txt`,
    content: () => "synthetic content\n",
    reason: "unique identifier present in filename in repository history",
  },
  {
    name: "email content",
    path: () => "fixture.txt",
    content: emailShape,
    reason: "email-shaped value present in repository history",
  },
  {
    name: "home content",
    path: () => "fixture.txt",
    content: windowsHomeShape,
    reason: "absolute home path present in repository history",
  },
  {
    name: "private field",
    path: () => "fixture.json",
    content: () => serializedPrivateObject(responseKey()),
    reason: "forbidden private-data field in repository history",
  },
  {
    name: "archive path",
    path: () => "fixture.zip",
    content: () => "synthetic text\n",
    reason: "archive or binary file present in repository history",
  },
  {
    name: "binary content",
    path: () => "fixture.dat",
    content: () => new Uint8Array([0, 1, 2]),
    reason: "binary content present in repository history",
  },
  {
    name: "oversized content",
    path: () => "fixture.txt",
    content: () => new Uint8Array(1048577).fill(120),
    reason: "oversized file present in repository history",
  },
];

for (const historyCase of historyCases.filter(({ name }) =>
  ["UUID filename", "email content", "home content", "oversized content"].includes(name)
)) {
  test(`non-secret historical ${historyCase.name} is rejected`, async () => {
    const root = await repository();
    try {
      const historicalPath = join(root, historyCase.path());
      await mkdir(dirname(historicalPath), { recursive: true });
      await writeFile(historicalPath, historyCase.content());
      expect((await command(root, "git", ["config", "user.name", "MemBench CI"])).status).toBe(0);
      expect((await command(root, "git", ["config", "user.email", "membench-ci"])).status).toBe(0);
      expect((await command(root, "git", ["add", "."])).status).toBe(0);
      expect((await command(root, "git", ["commit", "-m", "historical control"])).status).toBe(0);
      await rm(historicalPath, { force: true });
      await writeFile(join(root, "safe-current.txt"), "synthetic replacement\n");
      expect((await command(root, "git", ["add", "-A"])).status).toBe(0);
      expect((await command(root, "git", ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
      expectFailure(await gate(root), historyCase.reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
