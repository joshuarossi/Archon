/**
 * Jira platform adapter using REST API v3 and webhooks.
 *
 * Community forge adapter — see packages/adapters/src/community/forge/README.md
 *
 * Translates four Jira webhook event types into a single deterministic slash
 * command, `/workflow run jira-router <base64>`, and hands it off to the
 * existing orchestrator dispatch path. All routing logic lives in the
 * user-authored `jira-router.yaml` workflow — this adapter has no knowledge
 * of which downstream workflow should run for which event.
 *
 * Handled events (when the issue's project key is mapped to a registered
 * Archon codebase):
 *   - jira:issue_created                      → event: "created"
 *   - jira:issue_updated (status changelog)   → event: "transition"
 *   - jira:issue_updated (summary/description)→ event: "content_changed"
 *   - comment_created                         → event: "comment_created"
 *
 * The JSON payload is base64-encoded before being appended as the sole
 * argument to the router command. This keeps the argument as a single
 * whitespace-free token, making it immune to the orchestrator tokenizer's
 * `\S+` / `"[^"]+"` alternation, which would otherwise corrupt JSON values
 * that end with whitespace (e.g. summary "PROJ-504 " would cause the
 * tokenizer to match the subsequent `","` separator as a quoted token and
 * dequote it to `,`, producing invalid JSON). In `jira-router.yaml`, decode
 * with `Buffer.from($1, 'base64').toString('utf8')` before parsing.
 *
 * Self-triggering is prevented for comment events via an optional
 * `botAccountId` match. Configure `JIRA_BOT_ACCOUNT_ID` (or
 * `jira.bot_account_id` in config.yaml) to enable this guard; without it,
 * the adapter cannot distinguish bot-authored comments from human comments.
 *
 * Authorization (optional) is enforced at the event level via
 * JIRA_ALLOWED_ACCOUNT_IDS — empty list means open access.
 *
 * Codebase resolution is explicit: Jira project keys map to registered
 * Archon codebase names via `jira.projects` in `~/.archon/config.yaml`
 * (or `.archon/config.yaml`). Unmapped projects log a warning and abort.
 *
 * Concurrency: each webhook HTTP delivery uses a distinct platform
 * conversation id (`issueKey::deliveryToken`) so isolation does not reuse the
 * prior row's `isolation_env_id` / working_path across overlapping runs for the
 * same Jira issue.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import {
  ConversationNotFoundError,
  handleMessage,
  classifyAndFormatError,
  toError,
} from '@archon/core';
import { createLogger } from '@archon/paths';
import * as db from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import { isJiraUserAuthorized } from './auth';
import { splitIntoParagraphChunks } from '../../../utils/message-splitting';
import {
  extractPlainText,
  type AdfDocument,
  type JiraChangelogItem,
  type JiraIssue,
  type JiraWebhookEvent,
} from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.jira');
  return cachedLog;
}

const MAX_LENGTH = 32000; // Practical limit for Jira comments

/** Project key format: uppercase alphanumeric + underscore, hyphen, then digits */
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/;

/** Separates Jira issue key from per-delivery suffix in `platform_conversation_id`. */
const CONVERSATION_DELIVERY_SEPARATOR = '::';

/**
 * Router workflow that every Jira webhook dispatches to. Must exist as
 * `jira-router.yaml` in the user's workflow directories (repo or
 * `~/.archon/.archon/workflows/`). Not shipped as a bundled default —
 * deliberately user-authored content, since the routing logic is a
 * per-organization SDLC contract, not adapter code.
 */
const ROUTER_WORKFLOW_NAME = 'jira-router';

export interface JiraAdapterOptions {
  botAccountId?: string;
  allowedAccountIds?: string[];
  /** Map of Jira project key (e.g. "PROJ") → registered codebase name. */
  projectCodebaseMap?: Record<string, string>;
}

/** Optional HTTP metadata for correlating adapter logs with `/webhooks/jira` requests. */
export interface JiraWebhookIngestMeta {
  /** Value of `x-atlassian-webhook-identifier` when present. */
  atlassianWebhookId?: string;
}

interface ParsedCommentEvent {
  kind: 'comment_created';
  issue: JiraIssue;
  body: string;
  authorAccountId?: string;
}

interface ParsedCreatedEvent {
  kind: 'created';
  issue: JiraIssue;
}

