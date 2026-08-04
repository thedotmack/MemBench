import { expect, test } from "bun:test";
import { join } from "node:path";

import { command, parseProcessTable, signalTargetIsCurrent } from "./command";

const projectRoot = join(import.meta.dir, "..");

test("timed-out commands fail and leave no descendant process", async () => {
  await expect(command(projectRoot, "bash", ["-c", "sleep 17 & wait"], 100)).rejects.toThrow(
    "test command failed to complete within its safety boundary",
  );
  const processes = await command(projectRoot, "ps", ["-axo", "command="]);
  expect(processes.status).toBe(0);
  expect(processes.stdout.split("\n").some((line) => line.trim() === "sleep 17")).toBe(false);
});

test("process identity and ancestry validation rejects PID reuse", () => {
  const original = parseProcessTable([
    "90001 42 Mon Aug  3 20:00:00 2026",
    "90002 90001 Mon Aug  3 20:00:01 2026",
  ].join("\n"));
  const root = original[0];
  const child = original[1];
  expect(root).toBeDefined();
  expect(child).toBeDefined();
  if (!root || !child) return;

  expect(signalTargetIsCurrent(child, root, original, true)).toBe(true);
  const reused = parseProcessTable([
    "90001 42 Mon Aug  3 20:00:00 2026",
    "90002 90001 Mon Aug  3 20:00:02 2026",
  ].join("\n"));
  expect(signalTargetIsCurrent(child, root, reused, true)).toBe(false);

  const reparented = [{ ...child, parentPid: 1 }, root];
  expect(signalTargetIsCurrent(child, root, reparented, true)).toBe(false);
});
