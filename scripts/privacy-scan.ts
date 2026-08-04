import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { API, type Checker } from "typescript/unstable/async";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";

const EXIT_UNSAFE_PATH = 10;
const EXIT_PRIVATE_KEY = 11;
const EXIT_NON_TEXT = 12;
const EXIT_INVALID_STRUCTURED = 13;

const privateKeys = new Set([
  "sessionid",
  "requestid",
  "toolcallid",
  "conversationid",
  "responseid",
  "rawprompt",
  "rawtranscript",
  "toolinput",
  "tooloutput",
  "localpath",
  "homedirectory",
  "privateartifactlocation",
]);

const schemaInstanceKeywords = new Set([
  "const",
  "default",
  "enum",
  "example",
  "examples",
]);

function canonicalKey(value: string): string {
  return value.normalize("NFKC").replace(/[_-]/gu, "").toLocaleLowerCase("en-US");
}

function isPrivateKey(value: string): boolean {
  return privateKeys.has(canonicalKey(value));
}

function unsafePath(value: string): boolean {
  if (Array.from(value).some(
    (character) => character !== " " && /[\p{Cc}\p{Cf}\p{Z}]/u.test(character),
  )) {
    return true;
  }
  return value.split(/[\\/]/u).some((segment) =>
    segment.startsWith(" ") ||
    segment.endsWith(" ") ||
    segment.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
  );
}

function decodedText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u007f-\u009f]/u.test(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function scanInstance(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(scanInstance);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => isPrivateKey(key) || scanInstance(nested));
}

function decodePointerSegment(segment: string): string {
  if (/~(?:[^01]|$)/u.test(segment)) throw new Error("invalid JSON Pointer escape");
  return segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function resolveLocalReference(root: unknown, reference: unknown): unknown {
  if (typeof reference !== "string" || !reference.startsWith("#")) {
    throw new Error("only local JSON Schema references are supported");
  }
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) throw new Error("invalid local JSON Schema reference");

  let fragment: string;
  try {
    fragment = decodeURIComponent(reference.slice(2));
  } catch {
    throw new Error("invalid local JSON Schema reference encoding");
  }

  let current = root;
  for (const encodedSegment of fragment.split("/")) {
    const segment = decodePointerSegment(encodedSegment);
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      throw new Error("unresolvable local JSON Schema reference");
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

interface SchemaScanState {
  readonly root: unknown;
  readonly publicVisited: WeakSet<object>;
  readonly privateVisited: WeakSet<object>;
  readonly patternVisited: WeakSet<object>;
}

function scanSchema(
  value: unknown,
  state: SchemaScanState,
  privateDeclaration = false,
  patternDeclaration = false,
): boolean {
  if (Array.isArray(value)) {
    const visited = privateDeclaration
      ? state.privateVisited
      : patternDeclaration
        ? state.patternVisited
        : state.publicVisited;
    if (visited.has(value)) return false;
    visited.add(value);
    return value.some((nested) =>
      scanSchema(nested, state, privateDeclaration, patternDeclaration)
    );
  }
  if (value === null || typeof value !== "object") return false;

  const visited = privateDeclaration
    ? state.privateVisited
    : patternDeclaration
      ? state.patternVisited
      : state.publicVisited;
  if (visited.has(value)) return false;
  visited.add(value);

  for (const [keyword, nested] of Object.entries(value)) {
    if (isPrivateKey(keyword)) return true;
    if (keyword === "$dynamicRef") {
      throw new Error("unsupported JSON Schema dynamic reference");
    }
    if (keyword === "$ref") {
      if (scanSchema(
        resolveLocalReference(state.root, nested),
        state,
        privateDeclaration,
        patternDeclaration,
      )) {
        return true;
      }
      continue;
    }
    if (schemaInstanceKeywords.has(keyword)) {
      if (privateDeclaration || patternDeclaration) {
        return true;
      }
      if (scanInstance(nested)) return true;
      continue;
    }
    if (keyword === "required" && Array.isArray(nested)) continue;
    if (keyword === "properties" && nested !== null && typeof nested === "object") {
      for (const [property, childSchema] of Object.entries(nested)) {
        if (scanSchema(
          childSchema,
          state,
          privateDeclaration || isPrivateKey(property),
          patternDeclaration,
        )) {
          return true;
        }
      }
      continue;
    }
    if (keyword === "patternProperties" && nested !== null && typeof nested === "object") {
      for (const childSchema of Object.values(nested)) {
        if (scanSchema(childSchema, state, privateDeclaration, true)) {
          return true;
        }
      }
      continue;
    }
    if (scanSchema(nested, state, privateDeclaration, patternDeclaration)) return true;
  }
  return false;
}

function normalizedQuotedEscapes(raw: string): string | undefined {
  let invalid = false;
  const normalized = raw
    .replace(/\\x([0-9a-f]{2})/giu, "\\u00$1")
    .replace(/\\U([0-9a-f]{8})/gu, (_escape, digits: string) => {
      const point = Number.parseInt(digits, 16);
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
        invalid = true;
        return "";
      }
      return JSON.stringify(String.fromCodePoint(point)).slice(1, -1);
    });
  return invalid ? undefined : normalized;
}

function decodedToken(raw: string): string | undefined {
  if (raw.startsWith('"')) {
    try {
      const normalized = normalizedQuotedEscapes(raw);
      return normalized === undefined ? undefined : (JSON.parse(normalized) as string);
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("'")) {
    return raw.slice(1, -1).replace(/''/gu, "'");
  }
  return raw;
}

function skipTrivia(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const whitespace = text.slice(index).match(/^\s+/u);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      return end < 0 ? text.length : skipTrivia(text, end + 2);
    }
    if (text.startsWith("//", index)) {
      const end = text.slice(index + 2).search(/[\r\n\u2028\u2029]/u);
      return end < 0 ? text.length : skipTrivia(text, index + 2 + end + 1);
    }
    break;
  }
  return index;
}

