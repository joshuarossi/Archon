const { access, readFile, writeFile, mkdir } = require('fs/promises');
const { constants } = require('fs');
const path = require('path');

function assertIssueKey(issueKey) {
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(issueKey)) {
    throw new Error(`Invalid Jira issue key: ${issueKey}`);
  }
}

function buildAuthHeader() {
  const email = process.env.JIRA_USER_EMAIL ?? process.env.JIRA_EMAIL ?? '';
  const token = process.env.JIRA_API_TOKEN ?? '';
  if (!email || !token) {
    throw new Error('Missing JIRA_USER_EMAIL (or legacy JIRA_EMAIL) or JIRA_API_TOKEN env vars');
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

/**
 * Convert a markdown-ish string to a minimal Atlassian Document Format doc.
 * Supports: paragraphs (blank-line separated), '- ' bullet lists, '## ' headings,
 * inline `code`, fenced ```code blocks```. Anything else passes through as text.
 *
 * Intentionally minimal — Jira's ADF surface is huge and we only need enough
 * to render readable ticket descriptions and comments.
 */
function mdToAdf(md) {
  const text = String(md ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;

  const inlineToNodes = s => {
    const nodes = [];
    const re = /`([^`]+)`/g;
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) nodes.push({ type: 'text', text: s.slice(last, m.index) });
      nodes.push({ type: 'text', text: m[1], marks: [{ type: 'code' }] });
      last = m.index + m[0].length;
    }
    if (last < s.length) nodes.push({ type: 'text', text: s.slice(last) });
    return nodes.length === 0 ? [{ type: 'text', text: s }] : nodes;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines between blocks.
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Fenced code block.
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      i += 1;
      const buf = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing fence
      blocks.push({
        type: 'codeBlock',
        ...(lang ? { attrs: { language: lang } } : {}),
        content: [{ type: 'text', text: buf.join('\n') }],
      });
      continue;
    }

    // Heading (## or ###; treated as level 2/3).
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 6);
      blocks.push({
        type: 'heading',
        attrs: { level },
        content: inlineToNodes(headingMatch[2]),
      });
      i += 1;
      continue;
    }

    // Bullet list — collect contiguous '- ' lines.
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^[-*]\s+/, '');
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: inlineToNodes(itemText) }],
        });
        i += 1;
      }
      blocks.push({ type: 'bulletList', content: items });
      continue;
    }

    // Paragraph — collect contiguous non-blank, non-special lines.
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'paragraph', content: inlineToNodes(buf.join(' ')) });
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph', content: [{ type: 'text', text: '' }] });
  }

  return { type: 'doc', version: 1, content: blocks };
}

async function runCreateIssue(input) {
  if (input.dryRun) {
    return {
      dryRun: true,
      action: input.action,
      project: input.project,
      summary: input.summary,
      issuetype: input.issuetype,
      parentKey: input.parentKey,
      labels: input.labels ?? [],
    };
  }

  if (!input.project) throw new Error('createIssue requires `project`');
  if (!input.summary) throw new Error('createIssue requires `summary`');
  if (!input.issuetype) throw new Error('createIssue requires `issuetype`');

  const fields = {
    project: { key: input.project },
    summary: input.summary,
    issuetype: { name: input.issuetype },
  };

  if (input.descriptionMarkdownFile !== undefined) {
    const md = await readFile(input.descriptionMarkdownFile, 'utf8');
    fields.description = mdToAdf(md);
  } else if (input.descriptionMarkdown !== undefined) {
    fields.description = mdToAdf(input.descriptionMarkdown);
  } else if (input.descriptionAdf !== undefined) {
    fields.description = input.descriptionAdf;
  }

  if (input.parentKey) {
    fields.parent = { key: input.parentKey };
  }

  if (Array.isArray(input.labels) && input.labels.length > 0) {
    fields.labels = input.labels;
  }

  if (typeof input.originalEstimateMinutes === 'number' && input.originalEstimateMinutes > 0) {
    // Jira accepts a string like "45m" or seconds; using seconds avoids ambiguity.
    fields.timetracking = {
      originalEstimate: `${input.originalEstimateMinutes}m`,
    };
  }

  const created = await jiraRequest('/rest/api/3/issue', {
    method: 'POST',
    body: JSON.stringify({ fields }),
  });

  return {
    created: true,
    issueKey: created.key,
    issueId: created.id,
    self: created.self,
  };
}

async function runCreateIssueLink(input) {
  assertIssueKey(input.inwardIssueKey);
  assertIssueKey(input.outwardIssueKey);
  if (input.dryRun) {
    return {
      dryRun: true,
      action: input.action,
      linkType: input.linkType,
      inwardIssueKey: input.inwardIssueKey,
      outwardIssueKey: input.outwardIssueKey,
    };
  }
  if (!input.linkType) throw new Error('createIssueLink requires `linkType` (e.g. "Blocks")');

  await jiraRequest('/rest/api/3/issueLink', {
    method: 'POST',
    body: JSON.stringify({
      type: { name: input.linkType },
      inwardIssue: { key: input.inwardIssueKey },
      outwardIssue: { key: input.outwardIssueKey },
    }),
  });

  return {
    linked: true,
    linkType: input.linkType,
    inwardIssueKey: input.inwardIssueKey,
    outwardIssueKey: input.outwardIssueKey,
  };
}

/**
 * Download an attachment by URL (Jira's `attachment.content` URL from issue.fields.attachment[]).
 * Follows redirects (Atlassian usually redirects to a signed S3-style URL — that one
 * MUST NOT carry the Authorization header, or the signature check fails). We do this
 * by fetching with `redirect: 'manual'`, then refetching the redirect target without auth.
 *
 * Input: { action, url, destPath }  (destPath optional; defaults to $ARTIFACTS_DIR/attachments/<basename of url>)
 * Output: { downloaded: true, destPath, bytes, contentType }
 */
async function runDownloadAttachment(input) {
  if (input.dryRun) {
    return { dryRun: true, action: input.action, url: input.url, destPath: input.destPath };
  }
  if (!input.url) throw new Error('downloadAttachment requires `url`');

  const initialResponse = await fetch(input.url, {
    method: 'GET',
    redirect: 'manual',
    headers: { Authorization: buildAuthHeader() },
  });

  let bodyResponse = initialResponse;
  if (initialResponse.status >= 300 && initialResponse.status < 400) {
    const location = initialResponse.headers.get('location');
    if (!location) {
      throw new Error(`Attachment redirect with no Location header (status ${initialResponse.status})`);
    }
    // Pre-signed redirect — fetch WITHOUT auth header (S3 signed URLs reject Basic auth).
    bodyResponse = await fetch(location, { method: 'GET' });
  }

  if (!bodyResponse.ok) {
    const text = await bodyResponse.text();
    throw new Error(`Attachment download ${bodyResponse.status} ${bodyResponse.statusText}: ${text.slice(0, 500)}`);
  }

  const buffer = Buffer.from(await bodyResponse.arrayBuffer());
  const contentType = bodyResponse.headers.get('content-type') ?? 'application/octet-stream';

  const dest = input.destPath ?? (() => {
    const artifactsDir = process.env.ARTIFACTS_DIR;
    if (!artifactsDir) throw new Error('ARTIFACTS_DIR not set and destPath not provided');
    const base = path.basename(new URL(input.url).pathname) || 'attachment';
    return path.join(artifactsDir, 'attachments', base);
  })();

  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buffer);

  return { downloaded: true, destPath: dest, bytes: buffer.length, contentType };
}

/**
 * Upload a file as a Jira attachment on an issue.
 * Required header: X-Atlassian-Token: no-check (Jira's XSRF bypass for uploads).
 * Multipart form-data with field name "file".
 *
 * Input: { action, issueKey, filePath, filename? }
 * Output: { attached: true, attachmentId, filename, size, contentType }
 */
async function runAddAttachment(input) {
  assertIssueKey(input.issueKey);
  if (input.dryRun) {
    return {
      dryRun: true,
      action: input.action,
      issueKey: input.issueKey,
      filePath: input.filePath,
      filename: input.filename,
    };
  }
  if (!input.filePath) throw new Error('addAttachment requires `filePath`');

  const fileBuffer = await readFile(input.filePath);
  const filename = input.filename ?? path.basename(input.filePath);

  const form = new FormData();
  // Bun/Node global FormData accepts a Blob; build one from the buffer.
  const blob = new Blob([fileBuffer]);
  form.append('file', blob, filename);

  const url = `${getBaseUrl()}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/attachments`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: buildAuthHeader(),
      Accept: 'application/json',
      'X-Atlassian-Token': 'no-check',
      // Don't set Content-Type — fetch sets multipart boundary automatically.
    },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jira attach ${response.status} ${response.statusText}: ${text}`);
  }
  const data = await response.json();
  // The API returns an array (one entry per uploaded file).
  const first = Array.isArray(data) ? data[0] : data;
  return {
    attached: true,
    attachmentId: first?.id,
    filename: first?.filename ?? filename,
    size: first?.size ?? fileBuffer.length,
    contentType: first?.mimeType,
  };
}

