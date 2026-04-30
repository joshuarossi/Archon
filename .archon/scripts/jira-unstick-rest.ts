#!/usr/bin/env bun
/**
 * For tasks with declared `depends_on`, removes the archon-blocked-pending label
 * (no transition — they stay in Backlog). Pairs with jira-unblock-roots: roots get
 * unblocked and transitioned, rest get the label stripped so the task-created
 * webhook router branch can pick them up later when their blockers complete.
 *
 * Output: stdout = single-line JSON { unstuck, keys }.
 * Side effect: writes $ARTIFACTS_DIR/unstick-rest-report.json.
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
  action: 'editLabels' | 'addComment';
  issueKey: string;
  remove?: string[];
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

const nonRoots = plan.tasks
  .filter(t => Array.isArray(t.depends_on) && t.depends_on.length > 0)
  .map(t => keymap[t.task_id])
  .filter((k): k is string => Boolean(k));

console.log(`Identifying non-root tasks (have declared blockers): ${nonRoots.length} found.`);

if (nonRoots.length === 0) {
  console.log('No non-root tasks — every task was a root. Nothing to do.');
  process.stdout.write('\n' + JSON.stringify({ unstuck: 0, keys: [], note: 'no non-root tasks' }));
  process.exit(0);
}

console.log(`Stripping archon-blocked-pending label from ${nonRoots.length} tasks (they stay in Backlog until their blockers are Done).`);

const operations: BatchOp[] = nonRoots.flatMap(key => [
  { action: 'editLabels' as const, issueKey: key, remove: ['archon-blocked-pending'] },
  {
    action: 'addComment' as const,
    issueKey: key,
    text:
      'Decomposition complete. Blocks links are in place; this task will move to Selected for Development once its blockers are Done.',
  },
]);

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
await writeFile(`${artifactsDir}/unstick-rest-report.json`, JSON.stringify(parsed.result, null, 2));
console.log(`Done. ${nonRoots.length} tasks now ready in Backlog: ${nonRoots.join(', ')}.`);
process.stdout.write('\n' + JSON.stringify({ unstuck: nonRoots.length, keys: nonRoots }));