function scanKeySyntax(text: string): boolean {
  const tokenPattern = /"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[\p{L}_$][\p{L}\p{N}_$-]*/gu;
  for (const match of text.matchAll(tokenPattern)) {
    const decoded = decodedToken(match[0]);
    if (!decoded || !isPrivateKey(decoded)) continue;
    const delimiter = skipTrivia(text, (match.index ?? 0) + match[0].length);
    if (text[delimiter] === ":" || text[delimiter] === "=") return true;
  }
  return false;
}

function scanTomlTables(text: string): boolean {
  const tokenPattern = /"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[\p{L}_$][\p{L}\p{N}_$-]*/gu;
  for (const line of text.split(/\r?\n/u)) {
    const table = line.match(/^\s*\[\[?(.+?)\]\]?\s*(?:#.*)?$/u);
    if (!table?.[1]) continue;
    for (const match of table[1].matchAll(tokenPattern)) {
      const decoded = decodedToken(match[0]);
      if (decoded && isPrivateKey(decoded)) return true;
    }
  }
  return false;
}

const STATIC_MAX_DEPTH = 64;
const STATIC_MAX_OPERATIONS = 4_096;
const STATIC_MAX_OUTPUT = 4_096;

interface StaticEvaluationState {
  readonly bindings: ReadonlyMap<number, ts.Expression | null>;
  readonly symbols: WeakMap<ts.Identifier, number>;
  readonly memo: WeakMap<ts.Expression, string | null>;
  readonly resolving: Set<number>;
  operations: number;
  exhausted: boolean;
}

function boundedStaticValue(value: string, state: StaticEvaluationState): string | undefined {
  if (value.length <= STATIC_MAX_OUTPUT) return value;
  state.exhausted = true;
  return undefined;
}

function staticString(
  node: ts.Expression,
  state: StaticEvaluationState,
  depth = 0,
): string | undefined {
  if (state.exhausted) return undefined;
  if (depth > STATIC_MAX_DEPTH || state.operations >= STATIC_MAX_OPERATIONS) {
    state.exhausted = true;
    return undefined;
  }
  if (state.memo.has(node)) return state.memo.get(node) ?? undefined;
  state.operations += 1;

  let result: string | undefined;
  if (ts.isStringLiteralLikeNode(node) || ts.isNumericLiteral(node)) {
    result = boundedStaticValue(node.text, state);
  } else if (ts.isIdentifier(node)) {
    const symbol = state.symbols.get(node);
    const binding = symbol === undefined ? undefined : state.bindings.get(symbol);
    if (symbol !== undefined && binding && !state.resolving.has(symbol)) {
      state.resolving.add(symbol);
      try {
        result = staticString(binding, state, depth + 1);
      } finally {
        state.resolving.delete(symbol);
      }
    }
  } else if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertion(node)
  ) {
    result = staticString(node.expression, state, depth + 1);
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left, state, depth + 1);
    const right = staticString(node.right, state, depth + 1);
    if (left !== undefined && right !== undefined) {
      if (left.length + right.length <= STATIC_MAX_OUTPUT) {
        result = left + right;
      } else {
        state.exhausted = true;
      }
    }
  } else if (ts.isTemplateExpression(node)) {
    let combined = boundedStaticValue(node.head.text, state);
    for (const span of node.templateSpans) {
      if (combined === undefined) break;
      const expression = staticString(span.expression, state, depth + 1);
      if (expression === undefined) {
        combined = undefined;
        break;
      }
      const nextLength = combined.length + expression.length + span.literal.text.length;
      if (nextLength > STATIC_MAX_OUTPUT) {
        state.exhausted = true;
        combined = undefined;
        break;
      }
      combined += expression + span.literal.text;
    }
    result = combined;
  }

  state.memo.set(node, result ?? null);
  return result;
}