/**
 * Log work against an issue (POST /rest/api/3/issue/{key}/worklog).
 * Feeds Jira's `timespent` field and time-tracking reports.
 *
 * Input: { action, issueKey, timeSpentSeconds, comment? }
 * Output: { logged: true, worklogId, issueKey, timeSpentSeconds, comment }
 */
async function runAddWorklog(input) {
  assertIssueKey(input.issueKey);
  if (input.dryRun) {
    return {
      dryRun: true,
      action: input.action,
      issueKey: input.issueKey,
      timeSpentSeconds: input.timeSpentSeconds,
      comment: input.comment,
    };
  }
  if (typeof input.timeSpentSeconds !== 'number' || input.timeSpentSeconds <= 0) {
    throw new Error('addWorklog requires positive `timeSpentSeconds`');
  }
  // Jira's worklog API rejects entries smaller than 60 seconds (the minimum displayable unit).
  // Round up to 60s minimum.
  const seconds = Math.max(60, Math.round(input.timeSpentSeconds));

  const body = {
    timeSpentSeconds: seconds,
  };
  if (typeof input.comment === 'string' && input.comment.length > 0) {
    body.comment = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: input.comment }] }],
    };
  }

  const result = await jiraRequest(
    `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/worklog`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );

  return {
    logged: true,
    worklogId: result?.id,
    issueKey: input.issueKey,
    timeSpentSeconds: seconds,
    comment: input.comment ?? null,
  };
}

