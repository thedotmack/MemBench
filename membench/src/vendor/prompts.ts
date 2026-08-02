// Vendored from claude-mem src/sdk/prompts.ts
// Commit: 132b46343 — TRIMMED vendored copy: the summary-mode surface
// (SUMMARY_MODE_MARKER, SDKSession, buildSummaryPrompt,
// buildContinuationPrompt) is removed as unused by MemBench; the import shims
// replace claude-mem's internals; the remaining code is otherwise unmodified.
// Vendored: 2026-08-01 for MemBench

import { logger } from './shims/logger.js';
import type { ModeConfig } from './shims/types.js';

export interface Observation {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  created_at_epoch: number;
  cwd?: string;
}

function observationSkeleton(mode: ModeConfig): string {
  return `${mode.prompts.output_format_header}

<observation>
  <type>[ ${mode.observation_types.map(t => t.id).join(' | ')} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <!--
    ${mode.prompts.concept_guidance}
  -->
  <files_read>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_read>
  <files_modified>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_modified>
</observation>
${mode.prompts.format_examples}

${mode.prompts.footer}`;
}

export function buildInitPrompt(project: string, sessionId: string, userPrompt: string, mode: ModeConfig): string {
  return `${mode.prompts.system_identity}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${observationSkeleton(mode)}

${mode.prompts.header_memory_start}`;
}

// Per-field character budget for the <parameters> / <outcome> blocks in an
// observation prompt. Each field is allowed up to OBS_PROMPT_FIELD_MAX_CHARS;
// content past that is replaced with a head + tail slice plus an explicit
// <elided ...> marker so the observer model can see *that* truncation
// happened (and won't fabricate detail about the missing range).
//
// 16k chars ≈ ~4k tokens (4 chars/token rough estimate). Two fields per
// observation → ~8k tokens of variable input. With a 128k-token observer
// model that leaves ample room for the system prompt, conversation
// history, and the model's own response — and prevents a single oversized
// Read tool result (issue #2468 reports a 130k-char file) from blowing
// the entire context window and forcing the SDK session to abort with
// "prompt is too long".
//
// Head/tail ratio (60% / 30%) keeps the start of the field (where most
// tools put their canonical signal — file path, error message, command
// header) and the tail (where errors / final-line context typically sit)
// while dropping the middle. The 10% remainder is the elision marker.
const OBS_PROMPT_FIELD_MAX_CHARS = 16_000;
const OBS_PROMPT_FIELD_HEAD_RATIO = 0.6;
const OBS_PROMPT_FIELD_TAIL_RATIO = 0.3;

function truncateObservationField(value: unknown, maxChars: number = OBS_PROMPT_FIELD_MAX_CHARS): string {
  // JSON.stringify returns undefined for undefined / functions / symbols;
  // fall back to empty string so the call sites (template literal output)
  // and the length check below stay well-defined.
  const raw = JSON.stringify(value, null, 2) ?? '';
  if (raw.length <= maxChars) return raw;
  const headChars = Math.max(0, Math.floor(maxChars * OBS_PROMPT_FIELD_HEAD_RATIO));
  const tailChars = Math.max(0, Math.floor(maxChars * OBS_PROMPT_FIELD_TAIL_RATIO));
  const head = raw.slice(0, headChars);
  const tail = tailChars > 0 ? raw.slice(-tailChars) : '';
  const elidedChars = Math.max(0, raw.length - head.length - tail.length);
  return `${head}\n... <elided chars="${elidedChars}" original_size_chars="${raw.length}" reason="oversize" /> ...\n${tail}`;
}

export function buildObservationPrompt(obs: Observation): string {
  let toolInput: any;
  let toolOutput: any;

  try {
    toolInput = typeof obs.tool_input === 'string' ? JSON.parse(obs.tool_input) : obs.tool_input;
  } catch (error: unknown) {
    logger.debug('SDK', 'Tool input is plain string, using as-is', {
      toolName: obs.tool_name
    }, error instanceof Error ? error : new Error(String(error)));
    toolInput = obs.tool_input;
  }

  try {
    toolOutput = typeof obs.tool_output === 'string' ? JSON.parse(obs.tool_output) : obs.tool_output;
  } catch (error: unknown) {
    logger.debug('SDK', 'Tool output is plain string, using as-is', {
      toolName: obs.tool_name
    }, error instanceof Error ? error : new Error(String(error)));
    toolOutput = obs.tool_output;
  }

  return `<observed_from_primary_session>
  <what_happened>${obs.tool_name}</what_happened>
  <occurred_at>${new Date(obs.created_at_epoch).toISOString()}</occurred_at>${obs.cwd ? `\n  <working_directory>${obs.cwd}</working_directory>` : ''}
  <parameters>${truncateObservationField(toolInput)}</parameters>
  <outcome>${truncateObservationField(toolOutput)}</outcome>
</observed_from_primary_session>

If a <parameters> or <outcome> block above contains an "<elided chars=... />" marker, that field was truncated to fit the observer's context window. Describe only what you can see in the kept portion and do not infer details about the elided range.

Return either one or more <observation>...</observation> blocks, or an empty response if this tool use should be skipped.
Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection count as durable discoveries and should be recorded.
Never reply with prose such as "Skipping", "No substantive tool executions", or any explanation outside XML. Non-XML text is discarded.`;
}
