import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { compareText, deepFreeze, hashJson } from "./canonical";
import { requireSafeIdentifier } from "./identifiers";
import { boundedInteger, boundedText, nonemptyText, RUNTIME_LIMITS, utf8Text } from "./runtime-validation";

export interface SandboxCapability {
  readonly supported: boolean;
  readonly verified: boolean;
  readonly live: boolean;
  readonly backend: string;
  readonly reason: string | null;
}

const issuedCapabilities = new WeakSet<object>();

function issueCapability(value: Omit<SandboxCapability, never>): SandboxCapability {
  const capability = deepFreeze({ ...value });
  issuedCapabilities.add(capability);
  return capability;
}

export interface SandboxCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface SandboxCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly processTreeCleaned: boolean;
}

export interface SandboxBackend {
  capability(): Promise<SandboxCapability> | SandboxCapability;
  execute(command: SandboxCommand): Promise<SandboxCommandResult>;
  cleanup(attemptId: string): Promise<{ readonly processTreeCleaned: boolean }>;
}

export class UnavailableLiveSandbox implements SandboxBackend {
  readonly #capability = issueCapability({
    supported: false,
    verified: false,
    live: true,
    backend: "unavailable",
    reason: "no verified live sandbox backend is configured",
  });

  capability(): SandboxCapability {
    return this.#capability;
  }

  async execute(_command: SandboxCommand): Promise<SandboxCommandResult> {
    throw new Error("live execution refused: no verified sandbox backend is configured");
  }

  async cleanup(_attemptId: string): Promise<{ readonly processTreeCleaned: boolean }> {
    return { processTreeCleaned: false };
  }
}

export async function requireLiveSandbox(backend: SandboxBackend): Promise<SandboxCapability> {
  const capability = await backend.capability();
  if (!issuedCapabilities.has(capability) || !capability.supported || !capability.verified || !capability.live) {
    throw new Error("live execution refused: backend is not a verified live sandbox");
  }
  return capability;
}

export interface TestSandboxHandler {
  (command: SandboxCommand, signal: AbortSignal): Promise<SandboxCommandResult>;
}

/** Offline tests only. This class never claims live or verified isolation. */
export interface DeterministicTestSandbox extends SandboxBackend {
  readonly commands: readonly SandboxCommand[];
  wasCleaned(attemptId: string): boolean;
}

const issuedTestSandboxes = new WeakSet<SandboxBackend>();

class IssuedDeterministicTestSandbox implements DeterministicTestSandbox {
  readonly #handler: TestSandboxHandler;
  readonly commands: SandboxCommand[] = [];
  #cleaned = new Set<string>();
  readonly #capability = issueCapability({ supported: true, verified: false, live: false, backend: "deterministic-test-only", reason: null });

  constructor(handler: TestSandboxHandler) {
    this.#handler = handler;
    issuedTestSandboxes.add(this);
  }

  capability(): SandboxCapability {
    return this.#capability;
  }