interface ParsedTransitionEvent {
  kind: 'transition';
  issue: JiraIssue;
  fromStatus: string;
  toStatus: string;
  actor?: string;
}

interface ParsedContentChangedEvent {
  kind: 'content_changed';
  issue: JiraIssue;
  fields: { field: string; value: string }[];
  actor?: string;
}

type ParsedEvent =
  | ParsedCommentEvent
  | ParsedCreatedEvent
  | ParsedTransitionEvent
  | ParsedContentChangedEvent;

/** Structured JSON payload handed to the router workflow as its sole argument. */
interface RouterEventPayload {
  event: 'comment_created' | 'created' | 'transition' | 'content_changed';
  issue_key: string;
  project: string;
  issue_type?: string;
  summary: string;
  status?: string;
  from_status?: string;
  to_status?: string;
  /** Present for content_changed events: all fields changed in this update. */
  changes?: { field: string; new_value: string }[];
  comment_body?: string;
  author_account_id?: string;
  actor?: string;
}

/** Typed error carrying the HTTP status code from a failed Jira API call. */
class JiraApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}

export class JiraAdapter implements IPlatformAdapter {
  private readonly baseUrl: string;
  private readonly userEmail: string;
  private readonly apiToken: string;
  private readonly webhookSecret: string;
  private readonly authHeader: string;
  private readonly botAccountId: string | undefined;
  private readonly allowedAccountIds: string[];
  private readonly projectCodebaseMap: Record<string, string>;

  constructor(
    baseUrl: string,
    userEmail: string,
    apiToken: string,
    webhookSecret: string,
    options: JiraAdapterOptions = {}
  ) {
    if (!baseUrl) throw new Error('JiraAdapter requires a non-empty baseUrl');
    if (!userEmail) throw new Error('JiraAdapter requires a non-empty userEmail');
    if (!apiToken) throw new Error('JiraAdapter requires a non-empty apiToken');
    if (!webhookSecret) throw new Error('JiraAdapter requires a non-empty webhookSecret');

    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.userEmail = userEmail;
    this.apiToken = apiToken;
    this.webhookSecret = webhookSecret;
    this.botAccountId = options.botAccountId;
    this.allowedAccountIds = options.allowedAccountIds ?? [];
    this.projectCodebaseMap = options.projectCodebaseMap ?? {};

    this.authHeader =
      'Basic ' + Buffer.from(`${this.userEmail}:${this.apiToken}`).toString('base64');

    if (this.allowedAccountIds.length > 0) {
      getLog().info({ accountCount: this.allowedAccountIds.length }, 'jira.allowlist_enabled');
    } else {
      getLog().info('jira.allowlist_disabled');
    }

    if (!this.botAccountId) {
      getLog().warn(
        'jira.bot_account_id_not_configured — self-trigger prevention for comment events is disabled; set JIRA_BOT_ACCOUNT_ID or jira.bot_account_id in config.yaml'
      );
    }

    getLog().info(
      {
        baseUrl: this.baseUrl,
        botAccountIdConfigured: Boolean(this.botAccountId),
        mappedProjectCount: Object.keys(this.projectCodebaseMap).length,
      },
      'jira.adapter_initialized'
    );
  }

  // ---------------------------------------------------------------------------
  // IPlatformAdapter methods
  // ---------------------------------------------------------------------------

  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    const parsed = this.parseConversationId(conversationId);
    if (!parsed) {
      getLog().error({ conversationId }, 'jira.invalid_conversation_id');
      return;
    }

    getLog().debug({ conversationId, messageLength: message.length }, 'jira.send_message');

    if (message.length <= MAX_LENGTH) {
      await this.postComment(parsed.issueKey, message);
      return;
    }

