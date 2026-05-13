/**
 * Canonical Jira-comment formatter for Archie. Every script that posts a
 * Jira comment should build its payload here and call `postWorkflowComment`.
 *
 * Format spec: `.archon/ARCHIE_COMMENT_FORMAT.md`. Three parts —
 * header (emoji + workflow/node), metadata line (run + timestamp +
 * optional fact), markdown body, fenced JSON payload.
 *
 * The workflow + node names come from env (set by the workflow runtime
 * or by the calling script). `run_id` comes from `WORKFLOW_RUN_ID` env
 * if present, else falls back to a synthetic id so legacy callers keep
 * working. Both can be overridden via `opts`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CommentLevel = 'info' | 'warn' | 'error' | 'paused' | 'meta';

const LEVEL_EMOJI: Record<CommentLevel, string> = {
  info: '🟢',
  warn: '🟡',
  error: '🔴',
  paused: '⏸️',
  meta: '🧭',
};

export interface WorkflowCommentInput {
  /** Jira issue key the comment lands on (e.g. "WOR-91"). */
  issueKey: string;
  /** Severity / category — drives the emoji. */
  level: CommentLevel;
  /** Workflow name. Falls back to `WORKFLOW_NAME` env when omitted. */
  workflow?: string;
  /** Node id within the workflow. Falls back to `NODE_ID` env when omitted. */
  node?: string;
  /** Full run id. Falls back to `WORKFLOW_RUN_ID` env when omitted. */
  runId?: string;
  /**
   * One short scan-view fact for the metadata line, e.g. `"elapsed 12m44s"`,
   * `"iteration 4/5"`, `"cost $0.42"`. Omit if none applies.
   */
  metaFact?: string;
  /** Markdown body — 1–6 short lines. The salient outcome, not narration. */
  body: string;
  /** Structured payload. Keys are open-ended; values must be JSON-serializable. */
  fields: Record<string, unknown>;
  /** Optional override for the timestamp (mostly for tests). */
  timestamp?: Date;
}

const JIRA_TOOL_PATH = '/home/user/Archon/.archon/scripts/jira-tool.js';

/** Build the comment text without posting. Useful for tests and prompt scaffolding. */
export function formatWorkflowComment(input: WorkflowCommentInput): string {
  const workflow = input.workflow ?? process.env.WORKFLOW_NAME ?? 'unknown-workflow';
  const node = input.node ?? process.env.NODE_ID ?? 'unknown-node';
  const runId = input.runId ?? process.env.WORKFLOW_RUN_ID ?? 'no-run-id';
  const shortRunId = runId.slice(0, 8);
  const emoji = LEVEL_EMOJI[input.level];
  const ts = (input.timestamp ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const metaParts = [`run ${shortRunId}`, ts];
  if (input.metaFact) metaParts.push(input.metaFact);

  const payload = {
    level: input.level,
    workflow,
    node,
    run_id: runId,
    issue_key: input.issueKey,
    fields: input.fields,
  };

  return [
    `${emoji} ${workflow} / ${node}`,
    metaParts.join(' · '),
    '',
    input.body.trim(),
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}

/**
 * Post a Jira comment via jira-tool.js using the canonical format.
 * Throws on non-OK response from the Jira API.
 */
export async function postWorkflowComment(input: WorkflowCommentInput): Promise<void> {
  const text = formatWorkflowComment(input);
  const action = JSON.stringify({
    action: 'addComment',
    issueKey: input.issueKey,
    text,
  });
  const { stdout } = await execFileAsync('bun', [JIRA_TOOL_PATH, action], {
    maxBuffer: 50 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { ok: boolean; error?: string };
  if (!parsed.ok) {
    throw new Error(`postWorkflowComment failed: ${parsed.error ?? stdout}`);
  }
}

/** Helper for "X hours, Y minutes, Z seconds" style elapsed strings. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m${s.toString().padStart(2, '0')}s`;
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}