  async execute(command: SandboxCommand): Promise<SandboxCommandResult> {
    validateCommand(command);
    this.commands.push(deepFreeze({ ...command, argv: [...command.argv], env: { ...command.env } }));
    const controller = new AbortController();
    const timeoutMarker = Symbol("deterministic sandbox timeout");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<typeof timeoutMarker>((resolveTimeout) => {
      timeout = setTimeout(() => { controller.abort(); resolveTimeout(timeoutMarker); }, command.timeoutMs);
    });
    try {
      const result = await Promise.race([this.#handler(command, controller.signal), timed]);
      if (result === timeoutMarker) {
        return deepFreeze({ exitCode: null, stdout: "", stderr: "sandbox command timed out", timedOut: true, processTreeCleaned: false });
      }
      return validateTestCommandResult(result);
    } catch (error) {
      if (controller.signal.aborted) {
        return deepFreeze({ exitCode: null, stdout: "", stderr: "sandbox command timed out", timedOut: true, processTreeCleaned: false });
      }
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async cleanup(attemptId: string): Promise<{ readonly processTreeCleaned: boolean }> {
    this.#cleaned.add(requireSafeIdentifier(attemptId, "attempt id"));
    return { processTreeCleaned: true };
  }

  wasCleaned(attemptId: string): boolean {
    return this.#cleaned.has(attemptId);
  }
}

function validateTestCommandResult(value: unknown): SandboxCommandResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("sandbox command result must be an object");
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("sandbox command result must be an ordinary object");
  const source = value as Record<string, unknown>;
  const required = ["exitCode", "stdout", "stderr", "timedOut", "processTreeCleaned"];
  const allowed = new Set(required);
  if (Object.keys(source).length !== required.length || required.some((key) => !Object.hasOwn(source, key)) || Object.keys(source).some((key) => !allowed.has(key))) {
    throw new TypeError("sandbox command result has invalid fields");
  }
  if (typeof source.timedOut !== "boolean" || typeof source.processTreeCleaned !== "boolean") {
    throw new TypeError("sandbox command result flags are invalid");
  }
  const exitCode = source.exitCode;
  if (source.timedOut ? exitCode !== null : !Number.isSafeInteger(exitCode) || (exitCode as number) < 0 || (exitCode as number) > 255) {
    throw new TypeError("sandbox command result exit code is invalid");
  }
  const stdout = utf8Text(source.stdout, "sandbox stdout", RUNTIME_LIMITS.maximumResponseBytes);
  const stderr = utf8Text(source.stderr, "sandbox stderr", RUNTIME_LIMITS.maximumResponseBytes);
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > RUNTIME_LIMITS.maximumResponseBytes) {
    throw new RangeError("sandbox command output exceeds aggregate byte limit");
  }
  return deepFreeze({
    exitCode: exitCode as number | null,
    stdout,
    stderr,
    timedOut: source.timedOut,
    processTreeCleaned: source.processTreeCleaned,
  });
}

export function createDeterministicTestSandbox(handler: TestSandboxHandler): DeterministicTestSandbox {
  if (typeof handler !== "function") throw new TypeError("test sandbox handler must be a function");
  return new IssuedDeterministicTestSandbox(handler);
}

export async function requireExecutionSandbox(backend: SandboxBackend): Promise<SandboxCapability> {
  if (issuedTestSandboxes.has(backend)) return backend.capability();
  return requireLiveSandbox(backend);
}

function validateCommand(command: SandboxCommand): void {
  if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.length > RUNTIME_LIMITS.maximumCommandArguments) {
    throw new TypeError("sandbox command requires a bounded argv list");
  }
  command.argv.forEach((argument, index) => boundedText(argument, `argv[${index}]`, 10_000));
  if (!isAbsolute(command.cwd)) throw new TypeError("sandbox cwd must be absolute");
  boundedInteger(command.timeoutMs, "sandbox timeout", RUNTIME_LIMITS.maximumCommandDurationMs);
  if (command.timeoutMs === 0) throw new TypeError("sandbox timeout must be positive");
  for (const [key, value] of Object.entries(command.env)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(key)) throw new TypeError("sandbox environment key is invalid");
    boundedText(value, `environment ${key}`, 10_000);
  }
}

export function requireSafeWorkspacePath(path: unknown): string {
  const value = nonemptyText(path, "workspace path", 1_000);
  const parts = value.split("/");
  if (
    isAbsolute(value) || value.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    value !== posix.normalize(value) || parts.some((part) =>
      part === "" || part === "." || part === ".." ||
      part.startsWith(" ") || part.endsWith(" ") || part.endsWith(".") ||
      /[<>:"|?*]/u.test(part) ||
      /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    )
  ) throw new TypeError("workspace path must be normalized and relative");
  return value;
}

function workspacePathIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\u00df/gu, "ss").replace(/\u03c2/gu, "\u03c3");
}

function within(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function verifyNoSymlinkRoot(root: string, relativePath: string, allowMissingLeaf: boolean): string {
  const normalized = requireSafeWorkspacePath(relativePath);
  const rootReal = realpathSync(root);
  let current = rootReal;
  const parts = normalized.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index] as string);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("workspace symlinks are forbidden");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
      if (code === "ENOENT" && (allowMissingLeaf || index < parts.length - 1)) continue;
      throw error;
    }
  }
  const resolved = resolve(rootReal, normalized);
  if (!within(rootReal, resolved)) throw new Error("workspace path escapes the attempt root");
  return resolved;
}

export interface AttemptWorkspace {
  readonly attemptId: string;
  readonly root: string;
  readonly work: string;
  readonly data: string;
  readonly home: string;
  readonly port: number;
  readonly startingHash: `sha256:${string}`;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly real: string;
  readonly device: number;
  readonly inode: number;
}

interface WorkspaceState {
  readonly runRoot: DirectoryIdentity;
  readonly root: DirectoryIdentity;
  readonly work: DirectoryIdentity;
  readonly data: DirectoryIdentity;
  readonly home: DirectoryIdentity;
  readonly baseline: Readonly<Record<string, string>>;
  readonly reservation: string;
}

const issuedWorkspaces = new WeakMap<AttemptWorkspace, WorkspaceState>();

