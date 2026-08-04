import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registeredMkdtemp } from "./temp-registry";

const marker = Bun.argv[2];
if (!marker) process.exit(2);

const root = await registeredMkdtemp(join(tmpdir(), "membench-signal-certification-"));
await writeFile(marker, root);
await new Promise(() => undefined);
