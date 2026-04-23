const { access, readFile } = require('fs/promises');
const { constants } = require('fs');

function assertIssueKey(issueKey) {
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(issueKey)) {
    throw new Error(`Invalid Jira issue key: ${issueKey}`);
  }
}

function buildAuthHeader() {
  const email = process.env.JIRA_EMAIL ?? '';
  const token = process.env.JIRA_API_TOKEN ?? '';
  if (!email || !token) {
    throw new Error('Missing JIRA_EMAIL or JIRA_API_TOKEN env vars');
  }
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

function getBaseUrl() {
  const base = process.env.JIRA_BASE_URL ?? '';
  if (!base) throw new Error('Missing JIRA_BASE_URL env var');
  return base.replace(/\/+$/, '');
}

async function jiraRequest(path, init = {}) {
  const url = `${getBaseUrl()}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: buildAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jira API ${response.status} ${response.statusText}: ${text}`);
  }

  if (response.status === 204) {
    return undefined;
  }
  return await response.json();
}

async function runGetIssue(input) {
  assertIssueKey(input.issueKey);
  if (input.dryRun) {
    return {
      dryRun: true,
      action: input.action,
      issueKey: input.issueKey,
      fields: input.fields ?? [],
    };
  }
  const fieldParam = input.fields && input.fields.length > 0 ? `?fields=${input.fields.join(',')}` : '';
  return await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(input.issueKey)}${fieldParam}`);
}

async function runAddComment(input) {
  assertIssueKey(input.issueKey);
  if (input.dryRun) {
    return {
      dryRun: true,
      action: input.action,
      issueKey: input.issueKey,
      text: input.text,
    };
  }
  return await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`, {
    method: 'POST',
    body: JSON.stringify({
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: input.text }] }],
      },
    }),
  });
}

async function runTransitionIssue(input) {
  assertIssueKey(input.issueKey);
  if (input.dryRun) {
    return {
      dryRun: true,
      action: input.action,
      issueKey: input.issueKey,
      toStatus: input.toStatus,
    };
  }

  const transitions = await jiraRequest(
    `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/transitions`
  );
  const match = transitions.transitions.find(t => t.name.toLowerCase() === input.toStatus.toLowerCase());
  if (!match) {
    throw new Error(
      `Transition "${input.toStatus}" not available for ${input.issueKey}. Available: ${transitions.transitions.map(t => t.name).join(', ')}`
    );
  }

  await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: match.id } }),
  });

  return { transitioned: true, issueKey: input.issueKey, toStatus: input.toStatus, transitionId: match.id };
}

async function runOperation(input) {
  switch (input.action) {
    case 'getIssue':
      return await runGetIssue(input);
    case 'addComment':
      return await runAddComment(input);
    case 'transitionIssue':
      return await runTransitionIssue(input);
    case 'batch': {
      const results = [];
      for (let i = 0; i < input.operations.length; i += 1) {
        const op = input.operations[i];
        try {
          const result = await runOperation({ ...op, dryRun: input.dryRun ?? op.dryRun });
          results.push({ index: i, action: op.action, ok: true, result });
        } catch (error) {
          const err = error;
          results.push({ index: i, action: op.action, ok: false, error: err.message });
          throw new Error(`Batch operation ${i} (${op.action}) failed: ${err.message}`);
        }
      }
      return { ok: true, count: input.operations.length, results };
    }
    default:
      throw new Error(`Unsupported action: ${input.action}`);
  }
}

async function main() {
  const fromArg = process.argv[2];
  const fromEnv = process.env.JIRA_TOOL_INPUT;
  let fromFile;
  const artifactsDir = process.env.ARTIFACTS_DIR;
  const inputPath = process.env.JIRA_TOOL_INPUT_FILE ?? (artifactsDir ? `${artifactsDir}/jira-tool-input.json` : '');

  if (!fromArg && !fromEnv && inputPath) {
    try {
      await access(inputPath, constants.F_OK);
      fromFile = await readFile(inputPath, 'utf8');
    } catch {
      // no-op; file-based input is optional
    }
  }

  const raw = fromArg ?? fromEnv ?? fromFile;
  if (!raw) {
    throw new Error(
      'Missing input JSON. Pass argv[2], set JIRA_TOOL_INPUT, or write $ARTIFACTS_DIR/jira-tool-input.json'
    );
  }
  const input = JSON.parse(raw);
  const result = await runOperation(input);
  process.stdout.write(JSON.stringify({ ok: true, action: input.action, result }));
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});