function directoryIdentity(path: string, label: string): DirectoryIdentity {
  const link = lstatSync(path);
  if (link.isSymbolicLink() || !link.isDirectory()) throw new Error(`${label} must remain a non-symlink directory`);
  const stat = statSync(path);
  return { path, real: realpathSync(path), device: stat.dev, inode: stat.ino };
}

function sameDirectory(expected: DirectoryIdentity, label: string): void {
  const actual = directoryIdentity(expected.path, label);
  if (actual.real !== expected.real || actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error(`${label} identity changed after workspace creation`);
  }
}

function requireWorkspace(workspace: AttemptWorkspace): WorkspaceState {
  const state = issuedWorkspaces.get(workspace);
  if (!state) throw new TypeError("attempt workspace must be factory-issued");
  sameDirectory(state.runRoot, "operator run root");
  sameDirectory(state.root, "attempt root");
  sameDirectory(state.work, "attempt work directory");
  sameDirectory(state.data, "attempt data directory");
  sameDirectory(state.home, "attempt home directory");
  if (
    !within(state.runRoot.real, state.root.real) || state.root.real === state.runRoot.real ||
    !within(state.root.real, state.work.real) || !within(state.root.real, state.data.real) || !within(state.root.real, state.home.real)
  ) throw new Error("attempt workspace escaped its issued root");
  return state;
}

function verifyWorkspacePath(workspace: AttemptWorkspace, relativePath: string, allowMissingLeaf: boolean): string {
  const state = requireWorkspace(workspace);
  return verifyNoSymlinkRoot(state.work.real, relativePath, allowMissingLeaf);
}

export function createAttemptWorkspace(input: {
  readonly runRoot: string;
  readonly attemptId: string;
  readonly startingTree: Readonly<Record<string, string>>;
  readonly port: number;
}): AttemptWorkspace {
  if (!isAbsolute(input.runRoot) || !statSync(input.runRoot).isDirectory() || lstatSync(input.runRoot).isSymbolicLink()) {
    throw new TypeError("operator run root must be an existing absolute non-symlink directory");
  }
  const runRoot = realpathSync(input.runRoot);
  if (Object.keys(input.startingTree).length > RUNTIME_LIMITS.maximumFilesPerAttempt) throw new RangeError("starting tree has too many files");
  boundedInteger(input.port, "attempt port", 65_535);
  if (input.port < 1_024) throw new TypeError("attempt port must be unprivileged");
  const attemptId = requireSafeIdentifier(input.attemptId, "attempt id");
  const root = join(runRoot, attemptId);
  if (exists(root)) throw new Error("attempt workspace already exists");
  const reservation = join(runRoot, `.membench-port-${input.port}`);
  try {
    writeFileSync(reservation, attemptId, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    throw new Error("attempt port is already reserved in this run root");
  }
  let totalBytes = 0;
  const identities = new Set<string>();
  try {
    mkdirSync(join(root, "work"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "data"), { mode: 0o700 });
    mkdirSync(join(root, "home"), { mode: 0o700 });
    for (const [path, content] of Object.entries(input.startingTree).sort(([a], [b]) => compareText(a, b))) {
      requireSafeWorkspacePath(path);
      const identity = workspacePathIdentity(path);
      if (identities.has(identity)) throw new Error("starting paths collide under cross-platform normalization");
      identities.add(identity);
      utf8Text(content, `starting file ${path}`, RUNTIME_LIMITS.maximumFileBytes);
      totalBytes += Buffer.byteLength(content);
      if (totalBytes > RUNTIME_LIMITS.maximumResponseBytes) throw new RangeError("starting tree exceeds runtime byte limit");
      const destination = verifyNoSymlinkRoot(join(root, "work"), path, true);
      mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
      verifyNoSymlinkRoot(join(root, "work"), path, true);
      writeFileSync(destination, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    rmSync(reservation, { force: true });
    throw error;
  }
  const baseline = deepFreeze({ ...input.startingTree });
  const workspace = deepFreeze({ attemptId, root, work: join(root, "work"), data: join(root, "data"), home: join(root, "home"), port: input.port, startingHash: hashJson(baseline) });
  issuedWorkspaces.set(workspace, {
    runRoot: directoryIdentity(runRoot, "operator run root"),
    root: directoryIdentity(root, "attempt root"),
    work: directoryIdentity(workspace.work, "attempt work directory"),
    data: directoryIdentity(workspace.data, "attempt data directory"),
    home: directoryIdentity(workspace.home, "attempt home directory"),
    baseline,
    reservation,
  });
  return workspace;
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

export function readWorkspaceFile(workspace: AttemptWorkspace, path: string): string {
  const absolute = verifyWorkspacePath(workspace, path, false);
  const stat = statSync(absolute);
  if (!stat.isFile() || stat.size > RUNTIME_LIMITS.maximumFileBytes) throw new Error("workspace file is unavailable or too large");
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) throw new Error("workspace file contains NUL bytes");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("workspace file is not valid UTF-8");
  }
}

export function writeWorkspaceFile(workspace: AttemptWorkspace, path: string, content: string): void {
  utf8Text(content, "workspace file content", RUNTIME_LIMITS.maximumFileBytes);
  requireWorkspace(workspace);
  requireSafeWorkspacePath(path);
  const current = tree(workspace);
  const identity = workspacePathIdentity(path);
  if (Object.keys(current).some((entryPath) => entryPath !== path && workspacePathIdentity(entryPath) === identity)) {
    throw new Error("workspace path collides under cross-platform normalization");
  }
  if (!Object.hasOwn(current, path) && Object.keys(current).length >= RUNTIME_LIMITS.maximumFilesPerAttempt) {
    throw new RangeError("workspace has too many files");
  }
  const nextBytes = Object.entries(current).reduce((sum, [entryPath, value]) =>
    sum + Buffer.byteLength(entryPath === path ? content : value), 0) +
    (Object.hasOwn(current, path) ? 0 : Buffer.byteLength(content));
  if (nextBytes > RUNTIME_LIMITS.maximumResponseBytes) throw new RangeError("workspace exceeds aggregate byte limit");
  const absolute = verifyWorkspacePath(workspace, path, true);
  mkdirSync(resolve(absolute, ".."), { recursive: true, mode: 0o700 });
  verifyWorkspacePath(workspace, path, true);
  writeFileSync(absolute, content, { encoding: "utf8", flag: "w", mode: 0o600 });
}

function tree(workspace: AttemptWorkspace): Record<string, string> {
  const state = requireWorkspace(workspace);
  const root = state.work.real;
  const result: Record<string, string> = {};
  let totalBytes = 0;
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("workspace symlinks are forbidden");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const path = relative(root, absolute).split(sep).join("/");
        requireSafeWorkspacePath(path);
        const identity = workspacePathIdentity(path);
        if (Object.keys(result).some((existing) => workspacePathIdentity(existing) === identity)) {
          throw new Error("workspace paths collide under cross-platform normalization");
        }
        const content = readWorkspaceFile(workspace, path);
        totalBytes += Buffer.byteLength(content);
        if (totalBytes > RUNTIME_LIMITS.maximumResponseBytes) throw new RangeError("workspace exceeds aggregate byte limit");
        result[path] = content;
      } else throw new Error("workspace special files are forbidden");
      if (Object.keys(result).length > RUNTIME_LIMITS.maximumFilesPerAttempt) throw new RangeError("workspace has too many files");
    }
  };
  visit(root);
  return result;
}

