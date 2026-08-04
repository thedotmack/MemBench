import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Item = {
  id: string;
  project: string;
  window: string;
  phrase: string;
  distractor: string;
};

type Usage = { promptTokens: number; completionTokens: number; costUsd: number | null };
type CallResult = { text: string; provider: string | null; usage: Usage; generationId: string | null };
type Attempt = {
  itemId: string;
  arm: "candidate" | "none" | "shuffled" | "reference";
  repetition: number;
  response: string;
  success: boolean;
  provider: string | null;
  usage: Usage;
  generationId: string | null;
};

const items: readonly Item[] = [
  { id: "i01", project: "Alder", window: "03:17 UTC", phrase: "silver comet", distractor: "Pager owner is Mira." },
  { id: "i02", project: "Birch", window: "21:43 UTC", phrase: "violet harbor", distractor: "Build channel is canary-7." },
  { id: "i03", project: "Cedar", window: "05:26 UTC", phrase: "amber lattice", distractor: "Incident lead is Tomas." },
  { id: "i04", project: "Dogwood", window: "18:09 UTC", phrase: "quiet anvil", distractor: "Region is north-3." },
  { id: "i05", project: "Elm", window: "00:52 UTC", phrase: "cobalt meadow", distractor: "Owner is Priya." },
  { id: "i06", project: "Fir", window: "14:38 UTC", phrase: "paper lantern", distractor: "Queue name is kestrel." },
  { id: "i07", project: "Ginkgo", window: "07:11 UTC", phrase: "crimson tidepool", distractor: "Region is west-8." },
  { id: "i08", project: "Hazel", window: "23:04 UTC", phrase: "marble orchard", distractor: "Owner is Jun." },
  { id: "i09", project: "Iris", window: "11:29 UTC", phrase: "winter compass", distractor: "Build channel is stable-4." },
  { id: "i10", project: "Juniper", window: "16:46 UTC", phrase: "golden rivet", distractor: "Pager owner is Salma." },
  { id: "i11", project: "Kestrel", window: "02:35 UTC", phrase: "indigo bridge", distractor: "Region is south-6." },
  { id: "i12", project: "Linden", window: "19:58 UTC", phrase: "porcelain storm", distractor: "Incident lead is Oren." },
];

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

const model = process.argv.find((value) => value.startsWith("--model="))?.slice(8) ?? "openai/gpt-4.1-mini";
const repetitions = Number(process.argv.find((value) => value.startsWith("--repetitions="))?.slice(14) ?? "3");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error("invalid repetitions");
const startedAt = new Date().toISOString();

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function callModel(system: string, user: string, seed: number): Promise<CallResult> {
  let lastError: unknown;
  for (let retry = 0; retry < 5; retry += 1) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/thedotmack/MemBench",
        "X-Title": "MemBench live pilot",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.2,
        seed,
        max_tokens: 180,
      }),
    });
    if (response.ok) {
      const body = await response.json() as any;
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("OpenRouter response omitted message content");
      const usage = body?.usage ?? {};
      return {
        text: content,
        provider: typeof body?.provider === "string" ? body.provider : null,
        generationId: typeof body?.id === "string" ? body.id : null,
        usage: {
          promptTokens: Number.isSafeInteger(usage.prompt_tokens) ? usage.prompt_tokens : 0,
          completionTokens: Number.isSafeInteger(usage.completion_tokens) ? usage.completion_tokens : 0,
          costUsd: typeof usage.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : null,
        },
      };
    }
    const message = await response.text();
    lastError = new Error(`OpenRouter ${response.status}: ${message.slice(0, 300)}`);
    if (response.status !== 429 && response.status < 500) break;
    await sleep(500 * (2 ** retry));
  }
  throw lastError;
}

function events(item: Item): string {
  return [
    `[09:00] Project ${item.project} entered release preparation.`,
    `[09:12] ${item.distractor}`,
    `[09:27] The approved deployment window for Project ${item.project} is ${item.window}.`,
    `[09:41] The exact rollback phrase for Project ${item.project} is \"${item.phrase}\".`,
    `[09:55] Keep these release details available for later work.`,
  ].join("\n");
}

function referenceMemory(item: Item): string {
  return `Project ${item.project}: deployment window ${item.window}; exact rollback phrase \"${item.phrase}\".`;
}

