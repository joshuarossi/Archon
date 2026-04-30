#!/usr/bin/env bun
/**
 * Fetch a Jira task and write its full context to disk for downstream nodes.
 *
 * Reads:
 *   $ARTIFACTS_DIR/trigger-payload.json — webhook payload with issue_key
 *
 * Writes:
 *   $ARTIFACTS_DIR/task-context.md         — human-readable task summary + description
 *   $ARTIFACTS_DIR/task.raw.json           — full API response (for debugging)
 *   $ARTIFACTS_DIR/parent-epic-key.txt     — parent Epic key (e.g., "WOR-5")
 *
 * stdout: { task_key, parent_epic_key, status, has_description }
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

interface TriggerPayload {
  issue_key: string;
  project: string;
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

const trigger: TriggerPayload = JSON.parse(await readWithRetry(`${artifactsDir}/trigger-payload.json`));

console.log(`Fetching Jira task ${trigger.issue_key} from project ${trigger.project} via REST...`);

const input = JSON.stringify({
  action: 'getIssue',
  issueKey: trigger.issue_key,
  fields: ['summary', 'description', 'status', 'issuetype', 'parent', 'labels'],
});

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

interface JiraTask {
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    status?: { name: string };
    issuetype?: { name: string };
    parent?: { key: string; fields?: { summary?: string } };
    labels?: string[];
  };
}

const parsed = JSON.parse(stdout) as { ok: boolean; result: JiraTask; error?: string };
if (!parsed.ok) {
  process.stderr.write(stdout);
  process.exit(1);
}
const task = parsed.result;

await writeFile(`${artifactsDir}/task.raw.json`, JSON.stringify(task, null, 2));

console.log(`Got task: "${task.fields.summary}" (${task.fields.status?.name ?? 'unknown status'}, ${task.fields.issuetype?.name ?? 'unknown type'}).`);
const parentKey = task.fields.parent?.key ?? '';
if (parentKey) {
  console.log(`Parent Epic: ${parentKey}${task.fields.parent?.fields?.summary ? ` ("${task.fields.parent.fields.summary}")` : ''}.`);
} else {
  console.log('No parent Epic. Tech context fetch may be skipped.');
}
await writeFile(`${artifactsDir}/parent-epic-key.txt`, parentKey);

// Render description from ADF/string/null to plain text — same pattern as fetch-epic.
function adfToText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return String(node);
  const obj = node as { type?: string; text?: string; content?: unknown[] };
  const parts: string[] = [];
  if (obj.type === 'text' && typeof obj.text === 'string') parts.push(obj.text);
  if (Array.isArray(obj.content)) {
    for (const child of obj.content) parts.push(adfToText(child));
    if (obj.type !== 'text' && obj.type !== undefined) parts.push('\n\n');
  }
  return parts.join('');
}

const descriptionText = adfToText(task.fields.description).trim();

const md = [
  `# Task ${task.key}: ${task.fields.summary}`,
  '',
  '## Metadata',
  '',
  `- **Key:** ${task.key}`,
  `- **Status:** ${task.fields.status?.name ?? '(unknown)'}`,
  `- **Type:** ${task.fields.issuetype?.name ?? '(unknown)'}`,
  `- **Parent Epic:** ${parentKey || '(none)'}`,
  `- **Labels:** ${(task.fields.labels ?? []).join(', ') || '(none)'}`,
  '',
  '## Full Description',
  '',
  descriptionText || '(no description)',
  '',
].join('\n');

await writeFile(join(artifactsDir, 'task-context.md'), md);
console.log(`Wrote task-context.md (${md.length} chars).`);
console.log('Task fetch complete.');

process.stdout.write(
  '\n' +
    JSON.stringify({
      task_key: task.key,
      parent_epic_key: parentKey,
      status: task.fields.status?.name,
      has_description: descriptionText.length > 0,
    })
);