export interface WorkspaceDiff {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly contentHash: `sha256:${string}`;
}

export function captureWorkspaceDiff(workspace: AttemptWorkspace): WorkspaceDiff {
  const state = requireWorkspace(workspace);
  const startingTree = state.baseline;
  const current = tree(workspace);
  const beforePaths = Object.keys(startingTree).sort(compareText);
  const afterPaths = Object.keys(current).sort(compareText);
  const added = afterPaths.filter((path) => !Object.hasOwn(startingTree, path));
  const deleted = beforePaths.filter((path) => !Object.hasOwn(current, path));
  const modified = afterPaths.filter((path) => Object.hasOwn(startingTree, path) && current[path] !== startingTree[path]);
  return deepFreeze({ added, modified, deleted, contentHash: hashJson({ added, modified, deleted, current }) });
}

export function listWorkspaceFiles(workspace: AttemptWorkspace): readonly string[] {
  return deepFreeze(Object.keys(tree(workspace)).sort(compareText));
}

export function removeAttemptWorkspace(workspace: AttemptWorkspace, operatorRunRoot: string): void {
  const state = requireWorkspace(workspace);
  requireSafeIdentifier(workspace.attemptId, "attempt id");
  boundedInteger(workspace.port, "attempt port", 65_535);
  if (workspace.port < 1_024) throw new TypeError("attempt port must be unprivileged");
  const runRoot = realpathSync(operatorRunRoot);
  const root = realpathSync(workspace.root);
  if (runRoot !== state.runRoot.real) throw new Error("operator run root differs from issued workspace root");
  if (!within(runRoot, root) || root === runRoot || resolve(runRoot, workspace.attemptId) !== root) {
    throw new Error("refusing to remove a workspace outside the operator run root");
  }
  rmSync(root, { recursive: true, force: false });
  rmSync(state.reservation, { force: true });
  issuedWorkspaces.delete(workspace);
}
