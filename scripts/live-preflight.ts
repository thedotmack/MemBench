import { UnavailableLiveSandbox, requireLiveSandbox } from "../src/sandbox";

const requested = process.env.MEMBENCH_LIVE_REQUESTED === "true";
const operatorConfirmed = process.env.MEMBENCH_OPERATOR_CONFIRMED === "true";

if (!requested) {
  process.stdout.write("MemBench live evaluation: dry preflight only; no provider call or shell execution.\n");
  process.exit(0);
}

if (!operatorConfirmed) {
  process.stderr.write("MemBench live evaluation refused: operator confirmation is absent.\n");
  process.exit(2);
}

if (!process.env.OPENROUTER_API_KEY) {
  process.stderr.write("MemBench live evaluation refused: operator environment credential is absent.\n");
  process.exit(2);
}

try {
  await requireLiveSandbox(new UnavailableLiveSandbox());
  process.stderr.write("MemBench live evaluation refused: no live runner is implemented.\n");
  process.exit(2);
} catch {
  process.stderr.write("MemBench live evaluation refused: no verified live sandbox backend is configured.\n");
  process.exit(2);
}
