import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { command, type CommandResult } from "./command";
import { registeredMkdtemp } from "./temp-registry";

const projectRoot = join(import.meta.dir, "..");
const scannerPath = join(projectRoot, "scripts", "privacy-scan.ts");

function privateKey(): string {
  return ["response", "Id"].join("");
}

async function scan(displayPath: string, content: string): Promise<CommandResult> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-privacy-unit-"));
  try {
    const candidate = join(root, "candidate");
    await writeFile(candidate, content);
    return await command(projectRoot, "bun", [scannerPath, "content", displayPath, candidate]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function scanPath(displayPath: string): Promise<CommandResult> {
  return command(projectRoot, "bun", [scannerPath, "path", displayPath]);
}

function staticTypeScriptCases(): ReadonlyArray<readonly [string, string]> {
  const key = privateKey();
  return [
    [
      "computed concatenation",
      ['const captured = { ["response" + "', "Id", '"]: "synthetic" };\n'].join(""),
    ],
    [
      "const-bound computed key",
      ['const key = "response" + "', "Id", '"; const captured = { [key]: true };\n'].join(""),
    ],
    [
      "static interpolated JSON template",
      [
        'const suffix = "',
        "Id",
        '"; const captured = `{"response${suffix}":"synthetic"}`;\n',
      ].join(""),
    ],
    [
      "Object.defineProperty",
      ['Object.defineProperty({}, "response" + "', "Id", '", { value: true });\n'].join(""),
    ],
    [
      "Reflect.set",
      ['Reflect.set({}, `response${"', "Id", '"}`, true);\n'].join(""),
    ],
    [
      "constructor parameter property",
      ["class Capture { constructor(public ", key, ": string) {} }\n"].join(""),
    ],
    [
      "constructor private-bearing initializer",
      ["class Capture { constructor(", key, ' = "synthetic") {} }\n'].join(""),
    ],
  ];
}

test("TypeScript AST detects bounded static private-key constructions", async () => {
  for (const [label, content] of staticTypeScriptCases()) {
    const result = await scan("candidate.ts", content);
    expect(result.status, label).toBe(11);
    expect(result.stdout, label).toBe("");
    expect(result.stderr, label).toBe("");
  }
});

test("TypeScript declaration-only forms remain allowed", async () => {
  const key = privateKey();
  const content = [
    "interface Route { readonly ",
    key,
    "?: string | readonly string[] }\n",
    "type RouteAlias = { ",
    key,
    ": string };\n",
    "class RouteDeclaration { ",
    key,
    "!: string }\n",
    "function accept(",
    key,
    ": string): string { return ",
    key,
    "; }\n",
  ].join("");
  expect((await scan("candidate.mts", content)).status).toBe(0);
  expect((await scan("candidate.cts", content)).status).toBe(0);
});

function referencedPrivateSchema(): string {
  const key = privateKey();
  return `${JSON.stringify({
    $defs: {
      "route/field": { type: "string", default: "synthetic" },
    },
    type: "object",
    properties: {
      [key]: { $ref: "#/$defs/route~1field" },
    },
  })}\n`;
}

test("JSON Schema local references preserve private declaration context", async () => {
  expect((await scan("schemas/candidate.schema.json", referencedPrivateSchema())).status).toBe(11);
});

test("JSON Schema private pattern declarations reject instance-bearing keywords", async () => {
  const key = privateKey();
  for (const keyword of ["default", "const", "examples"] as const) {
    const instance = keyword === "examples" ? ["synthetic"] : "synthetic";
    const content = `${JSON.stringify({
      type: "object",
      patternProperties: {
        [`^${key}$`]: { type: "string", [keyword]: instance },
      },
    })}\n`;
    expect((await scan("schemas/candidate.schema.json", content)).status, keyword).toBe(11);
  }
  const alternation = `${JSON.stringify({
    type: "object",
    patternProperties: {
      "^(responseId|safe)$": { default: "synthetic" },
    },
  })}\n`;
  expect((await scan("schemas/candidate.schema.json", alternation)).status).toBe(11);
});

test("JSON Schema pattern instances fail conservatively while declarations remain allowed", async () => {
  const cases = [
    ["^response(?:safe)?Id$", "default"],
    ["^response(?:x|)Id$", "const"],
    ["^response(?:foo){0,1}Id$", "examples"],
    ["^ordinary$", "enum"],
    [".*", "example"],
  ] as const;
  for (const [pattern, keyword] of cases) {
    const instance = keyword === "examples" || keyword === "enum"
      ? ["synthetic"]
      : "synthetic";
    const populated = `${JSON.stringify({
      patternProperties: { [pattern]: { type: "string", [keyword]: instance } },
    })}\n`;
    expect((await scan("schemas/candidate.schema.json", populated)).status, pattern).toBe(11);

    const declaration = `${JSON.stringify({
      patternProperties: { [pattern]: { type: "string" } },
    })}\n`;
    expect((await scan("schemas/candidate.schema.json", declaration)).status, pattern).toBe(0);
  }
});

test("unsupported JSON Schema dynamic references fail closed without details", async () => {
  const content = `${JSON.stringify({
    $dynamicAnchor: "node",
    properties: { safe: { $dynamicRef: "#node" } },
  })}\n`;
  const result = await scan("schemas/candidate.schema.json", content);
  expect(result.status).toBe(13);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("JSON Schema local references fail closed and recursive cycles terminate", async () => {
  const unresolved = `${JSON.stringify({ $ref: "#/$defs/missing" })}\n`;
  const malformed = `${JSON.stringify({ $ref: "#not-a-pointer" })}\n`;
  const external = `${JSON.stringify({ $ref: "https://example.invalid/schema" })}\n`;
  expect((await scan("schemas/candidate.schema.json", unresolved)).status).toBe(13);
  expect((await scan("schemas/candidate.schema.json", malformed)).status).toBe(13);
  expect((await scan("schemas/candidate.schema.json", external)).status).toBe(13);

  const recursive = `${JSON.stringify({
    $defs: { node: { $ref: "#/$defs/node" } },
    properties: { safe: { $ref: "#/$defs/node" } },
  })}\n`;
  expect((await scan("schemas/candidate.schema.json", recursive)).status).toBe(0);
});

test("YAML escaped keys and TOML table paths are decoded", async () => {
  const escapedKeys = ["\\x49", "\\u0049", "\\U00000049"] as const;
  for (const escape of escapedKeys) {
    const yaml = ['"res', "ponse", escape, 'd": "synthetic"\n'].join("");
    expect((await scan("candidate.yaml", yaml)).status, escape).toBe(11);
  }

  const key = privateKey();
  for (const toml of [
    `[${key}]\nvalue = "synthetic"\n`,
    `[[outer.${key}]]\nvalue = "synthetic"\n`,
    ['[outer."res', "ponse", "\\u0049", 'd"]\nvalue = "synthetic"\n'].join(""),
  ]) {
    expect((await scan("candidate.toml", toml)).status).toBe(11);
  }
});

test("runtime-dynamic keys and non-serialized Markdown tables are not completeness claims", async () => {
  const dynamic = [
    'const parts = ["response", "',
    "Id",
    '"]; const captured = { [parts.join("")]: true };\n',
  ].join("");
  expect((await scan("candidate.ts", dynamic)).status).toBe(0);
  expect((await scan("candidate.md", ["| Field |\n| --- |\n| ", privateKey(), " |\n"].join(""))).status).toBe(
    0,
  );
});

test("TypeScript static folding follows lexical symbols through shadowed scopes", async () => {
  const safe = [
    'const key = "response" + "Id";\n',
    'function nested() { const key = "safe"; return { [key]: true }; }\n',
    '{ const key = "ordinary"; const captured = { [key]: true }; }\n',
  ].join("");
  expect((await scan("candidate.ts", safe)).status).toBe(0);

  const unsafe = [
    'const key = "safe";\n',
    'function nested() { const key = "response" + "Id"; return { [key]: true }; }\n',
    '{ const key = "ordinary"; const captured = { [key]: true }; }\n',
  ].join("");
  expect((await scan("candidate.ts", unsafe)).status).toBe(11);
});

test("static folding budgets fail closed before exponential output growth", async () => {
  const declarations = ['const value0 = "x";'];
  for (let index = 1; index <= 20; index += 1) {
    declarations.push(`const value${index} = value${index - 1} + value${index - 1};`);
  }
  declarations.push("const captured = { [value20]: true };");
  const started = performance.now();
  const result = await scan("candidate.ts", `${declarations.join("\n")}\n`);
  expect(result.status).toBe(13);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(performance.now() - started).toBeLessThan(2_000);
});

test("cross-platform ambiguous filenames are rejected without excluding ordinary names", async () => {
  for (const name of [
    " leading.txt",
    "trailing.txt ",
    "trailing-dot.",
    "CON",
    "nul.txt",
    "nested/AUX.log",
    "nested/com9.data",
    "nested/Lpt1",
  ]) {
    expect((await scanPath(name)).status, name).toBe(10);
  }
  expect((await scanPath("nested/ordinary name.txt")).status).toBe(0);
});
