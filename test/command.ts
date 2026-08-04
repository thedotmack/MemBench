const COMMAND_TIMEOUT_MS = 20_000;
const TERMINATION_GRACE_MS = 100;

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly startedAt: string;
}

function validTarget(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;
}

export function parseProcessTable(output: string): readonly ProcessEntry[] {
  return output
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/u))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      startedAt: match[3]?.replace(/\s+/gu, " ") ?? "",
    }))
    .filter((entry) => validTarget(entry.pid) && entry.parentPid >= 0 && entry.startedAt.length > 0);
}

async function processTable(): Promise<readonly ProcessEntry[]> {
  const process = Bun.spawn(["ps", "-axo", "pid=,ppid=,lstart="], {
    env: { ...Bun.env, LC_ALL: "C" },
    stderr: "ignore",
    stdout: "pipe",
  });
  const output = new Response(process.stdout).text();
  const status = await process.exited;
  if (status !== 0) throw new Error("unable to inspect test process tree");

  return parseProcessTable(await output);
}

export function descendants(
  rootPid: number,
  table: readonly ProcessEntry[],
): readonly ProcessEntry[] {
  const parents = new Map(table.map((entry) => [entry.pid, entry.parentPid]));
  const depthFromRoot = (entry: ProcessEntry): number | undefined => {
    let depth = 0;
    let current = entry.pid;
    const visited = new Set<number>();
    while (parents.has(current) && !visited.has(current)) {
      if (current === rootPid) return depth;
      visited.add(current);
      current = parents.get(current) ?? 0;
      depth += 1;
    }
    return current === rootPid ? depth : undefined;
  };

  return table
    .map((entry) => ({ entry, depth: depthFromRoot(entry) }))
    .filter(
      (candidate): candidate is { readonly entry: ProcessEntry; readonly depth: number } =>
        candidate.depth !== undefined && candidate.depth > 0,
    )
    .sort((left, right) => right.depth - left.depth)
    .map((candidate) => candidate.entry);
}

export function sameProcessIdentity(left: ProcessEntry, right: ProcessEntry): boolean {
  return left.pid === right.pid &&
    left.parentPid === right.parentPid &&
    left.startedAt === right.startedAt;
}

export function signalTargetIsCurrent(
  expected: ProcessEntry,
  expectedRoot: ProcessEntry,
  currentTable: readonly ProcessEntry[],
  requireDescendant: boolean,
): boolean {
  if (!validTarget(expected.pid) || !validTarget(expectedRoot.pid)) return false;
  const currentRoot = currentTable.find((entry) => entry.pid === expectedRoot.pid);
  const currentTarget = currentTable.find((entry) => entry.pid === expected.pid);
  if (
    !currentRoot ||
    !currentTarget ||
    !sameProcessIdentity(expectedRoot, currentRoot) ||
    !sameProcessIdentity(expected, currentTarget)
  ) {
    return false;
  }
  if (!requireDescendant) return expected.pid === expectedRoot.pid;
  return descendants(expectedRoot.pid, currentTable).some((entry) =>
    sameProcessIdentity(entry, currentTarget)
  );
}

async function signalIfCurrent(
  expected: ProcessEntry,
  expectedRoot: ProcessEntry,
  name: NodeJS.Signals,
  requireDescendant: boolean,
): Promise<boolean> {
  const currentTable = await processTable();
  if (!signalTargetIsCurrent(expected, expectedRoot, currentTable, requireDescendant)) return false;
  try {
    process.kill(expected.pid, name);
    return true;
  } catch {
    // The validated process may have exited between inspection and signaling.
    return false;
  }
}

async function terminateTree(parentPid: number, exited: Promise<number>): Promise<void> {
  if (!validTarget(parentPid)) throw new Error("invalid test process identifier");

  const initialTable = await processTable();
  const root = initialTable.find((entry) => entry.pid === parentPid);
  if (!root) {
    await exited;
    return;
  }

  await signalIfCurrent(root, root, "SIGSTOP", false);
  for (const entry of descendants(parentPid, initialTable)) {
    await signalIfCurrent(entry, root, "SIGTERM", true);
  }
  await Bun.sleep(TERMINATION_GRACE_MS);

  for (let pass = 0; pass < 3; pass += 1) {
    const table = await processTable();
    const remaining = descendants(parentPid, table);
    if (remaining.length === 0) break;
    for (const entry of remaining) {
      await signalIfCurrent(entry, root, "SIGKILL", true);
    }
    await Bun.sleep(10);
  }

  await signalIfCurrent(root, root, "SIGTERM", false);
  await signalIfCurrent(root, root, "SIGCONT", false);
  const graceful = await Promise.race([
    exited.then(() => true),
    Bun.sleep(TERMINATION_GRACE_MS).then(() => false),
  ]);
  if (!graceful) await signalIfCurrent(root, root, "SIGKILL", false);
  await exited;
}

export async function command(
  root: string,
  executable: string,
  args: readonly string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...args], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((status) => ({ status, timedOut: false as const })),
    new Promise<{ readonly timedOut: true }>((resolve) => {
      timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    }),
  ]);

  if (outcome.timedOut) {
    await terminateTree(child.pid, child.exited);
    await Promise.all([stdout, stderr]);
    throw new Error("test command failed to complete within its safety boundary");
  }
  if (timeout !== undefined) clearTimeout(timeout);
  return { status: outcome.status, stdout: await stdout, stderr: await stderr };
}
