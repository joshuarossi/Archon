#!/usr/bin/env bun
/**
 * For tasks in decomposition-plan.json with no `depends_on`, removes the
 * archon-blocked-pending label and transitions the issue to "Selected for Development".
 * These are the "root" tasks that can start work immediately.
 *
 * Output: stdout = single-line JSON { unblocked, transitioned, keys }.
 * Side effect: writes $ARTIFACTS_DIR/unblock-roots-report.json.
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
  action: 'editLabels' | 'transitionIssue' | 'addComment';
  issueKey: string;
  remove?: string[];
  add?: string[];
  toStatus?: string;
  text?: string;
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

const rootPlanTasks = plan.tasks.filter(t => !t.depends_on || t.depends_on.length === 0);
const roots = rootPlanTasks.map(t => keymap[t.task_id]).filter((k): k is string => Boolean(k));

console.log(
  `Identifying root tasks (no declared blockers): ${rootPlanTasks.length} in plan, ${roots.length} have Jira keys in keymap.`
);
for (const t of rootPlanTasks) {
  const key = keymap[t.task_id];
  if (key) console.log(`  root: ${t.task_id} (${key}) — "${t.title}"`);
}

if (roots.length === 0) {
  console.log('No root tasks to unblock — leaving everything in Backlog.');
  process.stdout.write('\n' + JSON.stringify({ unblocked: 0, transitioned: 0, keys: [], note: 'no root tasks found' }));
  process.exit(0);
}

const operations: BatchOp[] = [];
for (const key of roots) {
  operations.push({ action: 'editLabels', issueKey: key, remove: ['archon-blocked-pending'] });
  operations.push({ action: 'transitionIssue', issueKey: key, toStatus: 'Selected for Development' });
  operations.push({
    action: 'addComment',
    issueKey: key,
    text: 'All blockers resolved (none declared). Unblocking and moving to Selected for Development.',
  });
}

console.log(`Submitting batch of ${operations.length} ops (${roots.length} tasks × 3: removeLabel, transition, comment)...`);

const input = JSON.stringify({ action: 'batch', operations });
let stdout: string;
try {
  ({ stdout } = await execFileAsync('bun', ['/home/user/Archon/.archon/scripts/jira-tool.js', input], {
    maxBuffer: 50 * 1024 * 1024,
  }));
} catch (e) {
  const err = e as { stdout?: string; message?: string };
  process.stderr.write(`jira-tool failed: ${err.stdout ?? err.message ?? String(e)}\n`);
  process.exit(1);
}
const parsed = JSON.parse(stdout);
if (!parsed.ok) {
  process.stderr.write(stdout);
  process.exit(1);
}
await writeFile(`${artifactsDir}/unblock-roots-report.json`, JSON.stringify(parsed.result, null, 2));
console.log(`Unblocked and transitioned: ${roots.join(', ')}.`);
console.log(`These will trigger the test-gen workflow on their next webhook event.`);
process.stdout.write('\n' + JSON.stringify({ unblocked: roots.length, transitioned: roots.length, keys: roots }));