function successful(text: string, item: Item): boolean {
  const normalized = text.toLocaleLowerCase();
  return normalized.includes(item.window.toLocaleLowerCase()) && normalized.includes(item.phrase.toLocaleLowerCase());
}

function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 2 ** 32);
}

function bootstrap(values: readonly number[], seed: number, draws = 10000): { mean: number; low: number; high: number } {
  const random = lcg(seed);
  const estimates: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(random() * values.length)]!;
    estimates.push(sum / values.length);
  }
  estimates.sort((a, b) => a - b);
  return { mean: mean(values), low: estimates[Math.floor(draws * 0.025)]!, high: estimates[Math.floor(draws * 0.975)]! };
}

async function mapLimit<T, U>(input: readonly T[], limit: number, fn: (value: T, index: number) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(input.length);
  let cursor = 0;
  async function worker() {
    while (cursor < input.length) {
      const index = cursor++;
      output[index] = await fn(input[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, input.length) }, worker));
  return output;
}

const observerSystem = "You are a background memory observer. Read the event stream without knowing the later task. Preserve durable, exact project facts that could matter later. Return only JSON with one string field named memory.";
const observerCalls = await mapLimit(items, 4, async (item, index) => {
  const result = await callModel(observerSystem, events(item), 1000 + index);
  let memory = result.text;
  try {
    const parsed = JSON.parse(result.text.replace(/^```json\s*|\s*```$/g, ""));
    if (typeof parsed?.memory === "string") memory = parsed.memory;
  } catch {}
  return { itemId: item.id, memory, extractionSuccess: successful(memory, item), ...result };
});

const memories = new Map(observerCalls.map((row) => [row.itemId, row.memory]));
const arms = ["candidate", "none", "shuffled", "reference"] as const;
const schedule = items.flatMap((item, itemIndex) => arms.flatMap((arm) =>
  Array.from({ length: repetitions }, (_, repetition) => ({ item, itemIndex, arm, repetition }))));
const random = lcg(424242);
for (let index = schedule.length - 1; index > 0; index -= 1) {
  const swap = Math.floor(random() * (index + 1));
  [schedule[index], schedule[swap]] = [schedule[swap]!, schedule[index]!];
}

const answerSystem = "Answer the task using the supplied memory when it contains the needed facts. If the memory does not contain the answer, output UNKNOWN. Return only: <deployment window> | <rollback phrase>. Do not explain.";
const attempts = await mapLimit(schedule, 4, async ({ item, itemIndex, arm, repetition }, index): Promise<Attempt> => {
  const donor = items[(itemIndex + 5) % items.length]!;
  const memory = arm === "candidate" ? memories.get(item.id)! : arm === "none" ? "(no memory supplied)" : arm === "shuffled" ? memories.get(donor.id)! : referenceMemory(item);
  const user = `TASK: For Project ${item.project}, what are the approved deployment window and exact rollback phrase?\n\nMEMORY (${arm}):\n${memory}`;
  const result = await callModel(answerSystem, user, 10000 + index);
  return { itemId: item.id, arm, repetition, response: result.text, success: successful(result.text, item), provider: result.provider, usage: result.usage, generationId: result.generationId };
});

