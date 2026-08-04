import { expect, test } from "bun:test";
import { access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { cleanupRegisteredTempRoot, registeredMkdtemp } from "./temp-registry";

const fixture = join(import.meta.dir, "temp-registry-fixture.ts");

test("SIGTERM removes only the child process's registered fixture root", async () => {
  const controlRoot = await registeredMkdtemp(join(tmpdir(), "membench-signal-control-"));
  const marker = join(controlRoot, "child-root.txt");
  const child = Bun.spawn(["bun", fixture, marker], { stderr: "ignore", stdout: "ignore" });
  let childRoot: string | undefined;
  try {
    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline) {
      try {
        childRoot = (await readFile(marker, "utf8")).trim();
        break;
      } catch {
        await Bun.sleep(10);
      }
    }
    expect(childRoot).toBeDefined();
    expect(childRoot && basename(childRoot).startsWith("membench-signal-certification-")).toBe(true);
    child.kill("SIGTERM");
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    expect(exited).toBe(true);
    if (childRoot) await expect(access(childRoot)).rejects.toThrow();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (childRoot && basename(childRoot).startsWith("membench-signal-certification-")) {
      await rm(childRoot, { recursive: true, force: true });
    }
    await cleanupRegisteredTempRoot(controlRoot);
  }
});
