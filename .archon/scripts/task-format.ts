#!/usr/bin/env bun
/**
 * Auto-format the downstream working tree before the branch is pushed/opened
 * as a PR, then commit any formatting delta.
 *
 * Why this exists: Archie's task-implement DAG commits at several points
 * (each dev-attempt, each fix-after-validate, repair-tests-from-final-review,
 * generate-docs). None of those run the project's formatter. Downstream
 * projects whose CI runs `prettier --check` (and gates the rest of CI behind
 * it via `needs: lint`) go red the moment Archie pushes an unformatted file.
 * Repairing the past (a one-off `prettier --write`) does not fix the cause;
 * this node makes formatting part of how Archie produces commits.
 *
 * Behavior (matches the "auto-run format, then commit" decision):
 *   - If the downstream package.json has no `format` script -> no-op.
 *     (ConflictCoach has none; this MUST stay safe for such repos.)
 *   - Else run it, `git add -A`, and commit ONLY if there is a delta.
 *   - ALWAYS exit 0. Formatting is a fix-up, not a quality gate — same
 *     convention as task-run-validation.sh's non-loop invocations.
 *
 * Invoked by two task-implement nodes (defense-in-depth, one per commit
 * chokepoint): `format-after-test-repair` and `format-before-pr`.
 *
 * Reads:  $ARTIFACTS_DIR (only to confirm the run context; not required)
 * stdout: a single JSON line { formatted: boolean, committed: boolean, reason }
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

const FORMAT_SCRIPT = 'format';

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: process.cwd() });
  return stdout.trim();
}

function emit(result: { formatted: boolean; committed: boolean; reason: string }): never {
  // Single JSON line on stdout; always exit 0 (fix-up, never a gate).
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

// 1. Detect a `format` script in the downstream package.json. Mirrors the
//    has_script() convention in task-run-validation.sh:163-174 — do not
//    invent a different detection path.
let pkg: { scripts?: Record<string, string>; packageManager?: string };
try {
  pkg = JSON.parse(await readFile('package.json', 'utf8'));
} catch {
  emit({ formatted: false, committed: false, reason: 'no_package_json' });
}
if (!pkg!.scripts || !pkg!.scripts[FORMAT_SCRIPT]) {
  emit({ formatted: false, committed: false, reason: 'no_format_script' });
}

// 2. Run the project's formatter. Use the same package manager the rest of
//    the validation contract uses (npm — task-run-validation.sh runs
//    `npm run lint`/`npm run typecheck`). Keep this consistent rather than
//    guessing per-repo.
try {
  await execFileAsync('npm', ['run', FORMAT_SCRIPT], { cwd: process.cwd() });
} catch (e) {
  // A failing formatter must not break the run (fail-soft, by design — it is
  // not a gate). Surface the reason; the pre-existing CI `prettier --check`
  // remains the backstop that catches genuinely unformattable states.
  const err = e as { stderr?: string; message?: string };
  emit({
    formatted: false,
    committed: false,
    reason: `format_script_failed: ${(err.stderr ?? err.message ?? '').slice(0, 200)}`,
  });
}

// 3. Commit only if formatting actually changed tracked files.
const dirty = await git('status', '--porcelain');
if (!dirty) {
  emit({ formatted: true, committed: false, reason: 'no_changes' });
}

await git('add', '-A');
// Re-check staged delta: `git add -A` of only-ignored/whitespace-noop edits
// can still leave nothing staged.
const staged = await git('diff', '--cached', '--name-only');
if (!staged) {
  emit({ formatted: true, committed: false, reason: 'nothing_staged' });
}

await git('commit', '--no-verify', '-m', 'style: apply project formatter (automated)');
emit({ formatted: true, committed: true, reason: 'committed' });
