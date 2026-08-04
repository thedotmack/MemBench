import { mkdtemp, rm, stat } from "node:fs/promises";
import { lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

const temporaryBase = resolve(tmpdir());
interface RootIdentity {
  readonly device: number;
  readonly inode: number;
}

const registeredRoots = new Map<string, RootIdentity>();

function safeRegisteredRoot(root: string): boolean {
  const resolved = resolve(root);
  return resolved !== temporaryBase &&
    dirname(resolved) === temporaryBase &&
    basename(resolved).startsWith("membench-");
}

function cleanupRegisteredTempRootsSync(): void {
  for (const [root, identity] of registeredRoots) {
    if (!safeRegisteredRoot(root)) continue;
    try {
      const current = lstatSync(root);
      if (current.isSymbolicLink() || current.dev !== identity.device || current.ino !== identity.inode) {
        continue;
      }
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort during process teardown; normal cleanup reports errors.
    }
  }
  registeredRoots.clear();
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.once(signal, () => {
    cleanupRegisteredTempRootsSync();
    process.kill(process.pid, signal);
  });
}
process.once("exit", cleanupRegisteredTempRootsSync);

export async function registeredMkdtemp(prefix: string): Promise<string> {
  const resolvedPrefix = resolve(prefix);
  if (
    dirname(resolvedPrefix) !== temporaryBase ||
    !basename(resolvedPrefix).startsWith("membench-")
  ) {
    throw new Error("unsafe temporary repository prefix");
  }
  const root = await mkdtemp(resolvedPrefix);
  const identity = await stat(root);
  registeredRoots.set(root, { device: identity.dev, inode: identity.ino });
  return root;
}

export async function cleanupRegisteredTempRoot(root: string): Promise<void> {
  const identity = registeredRoots.get(root);
  if (!identity || !safeRegisteredRoot(root)) {
    throw new Error("temporary repository was not registered");
  }
  try {
    const current = await stat(root);
    if (current.dev !== identity.device || current.ino !== identity.inode) {
      throw new Error("temporary repository identity changed");
    }
    await rm(root, { recursive: true, force: true });
  } finally {
    registeredRoots.delete(root);
  }
}
