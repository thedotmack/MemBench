/**
 * Stage 4 — measurement (plan Phase 6.3).
 *
 * Two independent signals per fork-run:
 *
 *   success    — the item's `check.sh` run INSIDE the fork's repo checkout.
 *                Exit contract (types.ts): CHECK_EXIT_PASS(0) → true,
 *                CHECK_EXIT_JUDGE(3) → the judge decides against the
 *                `success.md` rubric, anything else → false.
 *   drift      — a judge call (spec.judge_model, cheap) comparing the run's
 *                saved `git diff` against `task.md` scope, returning
 *                {drift: bool, note: string}. When the check deferred, the
 *                SAME call also returns {success: bool} against the rubric —
 *                one model call per run, not two.
 *
 * Hidden-field discipline (SWB run-batch.py:43-50,494-497): the judge sees
 * task.md, the diff, the executor's output, and — only when the check
 * deferred — success.md. It NEVER sees oracle.md (the ceiling control's
 * notes) or check.sh's source. Nothing from this module ever reaches an
 * executor prompt.
 *
 * Cost discipline (guard 1): judge spend is REAL reported usage or null, and
 * it is deliberately NOT folded into the row's `cost_usd` (which is
 * executor-side spend). It is returned separately so run-stage can log it to
 * judge.jsonl and cost governance can count it against the ceiling.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildExecEnv, capText, runWithTimeout } from './executors/shared.js';
import type { QueryModelFn } from './observe-runner.js';
import { queryModel } from './openrouter.js';
import { CHECK_EXIT_JUDGE, CHECK_EXIT_PASS, type CorpusItem } from './types.js';

/** How much of the diff/output the judge is shown (chars). */
export const JUDGE_DIFF_CAP = 40_000;
export const JUDGE_OUTPUT_CAP = 8_000;

/** Stable marker at the top of every judge prompt (mock transports key on it). */
export const JUDGE_PROMPT_MARKER = 'MemBench drift judge';

export interface CheckResult {
  /** null when the check timed out or could not be spawned. */
  exitCode: number | null;
  outcome: 'exit' | 'timeout' | 'spawn-error';
  stdout: string;
  stderr: string;
}

/**
 * Run the item's check.sh from the fork's repo root (`bash <item>/check.sh`,
 * so a non-executable bit can never fail the item), with the fork's isolated
 * HOME and the shared allowlisted env.
 */
export async function runCheckScript(
  item: CorpusItem,
  repoDir: string,
  homeDir: string,
  timeoutMs = 300_000,
): Promise<CheckResult> {
  const script = join(item.dir, 'check.sh');
  if (!existsSync(script)) {
    return { exitCode: null, outcome: 'spawn-error', stdout: '', stderr: `check.sh not found: ${script}` };
  }
  const run = await runWithTimeout(['bash', script], {
    cwd: repoDir,
    env: buildExecEnv(homeDir),
    timeoutMs,
  });
  return { exitCode: run.exitCode, outcome: run.outcome, stdout: run.stdout, stderr: run.stderr };
}

export interface JudgeRequest {
  /** task.md content — the scope drift is measured against. */
  taskMd: string;
  /** The run's saved git diff (may be empty). */
  diff: string;
  /** The executor's final output text. */
  executorOutput: string;
  /** success.md rubric — included ONLY when the judge must decide success. */
  rubric?: string;
}

export interface JudgeVerdict {
  drift: boolean;
  note: string;
  /** Present only when a rubric was supplied (check exited CHECK_EXIT_JUDGE). */
  success?: boolean;
}

/**
 * Build the judge prompt. Deliberately assembled here (not in run-stage) so
 * the hidden-field rule is enforced in exactly one place: this function takes
 * no item directory and therefore CANNOT read oracle.md or check.sh.
 */
