#!/usr/bin/env bun
/**
 * Reads $ARTIFACTS_DIR/decomposition-plan.json and $ARTIFACTS_DIR/task-keymap.json
 * and creates Blocks issue links between newly-created Jira tasks per the plan's
 * depends_on graph. Idempotency: assumes the keymap is the source of truth for
 * which tasks exist; tasks not yet in the keymap are skipped.
 *
 * Blocks link semantics (Jira): outward = "blocks", inward = "is blocked by".
 * For "blocker blocks dependent": outwardIssue = blocker, inwardIssue = dependent.
 *
 * Output: stdout = single-line JSON { linked, failed, total }.
 * Side effect: writes $ARTIFACTS_DIR/blocks-links-report.json with full per-op detail.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface PlanTask {
  task_id: string;
  depends_on?: string[];
}
interface Plan {
  tasks: PlanTask[];
}
type Keymap = Record<string, string>;
interface BatchOp {
  action: 'createIssueLink';
  linkType: 'Blocks';
  inwardIssueKey: string;
  outwardIssueKey: string;
}
interface BatchResultItem {
  index: number;
  action: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
interface BatchResponse {
  ok: boolean;
  action: string;
  result: { ok: boolean; count: number; results: BatchResultItem[] };
}

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

async function readWithRetry(p: string, attempts = 5, delayMs = 500): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await readFile(p, 'utf8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT' || i === attempts - 1) throw e;
      console.log(`  (waiting for ${p}, attempt ${i + 1}/${attempts}...)`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

const plan: Plan = JSON.parse(await readWithRetry(`${artifactsDir}/decomposition-plan.json`));
const keymap: Keymap = JSON.parse(await readWithRetry(`${artifactsDir}/task-keymap.json`));

console.log(`Walking depends_on graph across ${plan.tasks.length} planned tasks (${Object.keys(keymap).length} actually created)...`);

const operations: BatchOp[] = [];
for (const task of plan.tasks) {
  const dependentKey = keymap[task.task_id];
  if (!dependentKey) continue;
  for (const depPlanId of task.depends_on ?? []) {
    const blockerKey = keymap[depPlanId];
    if (!blockerKey) continue;
    // Jira POST /rest/api/3/issueLink semantics (counterintuitive vs. GET):
    // inwardIssue is the blocker (source of the "blocks" action),
    // outwardIssue is the blocked party (target of the action).
    // For "blocker blocks dependent": inwardIssue = blocker, outwardIssue = dependent.
    operations.push({
      action: 'createIssueLink',
      linkType: 'Blocks',
      inwardIssueKey: blockerKey,
      outwardIssueKey: dependentKey,
    });
    console.log(`  link: ${blockerKey} blocks ${dependentKey}  (${depPlanId} → ${task.task_id})`);
  }
}

if (operations.length === 0) {
  console.log('No dependencies declared in the plan — nothing to link.');
  process.stdout.write('\n' + JSON.stringify({ linked: 0, failed: 0, total: 0, note: 'no dependencies in plan' }));
  process.exit(0);
}

console.log(`Submitting ${operations.length} Blocks links to Jira in a single batch...`);

const input = JSON.stringify({ action: 'batch', operations });
let stdout: string;
try {
  ({ stdout } = await execFileAsync('bun', ['/home/user/Archon/.archon/scripts/jira-tool.js', input], {
    maxBuffer: 50 * 1024 * 1024,
  }));
} catch (e) {
  // jira-tool exits non-zero on failure; its JSON failure payload is in error.stdout.
  const err = e as { stdout?: string; message?: string };
  process.stderr.write(`jira-tool failed: ${err.stdout ?? err.message ?? String(e)}\n`);
  process.exit(1);
}
const parsed: BatchResponse = JSON.parse(stdout);
if (!parsed.ok) {
  process.stderr.write(stdout);
  process.exit(1);
}

const failed = parsed.result.results.filter(r => !r.ok);
const linked = operations.length - failed.length;
await writeFile(`${artifactsDir}/blocks-links-report.json`, JSON.stringify(parsed.result, null, 2));
console.log(`Created ${linked} Blocks link(s); ${failed.length} failed.`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  ✗ op ${f.index} (${f.action}): ${f.error}`);
}
console.log(`Wrote per-op report to ${artifactsDir}/blocks-links-report.json.`);

process.stdout.write(
  '\n' + JSON.stringify({ linked, failed: failed.length, total: operations.length })
);