function propertyName(node: ts.PropertyName, state: StaticEvaluationState): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLikeNode(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    return staticString(node.expression, state);
  }
  return undefined;
}

function assignmentTargetName(node: ts.Expression, state: StaticEvaluationState): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    return staticString(node.argumentExpression, state);
  }
  return undefined;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isPrivateMutationCall(node: ts.CallExpression, state: StaticEvaluationState): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (!ts.isIdentifier(node.expression.expression)) return false;

  const owner = node.expression.expression.text;
  const method = node.expression.name.text;
  if (!((owner === "Object" && method === "defineProperty") || (owner === "Reflect" && method === "set"))) {
    return false;
  }
  const key = node.arguments[1];
  return key !== undefined && isPrivateKey(staticString(key, state) ?? "");
}

function isPrivateConstructorParameter(node: ts.ParameterDeclaration): boolean {
  if (!ts.isConstructorDeclaration(node.parent) || !ts.isIdentifier(node.name)) return false;
  const parameterProperty = node.modifiers?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.PublicKeyword ||
    modifier.kind === ts.SyntaxKind.PrivateKeyword ||
    modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
    modifier.kind === ts.SyntaxKind.ReadonlyKeyword ||
    modifier.kind === ts.SyntaxKind.OverrideKeyword
  );
  return isPrivateKey(node.name.text) && (parameterProperty === true || node.initializer !== undefined);
}

async function createStaticEvaluationState(
  source: ts.SourceFile,
  checker: Checker,
): Promise<StaticEvaluationState> {
  const identifiers: ts.Identifier[] = [];
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.push(node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      declarations.push(node);
    }
    node.forEachChild(collect);
  };
  collect(source);

  const resolved = await checker.getSymbolAtLocation(identifiers);
  const symbols = new WeakMap<ts.Identifier, number>();
  for (let index = 0; index < identifiers.length; index += 1) {
    const identifier = identifiers[index];
    const symbol = resolved[index];
    if (identifier && symbol) symbols.set(identifier, symbol.id);
  }

  const bindings = new Map<number, ts.Expression | null>();
  for (const declaration of declarations) {
    const symbol = symbols.get(declaration.name as ts.Identifier);
    if (symbol === undefined) continue;
    bindings.set(symbol, bindings.has(symbol) ? null : declaration.initializer ?? null);
  }
  return {
    bindings,
    symbols,
    memo: new WeakMap<ts.Expression, string | null>(),
    resolving: new Set<number>(),
    operations: 0,
    exhausted: false,
  };
}

