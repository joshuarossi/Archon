#!/usr/bin/env bun
/**
 * PreToolUse hook for Jira pipeline dev nodes: all test-boundary enforcement lives here
 * (no path-shaped `denied_tools` in the workflow). Allow normal dev; deny test paths,
 * listing test dirs, deleting test files, and Bash that runs test runners or touches test paths.
 *
 * Stdin: JSON hook input (Claude Agent SDK shape: tool_name, tool_input, cwd, …).
 * Stdout: JSON SyncHookJSONOutput with hookSpecificOutput, or empty to allow.
 *
 * Only registered on implementation nodes in task-implement.yaml — no env role gate.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const DEV_AGENT_REASON = `This action touches tests or runs a test command. That is not your job on this node.

Tests are owned and run by other pipeline steps (and other agents where applicable), not by you here. Your responsibility is the implementation work this step describes: application code from the task spec and validation feedback — not reading, writing, listing, deleting, or executing tests or test tooling.

Do not retry with different paths or tools to bypass this.`;

function deny(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

function allow(): never {
  process.exit(0);
}

const TEST_PATH_RE =
  /(^|\/)(tests?|e2e|__tests__)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$|(^|\/)(vitest|playwright|jest|cypress)\.config\./;

function isTestPath(p: string, hookCwd: string): boolean {
  if (!p) return false;
  let resolved: string;
  try {
    resolved = realpathSync(resolve(hookCwd, p));
  } catch {
    resolved = resolve(hookCwd, p);
  }
  return TEST_PATH_RE.test(resolved);
}

const TEST_RUNNER_RE =
  /\b(vitest|jest|playwright|pytest|cypress|mocha|jasmine)\b|\bnpm\s+(run\s+)?test\b|\bnpx\s+(vitest|jest|playwright)\b|\byarn\s+test\b|\bpnpm\s+test\b|\bbun\s+(run\s+)?test\b|\bdeno\s+test\b/;

function bashRunsTests(cmd: string): boolean {
  return TEST_RUNNER_RE.test(cmd);
}

function bashTouchesTests(cmd: string): boolean {
  const tokens = cmd.match(/[^\s'"`;|&<>(){}]+/g) ?? [];
  return tokens.some(t => TEST_PATH_RE.test(t));
}

// ---------------------------------------------------------------------------

const raw = await Bun.stdin.text();
const input = JSON.parse(raw) as {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
};

const hookCwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();
const toolName = input.tool_name ?? '';
const toolInput = input.tool_input ?? {};

if (
  toolName === 'Read' ||
  toolName === 'Edit' ||
  toolName === 'Write' ||
  toolName === 'MultiEdit' ||
  toolName === 'NotebookEdit'
) {
  const path =
    (toolInput.file_path as string | undefined) ??
    (toolInput.notebook_path as string | undefined) ??
    '';
  if (isTestPath(path, hookCwd)) deny(DEV_AGENT_REASON);
}

if (toolName === 'Delete') {
  const path =
    (toolInput.file_path as string | undefined) ?? (toolInput.path as string | undefined) ?? '';
  if (path && isTestPath(path, hookCwd)) deny(DEV_AGENT_REASON);
}

if (toolName === 'LS') {
  const path =
    (toolInput.path as string | undefined) ??
    (toolInput.directory as string | undefined) ??
    '';
  if (path && isTestPath(path, hookCwd)) deny(DEV_AGENT_REASON);
}

if (toolName === 'Glob') {
  const pattern = (toolInput.pattern as string | undefined) ?? '';
  if (/test|spec|e2e|__tests__/.test(pattern)) deny(DEV_AGENT_REASON);
}

if (toolName === 'Grep') {
  const path = (toolInput.path as string | undefined) ?? '';
  if (path && isTestPath(path, hookCwd)) deny(DEV_AGENT_REASON);
}

if (toolName === 'Bash') {
  const cmd = (toolInput.command as string | undefined) ?? '';
  if (bashRunsTests(cmd)) deny(DEV_AGENT_REASON);
  if (bashTouchesTests(cmd)) deny(DEV_AGENT_REASON);
}

allow();
