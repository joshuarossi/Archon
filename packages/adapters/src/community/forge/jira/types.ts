/**
 * Jira webhook event types
 *
 * Jira uses `webhookEvent` to discriminate events. Comment payloads embed `comment`
 * alongside `issue`; issue updates carry a `changelog.items[]` describing field deltas.
 *
 * Comment bodies arrive as either a plain string OR an Atlassian Document Format (ADF)
 * document; this module exports `extractPlainText()` for best-effort flattening.
 */

// --- ADF (Atlassian Document Format) sub-types ---

export interface AdfTextNode {
  type: 'text';
  text: string;
  marks?: unknown[];
}

export interface AdfBlockNode {
  type: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

export type AdfNode = AdfTextNode | AdfBlockNode;

export interface AdfDocument {
  type: 'doc';
  version: number;
  content: AdfNode[];
}

// --- Shared sub-types ---

export interface JiraUser {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
}

export interface JiraStatus {
  name: string;
  id?: string;
}

export interface JiraIssueType {
  name: string;
  id?: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssueFields {
  summary: string;
  description?: AdfDocument | string | null;
  status?: JiraStatus;
  issuetype?: JiraIssueType;
  reporter?: JiraUser;
  assignee?: JiraUser | null;
  project?: JiraProject;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
}

// --- Comment ---

export interface JiraCommentBody {
  id: string;
  /** Body is ADF document on cloud REST v3, but can be plain string in older schemas. */
  body: AdfDocument | string;
  author?: JiraUser;
  created?: string;
  updated?: string;
}

// --- Changelog (issue updates) ---

export interface JiraChangelogItem {
  field: string;
  fieldtype?: string;
  fromString: string | null;
  toString: string | null;
  from?: string | null;
  to?: string | null;
}

export interface JiraChangelog {
  id?: string;
  items: JiraChangelogItem[];
}

// --- Webhook event ---

/**
 * Common fields for all Jira webhook events. The `webhookEvent` field
 * discriminates handlers; cloud Jira sends `comment_created`, `jira:issue_created`,
 * `jira:issue_updated`, `jira:issue_deleted`, etc.
 */
export interface JiraWebhookEvent {
  webhookEvent: string;
  /** Issue update events also include `issue_event_type_name` (e.g. `issue_generic`, `issue_assigned`). */
  issue_event_type_name?: string;
  timestamp?: number;
  /**
   * The acting user. Cloud webhooks include `user` for issue events; comment
   * events typically include the author inside `comment.author` instead.
   */
  user?: JiraUser;
  issue?: JiraIssue;
  comment?: JiraCommentBody;
  changelog?: JiraChangelog;
}

// --- ADF helpers ---

/**
 * Best-effort flatten of an ADF document (or string) to plain text.
 * Walks the node tree concatenating any `text` leaves with single spaces between
 * adjacent block boundaries. Returns `String(value)` for unknown shapes so
 * downstream code (e.g. `@mention` detection) always receives a usable string.
 */
export function extractPlainText(value: AdfDocument | string | null | undefined): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);

  const parts: string[] = [];
  const walk = (node: AdfNode | AdfDocument): void => {
    if (!node || typeof node !== 'object') return;
    if ('type' in node && node.type === 'text' && typeof (node as AdfTextNode).text === 'string') {
      parts.push((node as AdfTextNode).text);
      return;
    }
    const content = (node as AdfBlockNode | AdfDocument).content;
    if (Array.isArray(content)) {
      for (const child of content) walk(child);
      // Add a separator between block-level siblings so adjacent paragraphs don't fuse.
      if ('type' in node && node.type !== 'text') parts.push(' ');
    }
  };
  walk(value);

  return parts.join('').replace(/\s+/g, ' ').trim();
}
