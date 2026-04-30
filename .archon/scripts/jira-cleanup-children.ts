#!/usr/bin/env bun
/**
 * Cleanup helper for re-running epic-decompose.
 *
 * Lists or deletes all child Tasks of a given Epic. By default, scopes to tasks
 * created by the Archon decomposer (heuristic: presence of an "archon-blocked-pending"
 * label OR a status of Backlog/Selected for Development with no comments-from-humans).
 *
 * Usage:
 *   bun .archon/scripts/jira-cleanup-children.ts <EPIC-KEY> [--dry-run] [--force]
 *
 * Modes:
 *   --dry-run         (default if neither flag given) just lists what would be deleted
 *   --force           actually delete (must be passed explicitly)
 *   --include-done    also delete children already in Done status (default: skip)
 *   --no-label-filter delete every child Task regardless of label (DANGEROUS)
 *
 * Examples:
 *   bun .archon/scripts/jira-cleanup-children.ts WOR-5
 *   bun .archon/scripts/jira-cleanup-children.ts WOR-5 --force
 *   bun .archon/scripts/jira-cleanup-children.ts WOR-5 --force --no-label-filter
 *
 * Auth: reads JIRA_USER_EMAIL (or JIRA_EMAIL), JIRA_API_TOKEN, JIRA_BASE_URL from env.
 */

const args = process.argv.slice(2);
const epicKey = args.find(a => !a.startsWith('--'));
const dryRun = !args.includes('--force');
const includeDone = args.includes('--include-done');
const noLabelFilter = args.includes('--no-label-filter');

if (!epicKey) {
  console.error('Usage: jira-cleanup-children.ts <EPIC-KEY> [--force] [--include-done] [--no-label-filter]');
  process.exit(2);
}
if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(epicKey)) {
  console.error(`Invalid Jira key: ${epicKey}`);
  process.exit(2);
}

function buildAuthHeader() {
  const email = process.env.JIRA_USER_EMAIL ?? process.env.JIRA_EMAIL ?? '';
  const token = process.env.JIRA_API_TOKEN ?? '';
  if (!email || !token) {
    throw new Error('Missing JIRA_USER_EMAIL (or JIRA_EMAIL) or JIRA_API_TOKEN env vars');
  }
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

function getBaseUrl() {
  const base = process.env.JIRA_BASE_URL ?? '';
  if (!base) throw new Error('Missing JIRA_BASE_URL env var');
  return base.replace(/\/+$/, '');
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status?: { name: string };
    labels?: string[];
    issuetype?: { name: string };
  };
}

async function jiraRequest<T>(path: string, init: RequestInit = {}): Promise<T | undefined> {
  const url = `${getBaseUrl()}${path}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', buildAuthHeader());
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jira API ${response.status} ${response.statusText}: ${text}`);
  }
  if (response.status === 204) return undefined;
  return (await response.json()) as T;
}

interface SearchResponse {
  issues: JiraIssue[];
  nextPageToken?: string;
}

async function searchChildren(epic: string): Promise<JiraIssue[]> {
  const all: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const url = new URL('/rest/api/3/search/jql', getBaseUrl());
    url.searchParams.set('jql', `parent = "${epic}"`);
    url.searchParams.set('fields', 'summary,status,labels,issuetype');
    url.searchParams.set('maxResults', '100');
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
    const path = url.pathname + url.search;
    const data = await jiraRequest<SearchResponse>(path);
    if (data?.issues) all.push(...data.issues);
    nextPageToken = data?.nextPageToken;
  } while (nextPageToken);
  return all;
}

async function deleteIssue(key: string): Promise<void> {
  await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(key)}?deleteSubtasks=true`, {
    method: 'DELETE',
  });
}

const allChildren = await searchChildren(epicKey);
console.error(`Found ${allChildren.length} children of ${epicKey}.`);

const toDelete = allChildren.filter(issue => {
  const status = issue.fields.status?.name ?? '';
  const labels = issue.fields.labels ?? [];
  if (!includeDone && status.toLowerCase() === 'done') return false;
  if (noLabelFilter) return true;
  return labels.includes('archon-blocked-pending');
});

console.error(
  `${toDelete.length} match deletion criteria` +
    (noLabelFilter ? ' (no label filter)' : ' (label: archon-blocked-pending)') +
    (includeDone ? ' [including Done]' : ' [skipping Done]') +
    '.'
);

const summary = {
  epic: epicKey,
  totalChildren: allChildren.length,
  matched: toDelete.length,
  dryRun,
  filterLabel: noLabelFilter ? null : 'archon-blocked-pending',
  includeDone,
  deleted: [] as string[],
  skipped: allChildren
    .filter(c => !toDelete.includes(c))
    .map(c => ({ key: c.key, status: c.fields.status?.name, labels: c.fields.labels })),
  errors: [] as { key: string; error: string }[],
  candidates: toDelete.map(c => ({
    key: c.key,
    summary: c.fields.summary,
    status: c.fields.status?.name,
    labels: c.fields.labels,
  })),
};

if (dryRun) {
  console.error('[dry-run] would delete:');
  for (const c of toDelete) {
    console.error(`  - ${c.key}  [${c.fields.status?.name ?? '?'}]  ${c.fields.summary}`);
  }
  console.error('Pass --force to actually delete.');
  process.stdout.write(JSON.stringify(summary));
  process.exit(0);
}

for (const c of toDelete) {
  try {
    await deleteIssue(c.key);
    summary.deleted.push(c.key);
    console.error(`  deleted ${c.key}`);
  } catch (e) {
    const err = e as Error;
    summary.errors.push({ key: c.key, error: err.message });
    console.error(`  FAILED ${c.key}: ${err.message}`);
  }
}

process.stdout.write(JSON.stringify(summary));
process.exit(summary.errors.length > 0 ? 1 : 0);
