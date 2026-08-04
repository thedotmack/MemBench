import { expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
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
  const root = await registeredMkdtemp(join(tmpdir(), "membench-parser-certification-"));
  expect((await command(root, "git", ["init", "-b", "main"])).status).toBe(0);
  await copyFile(configPath, join(root, ".gitleaks.toml"));
  return root;
}

async function configureAuthor(root: string): Promise<void> {
  expect((await command(root, "git", ["config", "user.name", "MemBench CI"])).status).toBe(0);
  expect((await command(root, "git", ["config", "user.email", "membench-ci"])).status).toBe(0);
}

function gate(root: string): Promise<Result> {
  return command(root, "bash", [gatePath]);
}

function expectFailure(result: Result, reason: string): void {
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`release gate: FAILED (${reason})\n`);
}

async function directContentScan(name: string, content: string): Promise<Result> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-parser-direct-"));
  try {
    const candidate = join(root, "candidate");
    await writeFile(candidate, content);
    return await command(projectRoot, "bun", [scannerPath, "content", name, candidate]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function directPathScan(name: string): Promise<Result> {
  return command(projectRoot, "bun", [scannerPath, "path", name]);
}

async function writeFixture(
  root: string,
  name: string,
  content: string | Uint8Array,
): Promise<string> {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

function safeReplacement(name: string): string {
  if (name.endsWith(".json")) return "{}\n";
  if (
    name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".mts") ||
    name.endsWith(".cts") ||
    name.endsWith(".js") ||
    name.endsWith(".jsx") ||
    name.endsWith(".mjs") ||
    name.endsWith(".cjs")
  ) {
    return "export {};\n";
  }
  if (name.endsWith(".toml")) return "safe = true\n";
  return "synthetic replacement\n";
}

async function expectContentFailureAcrossStates(
  name: string,
  content: string,
  reason = "forbidden private-data field",
): Promise<void> {
  const currentRoot = await repository();
  try {
    await writeFixture(currentRoot, name, content);
    expectFailure(await gate(currentRoot), reason);
  } finally {
    await rm(currentRoot, { recursive: true, force: true });
  }

  const indexRoot = await repository();
  try {
    const captured = await writeFixture(indexRoot, name, content);
    expect((await command(indexRoot, "git", ["add", "--", name])).status).toBe(0);
    await writeFile(captured, safeReplacement(name));
    expectFailure(await gate(indexRoot), reason);
  } finally {
    await rm(indexRoot, { recursive: true, force: true });
  }

  const historyRoot = await repository();
  try {
    const captured = await writeFixture(historyRoot, name, content);
    await configureAuthor(historyRoot);
    expect((await command(historyRoot, "git", ["add", "."])).status).toBe(0);
    expect((await command(historyRoot, "git", ["commit", "-m", "private field control"])).status).toBe(0);
    await writeFile(captured, safeReplacement(name));
    expect((await command(historyRoot, "git", ["add", "--", name])).status).toBe(0);
    expectFailure(await gate(historyRoot), `${reason} in repository history`);
  } finally {
    await rm(historyRoot, { recursive: true, force: true });
  }
}

async function expectBinaryFailureAcrossStates(name: string, content: string): Promise<void> {
  const currentRoot = await repository();
  try {
    await writeFixture(currentRoot, name, content);
    expectFailure(await gate(currentRoot), "binary content present");
  } finally {
    await rm(currentRoot, { recursive: true, force: true });
  }

  const indexRoot = await repository();
  try {
    const captured = await writeFixture(indexRoot, name, content);
    expect((await command(indexRoot, "git", ["add", "--", name])).status).toBe(0);
    await writeFile(captured, "synthetic replacement\n");
    expectFailure(await gate(indexRoot), "binary content present");
  } finally {
    await rm(indexRoot, { recursive: true, force: true });
  }

  const historyRoot = await repository();
  try {
    const captured = await writeFixture(historyRoot, name, content);
    await configureAuthor(historyRoot);
    expect((await command(historyRoot, "git", ["add", "."])).status).toBe(0);
    expect((await command(historyRoot, "git", ["commit", "-m", "text control"])).status).toBe(0);
    await writeFile(captured, "synthetic replacement\n");
    expect((await command(historyRoot, "git", ["add", "--", name])).status).toBe(0);
    expectFailure(await gate(historyRoot), "binary content present in repository history");
  } finally {
    await rm(historyRoot, { recursive: true, force: true });
  }
}

async function expectPathFailureAcrossStates(name: string): Promise<void> {
  const currentRoot = await repository();
  try {
    await writeFixture(currentRoot, name, "synthetic content\n");
    expectFailure(await gate(currentRoot), "unsafe filename");
  } finally {
    await rm(currentRoot, { recursive: true, force: true });
  }

  const indexRoot = await repository();
  try {
    const captured = await writeFixture(indexRoot, name, "synthetic content\n");
    expect((await command(indexRoot, "git", ["add", "--", name])).status).toBe(0);
    await rm(captured);
    expectFailure(await gate(indexRoot), "unsafe filename");
  } finally {
    await rm(indexRoot, { recursive: true, force: true });
  }

  const historyRoot = await repository();
  try {
    await writeFixture(historyRoot, name, "synthetic content\n");
    await configureAuthor(historyRoot);
    expect((await command(historyRoot, "git", ["add", "."])).status).toBe(0);
    expect((await command(historyRoot, "git", ["commit", "-m", "path control"])).status).toBe(0);
    expect((await command(historyRoot, "git", ["rm", "--", name])).status).toBe(0);
    expectFailure(await gate(historyRoot), "unsafe filename in repository history");
  } finally {
    await rm(historyRoot, { recursive: true, force: true });
  }
}

async function expectArchiveFailureAcrossStates(name: string, content: Uint8Array): Promise<void> {
  const currentRoot = await repository();
  try {
    await writeFixture(currentRoot, name, content);
    expectFailure(await gate(currentRoot), "archive or binary file present");
  } finally {
    await rm(currentRoot, { recursive: true, force: true });
  }

  const indexRoot = await repository();
  try {
    const captured = join(indexRoot, name);
    await writeFile(captured, content);
    expect((await command(indexRoot, "git", ["add", "--", name])).status).toBe(0);
    await writeFile(captured, "synthetic replacement\n");
    expectFailure(await gate(indexRoot), "archive or binary file present");
  } finally {
    await rm(indexRoot, { recursive: true, force: true });
  }

  const historyRoot = await repository();
  try {
    const captured = join(historyRoot, name);
    await writeFile(captured, content);
    await configureAuthor(historyRoot);
    expect((await command(historyRoot, "git", ["add", "."])).status).toBe(0);
    expect((await command(historyRoot, "git", ["commit", "-m", "archive control"])).status).toBe(0);
    await writeFile(captured, "synthetic replacement\n");
    expect((await command(historyRoot, "git", ["add", "--", name])).status).toBe(0);
    expectFailure(await gate(historyRoot), "archive or binary file present in repository history");
  } finally {
    await rm(historyRoot, { recursive: true, force: true });
  }
}

function privateKey(): string {
  return ["response", "Id"].join("");
}

function escapedPrivateKey(): string {
  return ["res", "ponse", "\\u0049", "d"].join("");
}

function escapedJson(): string {
  return [
    String.fromCodePoint(0xfeff),
    '{"',
    escapedPrivateKey(),
    '":{"synthetic":true}}\n',
  ].join("");
}

function unicodeTypeScriptObject(): string {
  return [
    String.fromCodePoint(0xfeff),
    "export const captured = { \"",
    escapedPrivateKey(),
    "\"",
    String.fromCodePoint(0x00a0),
    "/* synthetic comment */",
    String.fromCodePoint(0x2003, 0x2028),
    ": { synthetic: true } };\n",
  ].join("");
}

function serializedMarkdown(): string {
  return ["```json\n{\"", escapedPrivateKey(), '\": {"synthetic": true}}\n```\n'].join("");
}

function declarationOnlyTypeScript(): string {
  const key = privateKey();
  return [
    "export interface RouteMetadata {\n  readonly ",
    key,
    "?: string | readonly string[];\n}\n",
    "export type RouteMetadataAlias = {\n  readonly ",
    key,
    "?:\n    | string\n    | readonly string[];\n};\n",
  ].join("");
}

function declarationOnlySchema(): string {
  const key = privateKey();
  return `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { [key]: { type: ["string", "array"] } },
      required: [key],
    },
    null,
    2,
  )}\n`;
}

function staticModulePayload(): string {
  return [
    'const key = "response" + "',
    "Id",
    '"; export const captured = { [key]: "synthetic" };\n',
  ].join("");
}

function staticTemplatePayload(): string {
  return [
    'const suffix = "',
    "Id",
    '"; export const captured = `{"response${suffix}":"synthetic"}`;\n',
  ].join("");
}

function referencedSchemaPayload(): string {
  const key = privateKey();
  return `${JSON.stringify({
    $defs: { field: { type: "string", default: "synthetic" } },
    properties: { [key]: { $ref: "#/$defs/field" } },
  })}\n`;
}

function escapedYamlPayload(): string {
  return ['"res', "ponse", "\\x49", 'd": "synthetic"\n'].join("");
}

function tomlTablePayload(): string {
  return ["[outer.", privateKey(), "]\nvalue = \"synthetic\"\n"].join("");
}

function conservativePatternSchema(
  pattern: string,
  keyword: "default" | "const" | "examples" | "enum" | "example",
): string {
  const instance = keyword === "examples" || keyword === "enum"
    ? ["synthetic"]
    : "synthetic";
  return `${JSON.stringify({
    type: "object",
    patternProperties: {
      [pattern]: { type: "string", [keyword]: instance },
    },
  })}\n`;
}

function shadowedStaticPayload(): string {
  return [
    'const key = "safe";\n',
    'function nested() { const key = "response" + "Id"; return { [key]: true }; }\n',
    '{ const key = "ordinary"; const captured = { [key]: true }; }\n',
  ].join("");
}

function dynamicReferenceSchema(): string {
  return `${JSON.stringify({
    $dynamicAnchor: "node",
    properties: { safe: { $dynamicRef: "#node" } },
  })}\n`;
}

function populatedSchema(keyword: "const" | "default" | "examples"): string {
  const key = privateKey();
  const value = keyword === "examples" ? ["synthetic-value"] : "synthetic-value";
  return `${JSON.stringify({ type: "object", properties: { [key]: { type: "string", [keyword]: value } } })}\n`;
}

test("JSON parser decodes BOM and Unicode-escaped private keys directly", async () => {
  expect((await directContentScan("captured.json", escapedJson())).status).toBe(11);
});

test("TypeScript AST catches escaped properties after Unicode trivia and comments", async () => {
  expect((await directContentScan("captured.ts", unicodeTypeScriptObject())).status).toBe(11);
});

test("Markdown serialization catches escaped private fields directly", async () => {
  expect((await directContentScan("captured.md", serializedMarkdown())).status).toBe(11);
});

test("TypeScript interface and type declarations remain allowed", async () => {
  expect((await directContentScan("declarations.ts", declarationOnlyTypeScript())).status).toBe(0);
});

test("JSON Schema property declarations remain allowed", async () => {
  expect((await directContentScan(
    "schemas/declarations.schema.json",
    declarationOnlySchema(),
  )).status).toBe(0);
});

for (const keyword of ["examples", "default", "const"] as const) {
  test(`JSON Schema ${keyword} instances fail directly`, async () => {
    expect((await directContentScan(
      `schemas/${keyword}.schema.json`,
      populatedSchema(keyword),
    )).status).toBe(11);
  });
}

for (const [label, point] of [
  ["DEL", 0x007f],
  ["C1", 0x0085],
] as const) {
  test(`${label} text controls fail directly`, async () => {
    expect((await directContentScan(`${label.toLocaleLowerCase("en-US")}.txt`, [
      "synthetic",
      String.fromCodePoint(point),
      "content\n",
    ].join(""))).status).toBe(12);
  });
}

for (const [label, point] of [
  ["tab", 0x0009],
  ["C0", 0x0001],
  ["DEL", 0x007f],
  ["C1", 0x0085],
  ["line separator", 0x2028],
  ["format", 0x200b],
  ["non-ASCII space separator", 0x00a0],
] as const) {
  test(`${label} filenames fail directly`, async () => {
    expect((await directPathScan(
      ["unsafe", String.fromCodePoint(point), ".txt"].join(""),
    )).status).toBe(10);
  });
}

test("a control filename fails in worktree, index, and history", async () => {
  await expectPathFailureAcrossStates(["unsafe", String.fromCodePoint(0x0001), ".txt"].join(""));
});

test("ordinary Unicode filenames remain safe directly", async () => {
  expect((await directPathScan("café-日本 safe.txt")).status).toBe(0);
});

test("MTS static keys fail a direct structured scan", async () => {
  expect((await directContentScan("captured.mts", staticModulePayload())).status).toBe(11);
});

test("CTS static templates fail a direct structured scan", async () => {
  expect((await directContentScan("captured.cts", staticTemplatePayload())).status).toBe(11);
});

test("referenced JSON Schema private defaults fail a direct structured scan", async () => {
  expect((await directContentScan(
    "schemas/referenced.schema.json",
    referencedSchemaPayload(),
  )).status).toBe(11);
});

test("YAML escaped private keys fail a direct structured scan", async () => {
  expect((await directContentScan("captured.yaml", escapedYamlPayload())).status).toBe(11);
});

test("TOML private table paths fail a direct structured scan", async () => {
  expect((await directContentScan("captured.toml", tomlTablePayload())).status).toBe(11);
});

test("optional pattern-property instances fail in every source state", async () => {
  const cases = [
    ["optional", "^response(?:safe)?Id$", "default"],
    ["empty-alternative", "^response(?:x|)Id$", "const"],
    ["optional-repeat", "^response(?:foo){0,1}Id$", "examples"],
    ["enum", "^ordinary$", "enum"],
    ["example", ".*", "example"],
  ] as const;
  for (const [label, pattern, keyword] of cases) {
    await expectContentFailureAcrossStates(
      `schemas/${label}.schema.json`,
      conservativePatternSchema(pattern, keyword),
    );
  }
});

test("shadowed TypeScript const bindings resolve lexically in every source state", async () => {
  await expectContentFailureAcrossStates("captured.ts", shadowedStaticPayload());
});

test("dynamic JSON Schema references fail closed in every source state", async () => {
  await expectContentFailureAcrossStates(
    "schemas/dynamic.schema.json",
    dynamicReferenceSchema(),
    "invalid structured content",
  );
});

test("Unix ar magic fails in the worktree boundary", async () => {
  const root = await repository();
  try {
    await writeFixture(root, "captured.dat", new TextEncoder().encode("!<arch>\nsynthetic"));
    expectFailure(await gate(root), "archive or binary file present");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
