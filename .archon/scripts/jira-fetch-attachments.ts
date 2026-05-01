#!/usr/bin/env bun
/**
 * Reads $ARTIFACTS_DIR/attachment-inventory.json (produced by jira-fetch-epic.ts),
 * downloads every text-like attachment to $ARTIFACTS_DIR/attachments/<filename>,
 * and concatenates the content into $ARTIFACTS_DIR/attachments.md with one section
 * per file. Binary or unretrievable items are noted in an "Unretrieved" section.
 *
 * stdout: { attachments_md, downloaded, unretrieved, total }
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, basename, extname } from 'node:path';

const execFileAsync = promisify(execFile);

interface AttachmentEntry {
  id: string;
  filename: string;
  contentType?: string;
  size?: number;
  url?: string;
}

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

const inventory: AttachmentEntry[] = JSON.parse(
  await readFile(`${artifactsDir}/attachment-inventory.json`, 'utf8')
);

console.log(`Downloading ${inventory.length} attachment(s) from Jira...`);

const attachmentsDir = join(artifactsDir, 'attachments');
await mkdir(attachmentsDir, { recursive: true });

// Decide if a file is text-like by content-type or extension.
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.html', '.htm', '.xml', '.js', '.ts']);
function isTextLike(att: AttachmentEntry): boolean {
  const ct = (att.contentType ?? '').toLowerCase();
  if (ct.startsWith('text/')) return true;
  if (ct.includes('json') || ct.includes('yaml') || ct.includes('xml') || ct.includes('javascript')) return true;
  // Atlassian sometimes lies about MIME (we saw .md flagged as application/javascript).
  // Fall back to extension check.
  return TEXT_EXT.has(extname(att.filename).toLowerCase());
}

const sections: string[] = ['# Attachment Content', ''];
const retrieved: string[] = [];
const unretrieved: { filename: string; reason: string }[] = [];

for (const att of inventory) {
  if (!att.url) {
    console.log(`  · ${att.filename}: skipped (no download URL)`);
    unretrieved.push({ filename: att.filename, reason: 'no download URL' });
    continue;
  }
  const destPath = join(attachmentsDir, att.filename);
  const input = JSON.stringify({ action: 'downloadAttachment', url: att.url, destPath });

  try {
    const { stdout } = await execFileAsync('bun', ['/home/user/Archon/.archon/scripts/jira-tool.js', input], {
      maxBuffer: 50 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      console.log(`  ✗ ${att.filename}: ${parsed.error ?? 'failed'}`);
      unretrieved.push({ filename: att.filename, reason: parsed.error ?? 'unknown failure' });
      continue;
    }

    if (isTextLike(att)) {
      const content = await readFile(destPath, 'utf8');
      sections.push(`## ${att.filename}`, '', '```', content, '```', '');
      retrieved.push(att.filename);
      console.log(`  ✓ ${att.filename}: downloaded ${parsed.result.bytes} bytes (text — inlined into attachments.md)`);
    } else {
      console.log(`  ✓ ${att.filename}: downloaded ${parsed.result.bytes} bytes (binary — saved, not inlined)`);
      unretrieved.push({
        filename: att.filename,
        reason: `binary content type "${att.contentType ?? 'unknown'}" — saved to disk at ${destPath}`,
      });
    }
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    console.log(`  ✗ ${att.filename}: ${err.message ?? 'failed'}`);
    unretrieved.push({ filename: att.filename, reason: err.stdout ?? err.message ?? String(e) });
  }
}

if (unretrieved.length > 0) {
  sections.push('## Unretrieved Attachments', '');
  for (const u of unretrieved) {
    sections.push(`- \`${u.filename}\`: ${u.reason}`);
  }
  sections.push('');
}

const outPath = join(artifactsDir, 'attachments.md');
await writeFile(outPath, sections.join('\n'));
console.log(`Wrote attachments.md (${retrieved.length} of ${inventory.length} attachments inlined).`);
console.log('Attachment fetch complete.');

process.stdout.write(
  '\n' +
    JSON.stringify({
      attachments_md: outPath,
      downloaded: retrieved.length,
      unretrieved: unretrieved.length,
      total: inventory.length,
    })
);
