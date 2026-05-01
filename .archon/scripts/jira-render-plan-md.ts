#!/usr/bin/env bun
/**
 * Render decomposition-plan.json to a human-readable decomposition-plan.md.
 * Pure mechanical transform — no LLM needed.
 *
 * stdout: { plan_markdown }
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface PlanTask {
  task_id: string;
  title: string;
  summary: string;
  acceptance_criteria: string[];
  depends_on: string[];
  suggested_jira_type: string;
}
interface Plan {
  epic_key: string;
  epic_title: string;
  planning_assumptions: string[];
  dependency_graph_notes: string;
  tasks: PlanTask[];
}

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

// Read with brief retry: previous node was an agent whose `Write` tool sometimes
// returns before the filesystem commit completes under memory pressure.
async function readWithRetry(p: string, attempts = 5, delayMs = 500): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await readFile(p, 'utf8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT' || i === attempts - 1) throw e;
      console.log(`  (waiting for ${p} to appear, attempt ${i + 1}/${attempts}...)`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

const plan: Plan = JSON.parse(await readWithRetry(`${artifactsDir}/decomposition-plan.json`));
console.log(`Rendering plan for ${plan.epic_key} ("${plan.epic_title}") with ${plan.tasks.length} tasks to markdown...`);

const lines: string[] = [];
lines.push(`# Epic Decomposition Plan: ${plan.epic_key} — ${plan.epic_title}`);
lines.push('');

if (plan.planning_assumptions.length > 0) {
  lines.push('## Planning Assumptions');
  lines.push('');
  for (const a of plan.planning_assumptions) lines.push(`- ${a}`);
  lines.push('');
}

if (plan.dependency_graph_notes) {
  lines.push('## Dependency Graph Notes');
  lines.push('');
  lines.push(plan.dependency_graph_notes);
  lines.push('');
}

lines.push('## Proposed Task Graph');
lines.push('');
const roots = plan.tasks.filter(t => !t.depends_on || t.depends_on.length === 0).map(t => t.task_id);
lines.push(`Root tasks (no blockers): ${roots.join(', ') || '(none)'}.`);
lines.push('');
lines.push('Dependencies:');
for (const t of plan.tasks) {
  if (t.depends_on && t.depends_on.length > 0) {
    lines.push(`- ${t.task_id} blocked by ${t.depends_on.join(', ')}`);
  }
}
lines.push('');

lines.push('## Task Breakdown');
lines.push('');
for (const t of plan.tasks) {
  lines.push(`### ${t.task_id}: ${t.title}`);
  lines.push('');
  lines.push(`**Type:** ${t.suggested_jira_type}`);
  lines.push('');
  lines.push(`**Summary:** ${t.summary}`);
  lines.push('');
  if (t.depends_on && t.depends_on.length > 0) {
    lines.push(`**Depends on:** ${t.depends_on.join(', ')}`);
    lines.push('');
  }
  if (t.acceptance_criteria.length > 0) {
    lines.push('**Acceptance Criteria:**');
    lines.push('');
    for (const ac of t.acceptance_criteria) lines.push(`- ${ac}`);
    lines.push('');
  }
}

const outPath = join(artifactsDir, 'decomposition-plan.md');
await writeFile(outPath, lines.join('\n'));
console.log(`Wrote ${outPath} (${lines.length} lines).`);
process.stdout.write('\n' + JSON.stringify({ plan_markdown: outPath }));