const armRates = Object.fromEntries(arms.map((arm) => {
  const rows = attempts.filter((row) => row.arm === arm);
  return [arm, { successes: rows.filter((row) => row.success).length, attempts: rows.length, rate: mean(rows.map((row) => Number(row.success))) }];
}));
const itemRates = new Map(items.flatMap((item) => arms.map((arm) => {
  const rows = attempts.filter((row) => row.itemId === item.id && row.arm === arm);
  return [`${item.id}:${arm}`, mean(rows.map((row) => Number(row.success)))] as const;
})));
const candidateMinusNone = items.map((item) => itemRates.get(`${item.id}:candidate`)! - itemRates.get(`${item.id}:none`)!);
const candidateMinusShuffled = items.map((item) => itemRates.get(`${item.id}:candidate`)! - itemRates.get(`${item.id}:shuffled`)!);
const referenceMinusCandidate = items.map((item) => itemRates.get(`${item.id}:reference`)! - itemRates.get(`${item.id}:candidate`)!);
const effects = {
  candidateMinusNone: bootstrap(candidateMinusNone, 7001),
  candidateMinusShuffled: bootstrap(candidateMinusShuffled, 7002),
  referenceMinusCandidate: bootstrap(referenceMinusCandidate, 7003),
};
const observerExtractionRate = mean(observerCalls.map((row) => Number(row.extractionSuccess)));
const attributedItemRate = mean(items.map((item) => Number(itemRates.get(`${item.id}:candidate`)! > itemRates.get(`${item.id}:none`)!)));
const driftAvoidanceRate = mean(items.map((item) => Number(itemRates.get(`${item.id}:shuffled`)! <= itemRates.get(`${item.id}:none`)!)));
const allUsage = [...observerCalls.map((row) => row.usage), ...attempts.map((row) => row.usage)];
const knownCost = allUsage.every((row) => row.costUsd !== null);
const totalCostUsd = knownCost ? allUsage.reduce((sum, row) => sum + row.costUsd!, 0) : null;
const recommendation = effects.candidateMinusNone.low > 0 && effects.candidateMinusShuffled.low > 0 && observerExtractionRate >= 0.8 && effects.referenceMinusCandidate.high <= 0.2;
const result = {
  schemaVersion: 1,
  kind: "live_openrouter_pilot",
  hypothesis: "Background-observer memory improves exact task completion versus no memory and shuffled memory, while approaching a hand-authored reference-memory ceiling.",
  limitations: ["Synthetic factual-recall tasks; this pilot does not establish coding-agent or long-horizon performance.", "One candidate/observer model and one prompt family."],
  model,
  startedAt,
  completedAt: new Date().toISOString(),
  items: items.length,
  repetitions,
  liveCalls: observerCalls.length + attempts.length,
  observerExtractionRate,
  armRates,
  effects,
  attributedItemRate,
  driftAvoidanceRate,
  recommendation,
  totalCostUsd,
  providers: [...new Set([...observerCalls.map((row) => row.provider), ...attempts.map((row) => row.provider)].filter(Boolean))],
  observerCalls,
  attempts,
};
const stamp = result.completedAt.replace(/[:.]/g, "-");
const outputDir = join(process.cwd(), "artifacts", `live-pilot-${stamp}`);
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "results.json"), `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
const md = [
  "# MemBench live pilot", "", `- Model: \`${model}\``, `- Live OpenRouter calls: ${result.liveCalls}`, `- Items × repetitions: ${items.length} × ${repetitions}`, `- Observer extraction: ${(observerExtractionRate * 100).toFixed(1)}%`,
  ...arms.map((arm) => `- ${arm}: ${armRates[arm].successes}/${armRates[arm].attempts} (${(armRates[arm].rate * 100).toFixed(1)}%)`),
  `- Candidate − none: ${(effects.candidateMinusNone.mean * 100).toFixed(1)} pp (95% item bootstrap ${(effects.candidateMinusNone.low * 100).toFixed(1)} to ${(effects.candidateMinusNone.high * 100).toFixed(1)})`,
  `- Candidate − shuffled: ${(effects.candidateMinusShuffled.mean * 100).toFixed(1)} pp (95% item bootstrap ${(effects.candidateMinusShuffled.low * 100).toFixed(1)} to ${(effects.candidateMinusShuffled.high * 100).toFixed(1)})`,
  `- Reference − candidate: ${(effects.referenceMinusCandidate.mean * 100).toFixed(1)} pp (95% item bootstrap ${(effects.referenceMinusCandidate.low * 100).toFixed(1)} to ${(effects.referenceMinusCandidate.high * 100).toFixed(1)})`,
  `- Attributed item rate: ${(attributedItemRate * 100).toFixed(1)}%`, `- Drift avoidance rate: ${(driftAvoidanceRate * 100).toFixed(1)}%`, `- Measured cost: ${totalCostUsd === null ? "unavailable" : `$${totalCostUsd.toFixed(6)}`}`, `- Pilot conclusion: **${recommendation ? "supports the hypothesis" : "does not yet support the hypothesis"}**`, "",
  "This is an actual live-model pilot on synthetic factual-recall tasks, not a software test. It does not establish coding-agent or long-horizon performance.", "",
].join("\n");
await writeFile(join(outputDir, "RESULTS.md"), md, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({ outputDir, model, liveCalls: result.liveCalls, observerExtractionRate, armRates, effects, attributedItemRate, driftAvoidanceRate, recommendation, totalCostUsd, providers: result.providers }, null, 2));