async function scanTypeScript(text: string, extension: string): Promise<boolean | undefined> {
  const virtualPath = join(tmpdir(), `membench-privacy-candidate${extension}`);
  const api = new API({
    cwd: process.cwd(),
    fs: createVirtualFileSystem({ [virtualPath]: text }),
  });
  try {
    const snapshot = await api.updateSnapshot({ openFiles: [virtualPath] });
    const project = await snapshot.getDefaultProjectForFile(virtualPath);
    if (!project) return undefined;
    const source = await project.program.getSourceFile(virtualPath);
    if (!source) return undefined;
    if ((await project.program.getSyntacticDiagnostics(virtualPath)).length > 0) return undefined;
    const staticState = await createStaticEvaluationState(source, project.checker);

    let found = false;
    const visit = (node: ts.Node): void => {
      if (found || staticState.exhausted) return;

      if (
        ts.isPropertySignatureDeclaration(node) ||
        ts.isMethodSignatureDeclaration(node)
      ) {
        node.forEachChild(visit);
        return;
      }
      if (
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node)) &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const name = propertyName(node.name, staticState);
        if (name && isPrivateKey(name)) {
          found = true;
          return;
        }
      }
      if (
        ts.isPropertyDeclaration(node) &&
        node.initializer &&
        isPrivateKey(propertyName(node.name, staticState) ?? "")
      ) {
        found = true;
        return;
      }
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && isPrivateKey(node.name.text)) {
        found = true;
        return;
      }
      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        const name = assignmentTargetName(node.left, staticState);
        if (name && isPrivateKey(name)) {
          found = true;
          return;
        }
      }
      if (ts.isCallExpression(node) && isPrivateMutationCall(node, staticState)) {
        found = true;
        return;
      }
      if (ts.isParameterDeclaration(node) && isPrivateConstructorParameter(node)) {
        found = true;
        return;
      }
      if (
        (ts.isStringLiteralLikeNode(node) ||
          ts.isTemplateExpression(node) ||
          (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) &&
        scanKeySyntax(staticString(node, staticState) ?? "")
      ) {
        found = true;
        return;
      }
      node.forEachChild(visit);
    };
    visit(source);
    return staticState.exhausted ? undefined : found;
  } finally {
    await api.close();
  }
}

function scanJson(text: string, schema: boolean): boolean | undefined {
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown;
    return schema
      ? scanSchema(parsed, {
          root: parsed,
          publicVisited: new WeakSet<object>(),
          privateVisited: new WeakSet<object>(),
          patternVisited: new WeakSet<object>(),
        })
      : scanInstance(parsed);
  } catch {
    return undefined;
  }
}

function scanJsonLines(text: string): boolean | undefined {
  for (const line of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const result = scanJson(line, false);
    if (result === undefined || result) return result;
  }
  return false;
}

async function scanContent(displayPath: string, text: string): Promise<boolean | undefined> {
  const lower = displayPath.toLocaleLowerCase("en-US");
  if (lower.endsWith(".schema.json") && lower.startsWith("schemas/")) {
    return scanJson(text, true);
  }
  if (lower.endsWith(".json")) return scanJson(text, false);
  if (lower.endsWith(".jsonl")) return scanJsonLines(text);
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    const extension = lower.endsWith(".tsx")
      ? ".tsx"
      : lower.endsWith(".mts")
        ? ".mts"
        : lower.endsWith(".cts")
          ? ".cts"
          : ".ts";
    return scanTypeScript(text, extension);
  }
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return scanTypeScript(text, lower.endsWith(".jsx") ? ".jsx" : ".js");
  }
  if (lower.endsWith(".toml")) return scanKeySyntax(text) || scanTomlTables(text);
  return scanKeySyntax(text);
}

async function main(): Promise<number> {
  const [mode, displayPath, contentPath] = Bun.argv.slice(2);
  if (!mode || displayPath === undefined) return EXIT_INVALID_STRUCTURED;
  if (unsafePath(displayPath)) return EXIT_UNSAFE_PATH;
  if (mode === "path") return 0;
  if (mode !== "content" || !contentPath) return EXIT_INVALID_STRUCTURED;

  const text = decodedText(await readFile(contentPath));
  if (text === undefined) return EXIT_NON_TEXT;
  const result = await scanContent(displayPath, text);
  if (result === undefined) return EXIT_INVALID_STRUCTURED;
  return result ? EXIT_PRIVATE_KEY : 0;
}

process.exit(await main().catch(() => EXIT_INVALID_STRUCTURED));
