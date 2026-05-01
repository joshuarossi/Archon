#!/usr/bin/env bun
/**
 * Upload decomposition-plan.md as an attachment on the Epic and add a confirmation
 * comment. Replaces the agent+MCP attach-plan-to-epic node.
 *
 * Inputs (read):
 *   $ARTIFACTS_DIR/trigger-payload.json — Epic key
 *   $ARTIFACTS_DIR/decomposition-plan.md — file to upload
 *
 * stdout: { attached, attachmentId, comment_posted }
 */
import { readFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function waitForFile(p: string, attempts = 5, delayMs = 500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await access(p);
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT' || i === attempts - 1) throw e;
      console.log(`  (waiting for ${p}, attempt ${i + 1}/${attempts}...)`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

interface TriggerPayload {
  issue_key: string;
}
const trigger: TriggerPayload = JSON.parse(await readFile(`${artifactsDir}/trigger-payload.json`, 'utf8'));
await waitForFile(`${artifactsDir}/decomposition-plan.md`);
console.log(`Uploading decomposition-plan.md as attachment on Epic ${trigger.issue_key}...`);

async function callJiraTool(input: object): Promise<unknown> {
  const json = JSON.stringify(input);
  try {
    const { stdout } = await execFileAsync('bun', ['/home/user/Archon/.archon/scripts/jira-tool.js', json], {
      maxBuffer: 50 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok: boolean; result: unknown; error?: string };
    if (!parsed.ok) throw new Error(parsed.error ?? stdout);
    return parsed.result;
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    throw new Error(err.stdout ?? err.message ?? String(e));
  }
}

const attached = (await callJiraTool({
  action: 'addAttachment',
  issueKey: trigger.issue_key,
  filePath: `${artifactsDir}/decomposition-plan.md`,
  filename: 'decomposition-plan.md',
})) as { attached: boolean; attachmentId: string; filename: string; size: number };
console.log(`Attached: ${attached.filename} (id ${attached.attachmentId}, ${attached.size} bytes).`);

console.log('Posting confirmation comment on Epic...');
await callJiraTool({
  action: 'addComment',
  issueKey: trigger.issue_key,
  text: 'Epic decomposition plan attached: decomposition-plan.md',
});
console.log('Comment posted.');

process.stdout.write(
  '\n' +
    JSON.stringify({
      attached: attached.attached,
      attachmentId: attached.attachmentId,
      comment_posted: true,
      epic_key: trigger.issue_key,
    })
);