export function buildJudgePrompt(request: JudgeRequest): string {
  const wantsSuccess = request.rubric !== undefined;
  const sections = [
    `${JUDGE_PROMPT_MARKER} — judge one benchmark run.`,
    '',
    'You are given the task an agent was asked to do, the git diff it produced, and its final output.',
    wantsSuccess
      ? 'Decide TWO things: (1) whether the work drifted outside the task scope, and (2) whether the run satisfies the success rubric.'
      : 'Decide ONE thing: whether the work drifted outside the task scope.',
    '',
    'Drift means work clearly outside what the task asked for (unrelated refactors, unrelated files, extra features nobody requested). Doing the task incompletely is NOT drift.',
    '',
    '=== TASK ===',
    request.taskMd.trim(),
    '',
    '=== GIT DIFF ===',
    capText(request.diff, JUDGE_DIFF_CAP) || '(empty diff)',
    '',
    '=== AGENT OUTPUT ===',
    capText(request.executorOutput, JUDGE_OUTPUT_CAP) || '(no output)',
  ];
  if (wantsSuccess) {
    sections.push('', '=== SUCCESS RUBRIC ===', request.rubric!.trim());
  }
  sections.push(
    '',
    '=== RESPOND ===',
    wantsSuccess
      ? 'Respond with ONLY a JSON object: {"drift": true|false, "note": "<one sentence>", "success": true|false}'
      : 'Respond with ONLY a JSON object: {"drift": true|false, "note": "<one sentence>"}',
    'No markdown fences, no prose outside the JSON.',
  );
  return sections.join('\n');
}

/** Tolerant parse of a judge reply: the braced JSON object, wherever it sits. */
export function parseJudgeReply(raw: string): JudgeVerdict | undefined {
  const braced = raw.match(/\{[\s\S]*\}/);
  if (!braced) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(braced[0]);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.drift !== 'boolean') return undefined;
  const verdict: JudgeVerdict = {
    drift: record.drift,
    note: typeof record.note === 'string' ? record.note : '',
  };
  if (typeof record.success === 'boolean') verdict.success = record.success;
  return verdict;
}

export interface JudgeCallResult {
  /**
   * Whether the model call actually completed (a reply came back, parseable
   * or not). False when the transport threw — nothing was spent, so nothing
   * may be booked as unknown cost.
   */
  called: boolean;
  verdict?: JudgeVerdict;
  error?: string;
  /** Real reported usage only (guard 1) — null when the provider reported none. */
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  raw?: string;
}