    getLog().debug({ messageLength: message.length }, 'jira.message_splitting');
    const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 500);

    for (let i = 0; i < chunks.length; i++) {
      try {
        await this.postComment(parsed.issueKey, chunks[i]);
      } catch (error) {
        const err = error as Error;
        getLog().error(
          { err, chunkIndex: i + 1, totalChunks: chunks.length, conversationId },
          'jira.chunk_post_failed'
        );
        const partialError = new Error(
          `Failed to post comment chunk ${String(i + 1)}/${String(chunks.length)}. ` +
            `${String(i)} chunk(s) were posted before failure.`
        );
        partialError.cause = error;
        throw partialError;
      }
    }
  }

  getStreamingMode(): 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return 'jira';
  }

  async start(): Promise<void> {
    getLog().info('jira.webhook_adapter_ready');
  }

  stop(): void {
    getLog().info('jira.adapter_stopped');
  }

  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  // ---------------------------------------------------------------------------
  // Webhook signature verification (HMAC-SHA256, GitHub-style "sha256=..." prefix)
  // ---------------------------------------------------------------------------

  private verifySignature(payload: string, signature: string): boolean {
    try {
      const hmac = createHmac('sha256', this.webhookSecret);
      const digest = 'sha256=' + hmac.update(payload).digest('hex');

      const digestBuffer = Buffer.from(digest);
      const signatureBuffer = Buffer.from(signature);

      if (digestBuffer.length !== signatureBuffer.length) {
        getLog().error(
          { receivedLength: signatureBuffer.length, computedLength: digestBuffer.length },
          'jira.signature_length_mismatch'
        );
        return false;
      }

      const isValid = timingSafeEqual(digestBuffer, signatureBuffer);

      if (!isValid) {
        getLog().error(
          {
            receivedPrefix: signature.substring(0, 15) + '...',
            computedPrefix: digest.substring(0, 15) + '...',
          },
          'jira.signature_mismatch'
        );
      }

      return isValid;
    } catch (error) {
      const err = error as Error;
      getLog().error({ err }, 'jira.signature_verification_error');
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Jira REST API helper
  // ---------------------------------------------------------------------------

  private async jiraApi<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new JiraApiError(
        response.status,
        `Jira API ${method} ${path}: ${String(response.status)} ${response.statusText} - ${text}`
      );
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // ADF body construction (outbound)
  // ---------------------------------------------------------------------------

  /** Wrap a plain-text message in an ADF document. Each blank-line-separated block becomes a paragraph. */
  private toAdfDocument(message: string): AdfDocument {
    const paragraphs = message.split(/\n{2,}/).map(para => ({
      type: 'paragraph',
      content: [{ type: 'text', text: para }],
    }));
    return {
      type: 'doc',
      version: 1,
      content: paragraphs,
    };
  }

  // ---------------------------------------------------------------------------
  // Comment posting with retry
  // ---------------------------------------------------------------------------

  private isRetryableError(error: unknown): boolean {
    // HTTP errors: retry on rate-limit and server-side failures only.
    if (error instanceof JiraApiError) {
      return error.status === 429 || error.status >= 500;
    }
    // Transport-level errors (pre-response): retry on network failures.
    const err = error as Error | undefined;
    const message = err?.message ?? '';
    const causeErr = (error as { cause?: Error }).cause;
    const cause = causeErr?.message ?? '';
    const combined = `${message} ${cause}`.toLowerCase();
    return (
      combined.includes('timeout') ||
      combined.includes('econnrefused') ||
      combined.includes('econnreset') ||
      combined.includes('etimedout') ||
      combined.includes('fetch failed')
    );
  }

  private async postComment(issueKey: string, message: string): Promise<void> {
    const body = { body: this.toAdfDocument(message) };
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.jiraApi('POST', path, body);
        getLog().debug({ issueKey }, 'jira.comment_posted');
        return;
      } catch (error) {
        const isRetryable = this.isRetryableError(error);
        if (attempt < maxRetries && isRetryable) {
          const delay = 1000 * attempt;
          getLog().warn(
            { attempt, maxRetries, issueKey, delayMs: delay },
            'jira.comment_post_retry'
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        getLog().error(
          {
            err: error,
            issueKey,
            attempt,
            maxRetries,
            wasRetryable: isRetryable,
            messageLength: message.length,
          },
          'jira.comment_post_failed'
        );
        throw error;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Conversation ID: issueKey + per-webhook delivery token (e.g. PROJ-123::<id>)
  // ---------------------------------------------------------------------------

  /**
   * Build a unique platform conversation id per webhook delivery so each run
   * gets a fresh DB conversation (no shared isolation_env_id / cwd with prior runs).
   */
  private buildConversationId(issueKey: string, deliveryToken: string): string {
    const safeToken = deliveryToken.trim();
    if (!safeToken) {
      return `${issueKey}${CONVERSATION_DELIVERY_SEPARATOR}local-${randomUUID()}`;
    }
    return `${issueKey}${CONVERSATION_DELIVERY_SEPARATOR}${safeToken}`;
  }

  /** Prefer `x-atlassian-webhook-identifier`; otherwise a random token (tests / missing header). */
  private resolveWebhookDeliveryToken(meta: JiraWebhookIngestMeta | undefined): string {
    const id = meta?.atlassianWebhookId?.trim();
    if (id) return id;
    return `local-${randomUUID()}`;
  }

  private parseConversationId(conversationId: string): { issueKey: string } | null {
    const sep = conversationId.indexOf(CONVERSATION_DELIVERY_SEPARATOR);
    const issuePart = sep >= 0 ? conversationId.slice(0, sep) : conversationId;
    if (!ISSUE_KEY_PATTERN.test(issuePart)) return null;
    return { issueKey: issuePart };
  }

  private projectKeyFromIssueKey(issueKey: string): string | null {
    const dash = issueKey.lastIndexOf('-');
    if (dash <= 0) return null;
    return issueKey.slice(0, dash);
  }

  // ---------------------------------------------------------------------------
  // Event parsing
  // ---------------------------------------------------------------------------

  private parseEvent(event: JiraWebhookEvent): ParsedEvent | null {
    if (event.webhookEvent === 'comment_created' && event.issue && event.comment) {
      return {
        kind: 'comment_created',
        issue: event.issue,
        body: extractPlainText(event.comment.body),
        authorAccountId: event.comment.author?.accountId,
      };
    }

    if (event.webhookEvent === 'jira:issue_created' && event.issue) {
      return { kind: 'created', issue: event.issue };
    }

    if (event.webhookEvent === 'jira:issue_updated' && event.issue) {
      const items = event.changelog?.items ?? [];
      const statusItem = items.find(i => i.field === 'status');
      if (statusItem) {
        return {
          kind: 'transition',
          issue: event.issue,
          fromStatus: statusItem.fromString ?? '(none)',
          toStatus: statusItem.toString ?? '(none)',
          actor: event.user?.displayName ?? event.user?.accountId,
        };
      }
      const contentItems = items.filter(i => i.field === 'summary' || i.field === 'description');
      if (contentItems.length > 0) {
        return {
          kind: 'content_changed',
          issue: event.issue,
          fields: contentItems.map((i: JiraChangelogItem) => ({
            field: i.field,
            value: i.toString ?? '',
          })),
          actor: event.user?.displayName ?? event.user?.accountId,
        };
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Router payload composition
  // ---------------------------------------------------------------------------

  /**
   * Compose the structured JSON payload handed to the router workflow. The
   * shape is stable and documented — user-authored `jira-router.yaml` depends
   * on the field names here. Only `undefined` event-specific fields are
   * omitted (via JSON.stringify), giving the router a clean, predictable
   * surface to match on.
   */
  private composeRouterPayload(parsed: ParsedEvent, projectKey: string): RouterEventPayload {
    const issue = parsed.issue;
    const base: RouterEventPayload = {
      event: parsed.kind,
      issue_key: issue.key,
      project: projectKey,
      issue_type: issue.fields.issuetype?.name,
      summary: issue.fields.summary,
      status: issue.fields.status?.name,
    };

    switch (parsed.kind) {
      case 'comment_created':
        return {
          ...base,
          comment_body: parsed.body,
          author_account_id: parsed.authorAccountId,
        };
      case 'created':
        return base;
      case 'transition':
        return {
          ...base,
          from_status: parsed.fromStatus,
          to_status: parsed.toStatus,
          actor: parsed.actor,
        };
      case 'content_changed':
        return {
          ...base,
          changes: parsed.fields.map(f => ({ field: f.field, new_value: f.value })),
          actor: parsed.actor,
        };
    }
  }

  /** Build the slash command dispatched to the orchestrator. The payload is base64-encoded to produce a single whitespace-free token. */
  private buildRouterCommand(payload: RouterEventPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    return `/workflow run ${ROUTER_WORKFLOW_NAME} ${encoded}`;
  }

  /** Normalize a string for stable isolation hint identifiers. */
  private normalizeIsolationHintPart(value: string | undefined): string {
    if (!value) return 'unknown';
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    return normalized || 'unknown';
  }

  /**
   * Build an issue-scoped, stage-specific workflow ID for isolation.
   * This prevents created/transition handlers for the same ticket from colliding.
   */
  private buildIsolationWorkflowId(parsed: ParsedEvent): string {
    const issueKey = this.normalizeIsolationHintPart(parsed.issue.key);
    switch (parsed.kind) {
      case 'created': {
        const status = this.normalizeIsolationHintPart(parsed.issue.fields.status?.name);
        return `${issueKey}-created-${status}`;
      }
      case 'transition': {
        const from = this.normalizeIsolationHintPart(parsed.fromStatus);
        const to = this.normalizeIsolationHintPart(parsed.toStatus);
        return `${issueKey}-transition-${from}-to-${to}`;
      }
      case 'comment_created':
        return `${issueKey}-comment-created`;
      case 'content_changed':
        return `${issueKey}-content-changed`;
    }
  }

  // ---------------------------------------------------------------------------
  // Issue context (opaque string passed in MessageMetadata.issueContext)
  // ---------------------------------------------------------------------------

  private buildIssueContext(issue: JiraIssue): string {
    const status = issue.fields.status?.name ?? 'unknown';
    const issueType = issue.fields.issuetype?.name ?? 'unknown';
    const reporter = issue.fields.reporter?.displayName ?? 'unknown';
    return `[Jira Issue Context]
Key: ${issue.key}
Summary: ${issue.fields.summary}
Status: ${status}
Type: ${issueType}
Reporter: ${reporter}`;
  }

  // ---------------------------------------------------------------------------
  // Codebase resolution (explicit YAML mapping)
  // ---------------------------------------------------------------------------

  private async resolveCodebaseForProject(
    projectKey: string
  ): Promise<{ id: string; name: string; default_cwd: string } | null> {
    const codebaseName = this.projectCodebaseMap[projectKey];
    if (!codebaseName) {
      getLog().warn({ projectKey }, 'jira.project_not_mapped');
      return null;
    }
    const codebase = await codebaseDb.findCodebaseByName(codebaseName);
    if (!codebase) {
      getLog().error({ projectKey, codebaseName }, 'jira.mapped_codebase_not_found');
      return null;
    }
    return { id: codebase.id, name: codebase.name, default_cwd: codebase.default_cwd };
  }

  // ---------------------------------------------------------------------------
  // Webhook handler
  // ---------------------------------------------------------------------------

  async handleWebhook(
    payload: string,
    signature: string | undefined,
    meta?: JiraWebhookIngestMeta
  ): Promise<void> {
    const atlassianWebhookId = meta?.atlassianWebhookId;
    getLog().info(
      {
        payloadSize: payload.length,
        hasSignature: !!signature,
        atlassianWebhookId,
      },
      'jira.webhook_received'
    );

    // 1. Verify signature
    if (!signature) {
      getLog().error({ payloadSize: payload.length }, 'jira.missing_webhook_signature');
      return;
    }
    if (!this.verifySignature(payload, signature)) {
      getLog().error(
        { signaturePrefix: signature.substring(0, 15) + '...', payloadSize: payload.length },
        'jira.invalid_webhook_signature'
      );
      return;
    }

    // 2. Parse JSON
    let event: JiraWebhookEvent;
    try {
      event = JSON.parse(payload) as JiraWebhookEvent;
    } catch (error) {
      getLog().error({ err: error, payloadSize: payload.length }, 'jira.webhook_parse_failed');
      return;
    }

    getLog().info(
      {
        atlassianWebhookId,
        jiraWebhookEvent: event.webhookEvent,
        issueEventTypeName: event.issue_event_type_name,
        issueKey: event.issue?.key,
        timestamp: event.timestamp,
      },
      'jira.webhook_parsed'
    );

    // 3. Authorization (accountId allowlist) — fall back to comment author for comment events
    const senderAccountId = event.user?.accountId ?? event.comment?.author?.accountId;
    if (!isJiraUserAuthorized(senderAccountId, this.allowedAccountIds)) {
      const masked = senderAccountId ? `${senderAccountId.slice(0, 4)}***` : 'unknown';
      getLog().info({ maskedAccountId: masked }, 'jira.unauthorized_webhook');
      return;
    }

    // 4. Self-trigger prevention (comments only — bot writes only comments).
    // Requires botAccountId to be configured; see startup warning if absent.
    if (
      event.webhookEvent === 'comment_created' &&
      event.comment &&
      this.botAccountId &&
      event.comment.author?.accountId === this.botAccountId
    ) {
      getLog().debug(
        { commentAuthor: event.comment.author.accountId },
        'jira.ignoring_own_comment'
      );
      return;
    }

    // 5. Discriminate event
    const parsed = this.parseEvent(event);
    if (!parsed) {
      getLog().info(
        { atlassianWebhookId, webhookEvent: event.webhookEvent },
        'jira.unhandled_event'
      );
      return;
    }

    const issueKey = parsed.issue.key;
    const projectKey = parsed.issue.fields.project?.key ?? this.projectKeyFromIssueKey(issueKey);
    if (!projectKey) {
      getLog().warn({ issueKey }, 'jira.cannot_resolve_project_key');
      return;
    }

    getLog().info(
      {
        atlassianWebhookId,
        eventKind: parsed.kind,
        issueKey,
        projectKey,
        ...(parsed.kind === 'transition'
          ? { fromStatus: parsed.fromStatus, toStatus: parsed.toStatus }
          : {}),
      },
      'jira.webhook_processing'
    );

    try {
      // 6. Resolve codebase via explicit YAML mapping
      const codebase = await this.resolveCodebaseForProject(projectKey);
      if (!codebase) {
        // Already logged in resolveCodebaseForProject
        return;
      }

      // 7. Conversation setup — new platform id per HTTP delivery (isolation is per row)
      const deliveryToken = this.resolveWebhookDeliveryToken(meta);
      const conversationId = this.buildConversationId(issueKey, deliveryToken);
      const existingConv = await db.getOrCreateConversation('jira', conversationId);
      const isNewConversation = !existingConv.codebase_id;

      if (isNewConversation) {
        try {
          await db.updateConversation(existingConv.id, {
            codebase_id: codebase.id,
            cwd: codebase.default_cwd,
          });
        } catch (updateError) {
          if (updateError instanceof ConversationNotFoundError) {
            getLog().error(
              { conversationId: existingConv.id, codebaseId: codebase.id },
              'jira.conversation_codebase_link_failed'
            );
            throw new Error('Failed to set up Jira conversation - please try again');
          }
          throw updateError;
        }
      }

      // 8. Compose router payload and synthesize the slash command.
      const routerPayload = this.composeRouterPayload(parsed, projectKey);
      const command = this.buildRouterCommand(routerPayload);
      const issueContext = this.buildIssueContext(parsed.issue);
      const isolationWorkflowId = this.buildIsolationWorkflowId(parsed);
      const routerPrefix = `/workflow run ${ROUTER_WORKFLOW_NAME} `;
      const base64PayloadChars = command.startsWith(routerPrefix)
        ? command.slice(routerPrefix.length).length
        : 0;

      getLog().info(
        {
          atlassianWebhookId,
          conversationId,
          issueKey,
          eventKind: parsed.kind,
          isolationWorkflowId,
          isolationWorkflowType: 'issue' as const,
          routerWorkflow: ROUTER_WORKFLOW_NAME,
          commandBytes: Buffer.byteLength(command, 'utf8'),
          base64PayloadChars,
        },
        'jira.router_dispatch_start'
      );

      // 9. Dispatch to orchestrator (isolation + path lock are per conversation)
      try {
        await handleMessage(this, conversationId, command, {
          issueContext,
          isolationHints: {
            workflowType: 'issue',
            workflowId: isolationWorkflowId,
          },
        });
        getLog().info(
          {
            atlassianWebhookId,
            conversationId,
            issueKey,
            eventKind: parsed.kind,
            isolationWorkflowId,
          },
          'jira.router_dispatch_ok'
        );
      } catch (error) {
        const err = toError(error);
        getLog().error(
          { err, conversationId, eventKind: parsed.kind, atlassianWebhookId },
          'jira.router_dispatch_failed'
        );
        try {
          const userMessage = classifyAndFormatError(err);
          await this.sendMessage(conversationId, userMessage);
        } catch (sendError) {
          getLog().error(
            { err: toError(sendError), conversationId },
            'jira.error_message_send_failed'
          );
        }
      }
    } catch (error) {
      const err = toError(error);
      const deliveryToken = this.resolveWebhookDeliveryToken(
        atlassianWebhookId ? { atlassianWebhookId } : undefined
      );
      const conversationId = this.buildConversationId(issueKey, deliveryToken);
      getLog().error({ err, conversationId, issueKey }, 'jira.webhook_setup_failed');
      try {
        const userMessage = classifyAndFormatError(err);
        await this.sendMessage(conversationId, userMessage);
      } catch (sendError) {
        getLog().error(
          { err: toError(sendError), conversationId },
          'jira.webhook_setup_error_send_failed'
        );
      }
    }
  }
}
