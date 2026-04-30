#!/usr/bin/env bun
/**
 * One-shot recovery: walk every issue in $ARTIFACTS_DIR/task-keymap.json and
 * delete every Blocks-type issuelink on each. Used to clean up an inverted
 * dependency graph before re-running jira-create-blocks-links.ts with the
 * correct direction.
 *
 * Idempotent: subsequent runs find no Blocks links and exit cleanly.
 *
 * stdout: { deleted, scanned, total_keys }
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

const keymap: Record<string, string> = JSON.parse(
  await readFile(`${artifactsDir}/task-keymap.json`, 'utf8')
);
const issueKeys = Object.values(keymap);

console.log(`Scanning ${issueKeys.length} issues for Blocks-type links...`);

async function callJiraTool(input: object): Promise<{ result: unknown }> {
  const json = JSON.stringify(input);
  try {
    const { stdout } = await execFileAsync('bun', ['/home/user/Archon/.archon/scripts/jira-tool.js', json], {
      maxBuffer: 50 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok: boolean; result: unknown; error?: string };
    if (!parsed.ok) throw new Error(parsed.error ?? stdout);
    return { result: parsed.result };
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    throw new Error(err.stdout ?? err.message ?? String(e));
  }
}

interface JiraIssueLink {
  id: string;
  type: { name: string };
}
interface JiraIssue {
  key: string;
  fields: {
    issuelinks?: JiraIssueLink[];
  };
}

const linkIds = new Set<string>();
let scanned = 0;

for (const key of issueKeys) {
  const { result } = await callJiraTool({
    action: 'getIssue',
    issueKey: key,
    fields: ['issuelinks'],
  });
  scanned += 1;
  const issue = result as JiraIssue;
  for (const link of issue.fields.issuelinks ?? []) {
    if (link.type?.name === 'Blocks') {
      linkIds.add(link.id);
    }
  }
}

console.log(`Found ${linkIds.size} unique Blocks links to delete (across ${scanned} issues).`);

if (linkIds.size === 0) {
  console.log('Nothing to delete.');
  process.stdout.write(
    '\n' + JSON.stringify({ deleted: 0, scanned, total_keys: issueKeys.length, note: 'no Blocks links found' })
  );
  process.exit(0);
}

const operations = Array.from(linkIds).map(linkId => ({
  action: 'deleteIssueLink' as const,
  linkId,
}));

console.log(`Deleting ${operations.length} links in a batch...`);
const { result } = await callJiraTool({ action: 'batch', operations });
const batchResult = result as { count: number; results: Array<{ ok: boolean; result?: { deleted?: boolean } }> };

const deleted = batchResult.results.filter(r => r.ok).length;
const failed = batchResult.results.length - deleted;

await writeFile(
  `${artifactsDir}/blocks-links-deletion-report.json`,
  JSON.stringify(batchResult, null, 2)
);

console.log(`Deleted ${deleted} links; ${failed} failed.`);
process.stdout.write(
  '\n' +
    JSON.stringify({
      deleted,
      failed,
      scanned,
      total_keys: issueKeys.length,
    })
);