/** One judge model call. Never throws — a failed judge is a recorded note. */
export async function callJudge(
  judgeModel: string,
  request: JudgeRequest,
  options: { query?: QueryModelFn; apiKey?: string } = {},
): Promise<JudgeCallResult> {
  const query = options.query ?? queryModel;
  const prompt = buildJudgePrompt(request);
  try {
    const response = await query(judgeModel, [{ role: 'user', content: prompt }], {
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      // Deterministic adjudication; the judge emits a small JSON object.
      // Per-attempt timeout comes from retry.ts's 30s default.
      temperature: 0,
      maxTokens: 512,
    });
    const result: JudgeCallResult = {
      called: true,
      cost_usd: typeof response.costUsd === 'number' ? response.costUsd : null,
      tokens_in: typeof response.inputTokens === 'number' ? response.inputTokens : null,
      tokens_out: typeof response.outputTokens === 'number' ? response.outputTokens : null,
      raw: response.content,
    };
    const verdict = parseJudgeReply(response.content);
    if (verdict) {
      result.verdict = verdict;
    } else {
      result.error = 'judge reply did not contain a parseable JSON verdict';
    }
    return result;
  } catch (error: unknown) {
    // The call never landed: no reply, no usage, and no spend to record.
    return {
      called: false,
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface MeasureOptions {
  item: CorpusItem;
  repoDir: string;
  homeDir: string;
  /** task.md content (already loaded by the caller for the executor prompt). */
  taskMd: string;
  /** The executor's final output text. */
  executorOutput: string;
  /** ExecutionRecord.diff_path — read here, empty when missing. */
  diffPath: string;
  judgeModel: string;
  query?: QueryModelFn;
  apiKey?: string;
}

export interface MeasureResult {
  success: boolean;
  /**
   * Tri-state: true/false = the judge decided; null = UNKNOWN (the judge was
   * never reached, or its reply could not be parsed). Never silently false.
   */
  drift_flag: boolean | null;
  drift_note?: string;
  /** check.sh exit code; null when it timed out or could not run. */
  check_exit: number | null;
  /** True only when a judge model call actually completed. */
  judged: boolean;
  judge_cost_usd: number | null;
  judge_tokens_in: number | null;
  judge_tokens_out: number | null;
  judge_error?: string;
  judge_raw?: string;
}

/**
 * Measure one completed fork-run: run check.sh, then judge when there is
 * something to judge.
 *
 * The judge is called when the check deferred (success must be decided) OR
 * when the run produced a non-empty diff (drift is defined over the diff).
 * An empty diff with a decided check needs no model call: drift_flag=false
 * with a note saying why — real spend is never burned on a no-op run.
 */
export async function measureRun(options: MeasureOptions): Promise<MeasureResult> {
  const {
    item,
    repoDir,
    homeDir,
    taskMd,
    executorOutput,
    diffPath,
    judgeModel,
    query,
    apiKey,
  } = options;

  const check = await runCheckScript(item, repoDir, homeDir);
  const needsJudgeForSuccess = check.exitCode === CHECK_EXIT_JUDGE;
  const mechanicalSuccess = check.exitCode === CHECK_EXIT_PASS;

  let diff = '';
  try {
    if (diffPath && existsSync(diffPath)) diff = await Bun.file(diffPath).text();
  } catch {
    diff = '';
  }

  const result: MeasureResult = {
    success: mechanicalSuccess,
    // Default UNKNOWN; only a judge verdict (or a provably empty diff) can
    // turn it into a boolean.
    drift_flag: null,
    check_exit: check.exitCode,
    judged: false,
    judge_cost_usd: null,
    judge_tokens_in: null,
    judge_tokens_out: null,
  };
  if (check.outcome !== 'exit') {
    result.drift_note = `check.sh ${check.outcome}`;
  }

  const hasDiff = diff.trim() !== '';
  if (!needsJudgeForSuccess && !hasDiff) {
    // Nothing changed and the check decided mechanically: drift is genuinely
    // false (no out-of-scope work exists), not unknown — and no judge spend.
    result.drift_flag = false;
    result.drift_note = [result.drift_note, 'no diff — judge not called'].filter(Boolean).join('; ');
    return result;
  }

  let rubric: string | undefined;
  if (needsJudgeForSuccess) {
    const rubricPath = join(item.dir, 'success.md');
    rubric = existsSync(rubricPath) ? await Bun.file(rubricPath).text() : undefined;
    if (rubric === undefined) {
      // check.sh deferred to a rubric the item does not ship: not a pass, and
      // drift stays UNKNOWN because no judge was consulted.
      result.success = false;
      result.drift_note = [result.drift_note, 'check.sh deferred to success.md but the item has none']
        .filter(Boolean)
        .join('; ');
      return result;
    }
  }

  const judgeCall = await callJudge(
    judgeModel,
    {
      taskMd,
      diff,
      executorOutput,
      ...(rubric !== undefined ? { rubric } : {}),
    },
    { ...(query ? { query } : {}), ...(apiKey ? { apiKey } : {}) },
  );

  // judged reflects a COMPLETED call: a transport failure never happened as
  // far as spend accounting is concerned (guard 1 — no phantom unknown cost).
  result.judged = judgeCall.called;
  result.judge_cost_usd = judgeCall.cost_usd;
  result.judge_tokens_in = judgeCall.tokens_in;
  result.judge_tokens_out = judgeCall.tokens_out;
  if (judgeCall.raw !== undefined) result.judge_raw = judgeCall.raw;

  if (!judgeCall.verdict) {
    // A judge that could not answer decides nothing: drift is UNKNOWN (null,
    // never a fabricated false) and a deferred success stays false — both are
    // visible in the note, never silently favorable.
    result.drift_flag = null;
    result.judge_error = judgeCall.error ?? 'judge produced no verdict';
    if (needsJudgeForSuccess) result.success = false;
    result.drift_note = [result.drift_note, `judge unavailable: ${result.judge_error}`]
      .filter(Boolean)
      .join('; ');
    return result;
  }

  result.drift_flag = judgeCall.verdict.drift;
  const note = judgeCall.verdict.note.trim();
  result.drift_note = [result.drift_note, note].filter(Boolean).join('; ') || undefined;
  if (needsJudgeForSuccess) {
    if (typeof judgeCall.verdict.success === 'boolean') {
      result.success = judgeCall.verdict.success;
    } else {
      result.success = false;
      result.judge_error = 'judge verdict omitted the success field for a judge-gated item';
      result.drift_note = [result.drift_note, result.judge_error].filter(Boolean).join('; ');
    }
  }

  return result;
}
