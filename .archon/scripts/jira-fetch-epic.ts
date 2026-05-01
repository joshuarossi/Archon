#!/usr/bin/env bun
/**
 * Fetch an Epic from Jira and write:
 *   - $ARTIFACTS_DIR/epic-context.md       (human-readable summary)
 *   - $ARTIFACTS_DIR/attachment-inventory.json (machine-readable attachment list)
 *   - $ARTIFACTS_DIR/epic.raw.json         (full API response, for debugging)
 *
 * Reads the Epic key from $ARTIFACTS_DIR/trigger-payload.json.
 *
 * stdout: { epic_context, attachment_inventory, epic_key, attachment_count }
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

interface TriggerPayload {
  issue_key: string;
  project: string;
}
interface JiraAttachment {
  id: string;
  filename: string;
  size?: number;
  mimeType?: string;
  content?: string;
}
interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    status?: { name: string };
    issuetype?: { name: string };
    attachment?: JiraAttachment[];
  };
}

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

const trigger: TriggerPayload = JSON.parse(await readFile(`${artifactsDir}/trigger-payload.json`, 'utf8'));

console.log(`Fetching Jira Epic ${trigger.issue_key} from project ${trigger.project} via REST...`);

// Call jira-tool getIssue with attachment field expanded.
const input = JSON.stringify({
  action: 'getIssue',
  issueKey: trigger.issue_key,
  fields: ['summary', 'description', 'status', 'issuetype', 'attachment'],
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
const parsed = JSON.parse(stdout) as { ok: boolean; result: JiraIssue; error?: string };
if (!parsed.ok) {
  process.stderr.write(stdout);
  process.exit(1);
}
const issue = parsed.result;

console.log(`Got Epic: "${issue.fields.summary}" (${issue.fields.status?.name ?? 'unknown status'}, ${issue.fields.issuetype?.name ?? 'unknown type'}).`);
await writeFile(`${artifactsDir}/epic.raw.json`, JSON.stringify(issue, null, 2));
console.log(`Wrote raw API response to ${artifactsDir}/epic.raw.json.`);

const attachments = issue.fields.attachment ?? [];
console.log(`Found ${attachments.length} attachment(s):`);
for (const a of attachments) {
  console.log(`  - ${a.filename} (${a.mimeType ?? 'unknown'}, ${a.size ?? '?'} bytes)`);
}
const inventory = attachments.map(a => ({
  id: a.id,
  filename: a.filename,
  contentType: a.mimeType,
  size: a.size,
  url: a.content,
}));
await writeFile(`${artifactsDir}/attachment-inventory.json`, JSON.stringify(inventory, null, 2));

// Render description: Jira returns ADF (object) for v3 — flatten naively for now.
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

const descriptionText = adfToText(issue.fields.description).trim();

const md = [
  '# Epic Context',
  '',
  '## Scope Summary',
  '',
  `- **Key:** ${issue.key}`,
  `- **Title:** ${issue.fields.summary}`,
  `- **Status:** ${issue.fields.status?.name ?? '(unknown)'}`,
  `- **Type:** ${issue.fields.issuetype?.name ?? '(unknown)'}`,
  `- **Attachments:** ${attachments.length}`,
  '',
  '## Full Description',
  '',
  descriptionText || '(no description)',
  '',
  '## Attachment Inventory',
  '',
  attachments.length === 0
    ? '(no attachments)'
    : attachments.map(a => `- \`${a.filename}\` (${a.mimeType ?? 'unknown'}, ${a.size ?? '?'} bytes, id ${a.id})`).join('\n'),
  '',
].join('\n');

await mkdir(artifactsDir, { recursive: true });
await writeFile(join(artifactsDir, 'epic-context.md'), md);
console.log(`Wrote epic-context.md (${md.length} chars) and attachment-inventory.json.`);
console.log('Epic fetch complete.');

process.stdout.write(
  '\n' +
    JSON.stringify({
      epic_context: `${artifactsDir}/epic-context.md`,
      attachment_inventory: `${artifactsDir}/attachment-inventory.json`,
      epic_key: issue.key,
      attachment_count: attachments.length,
    })
);