async function runDeleteIssue(input) {
  assertIssueKey(input.issueKey);
  if (input.dryRun) {
    return { dryRun: true, action: input.action, issueKey: input.issueKey };
  }
  // deleteSubtasks=true cleans up subtasks atomically; harmless if there are none.
  await jiraRequest(
    `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}?deleteSubtasks=true`,
    { method: 'DELETE' }
  );
  return { deleted: true, issueKey: input.issueKey };
}

async function runDeleteIssueLink(input) {
  if (input.dryRun) {
    return { dryRun: true, action: input.action, linkId: input.linkId };
  }
  if (!input.linkId) throw new Error('deleteIssueLink requires `linkId`');
  await jiraRequest(`/rest/api/3/issueLink/${encodeURIComponent(input.linkId)}`, {
    method: 'DELETE',
  });
  return { deleted: true, linkId: input.linkId };
}

async function runEditLabels(input) {
  assertIssueKey(input.issueKey);
  if (input.dryRun) {
    return {
      dryRun: true,
      action: input.action,
      issueKey: input.issueKey,
      add: input.add ?? [],
      remove: input.remove ?? [],
    };
  }

  const ops = [];
  if (Array.isArray(input.add)) {
    for (const value of input.add) ops.push({ add: value });
  }
  if (Array.isArray(input.remove)) {
    for (const value of input.remove) ops.push({ remove: value });
  }
  if (ops.length === 0) {
    return { edited: false, issueKey: input.issueKey, reason: 'no add/remove labels supplied' };
  }

  await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(input.issueKey)}`, {
    method: 'PUT',
    body: JSON.stringify({ update: { labels: ops } }),
  });

  return {
    edited: true,
    issueKey: input.issueKey,
    add: input.add ?? [],
    remove: input.remove ?? [],
  };
}

async function runOperation(input) {
  switch (input.action) {
    case 'getIssue':
      return await runGetIssue(input);
    case 'addComment':
      return await runAddComment(input);
    case 'transitionIssue':
      return await runTransitionIssue(input);
    case 'createIssue':
      return await runCreateIssue(input);
    case 'createIssueLink':
      return await runCreateIssueLink(input);
    case 'deleteIssueLink':
      return await runDeleteIssueLink(input);
    case 'editLabels':
      return await runEditLabels(input);
    case 'deleteIssue':
      return await runDeleteIssue(input);
    case 'addWorklog':
      return await runAddWorklog(input);
    case 'downloadAttachment':
      return await runDownloadAttachment(input);
    case 'addAttachment':
      return await runAddAttachment(input);
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
