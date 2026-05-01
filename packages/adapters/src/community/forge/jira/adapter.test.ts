/**
 * Unit tests for Jira community forge adapter.
 *
 * Runs in its own test batch to avoid mock.module pollution with other adapters.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createHmac } from 'crypto';

// Mock @archon/paths to suppress noisy logger output during tests
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Mock DB modules to throw immediately (avoid DB connection hangs in tests)
const mockGetOrCreateConversation = mock(async (_platform: string, convId: string) => ({
  id: `db-${convId}`,
  platform_type: 'jira',
  platform_conversation_id: convId,
  codebase_id: null,
  cwd: null,
  isolation_env_id: null,
  ai_assistant_type: 'claude',
  title: null,
  hidden: false,
  deleted_at: null,
  last_activity_at: null,
  created_at: new Date(),
  updated_at: new Date(),
}));
const mockUpdateConversation = mock(async () => undefined);
mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  updateConversation: mockUpdateConversation,
  getConversation: mock(async () => null),
}));

const mockFindCodebaseByName = mock(
  async (_name: string) =>
    null as null | {
      id: string;
      name: string;
      default_cwd: string;
    }
);
mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByName: mockFindCodebaseByName,
}));

// Mock @archon/core
const mockHandleMessage = mock(async () => undefined);
mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  classifyAndFormatError: mock((err: Error) => err.message),
  toError: mock((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
  ConversationNotFoundError: class extends Error {},
}));

// Mock global fetch to prevent real HTTP calls
const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
globalThis.fetch = mockFetch as typeof globalThis.fetch;

// Now import the adapter (after all mocks)
const { JiraAdapter } = await import('./adapter');
const { extractPlainText } = await import('./types');

const SECRET = 'test-secret';

function sign(payload: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

interface AdapterOpts {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  secret?: string;
  botAccountId?: string;
  allowedAccountIds?: string[];
  projectCodebaseMap?: Record<string, string>;
}

function createAdapter(opts: AdapterOpts = {}): InstanceType<typeof JiraAdapter> {
  return new JiraAdapter(
    opts.baseUrl ?? 'https://example.atlassian.net',
    opts.email ?? 'bot@example.com',
    opts.apiToken ?? 'api-token',
    opts.secret ?? SECRET,
    {
      botAccountId: opts.botAccountId,
      allowedAccountIds: opts.allowedAccountIds,
      projectCodebaseMap: opts.projectCodebaseMap,
    }
  );
}

/**
 * Extract the payload from a synthesized router command.
 * The payload is base64-encoded JSON, so decode and parse it.
 */
function extractRouterPayload(command: string): Record<string, unknown> {
  const tokens = command.match(/\S+/g) ?? [];
  // tokens[0] = "/workflow", tokens[1] = "run", tokens[2] = "jira-router", tokens[3] = base64
  if (tokens[0] !== '/workflow' || tokens[1] !== 'run' || tokens[2] !== 'jira-router') {
    throw new Error(`Command does not match router shape: ${command}`);
  }
  const decoded = Buffer.from(tokens[3], 'base64').toString('utf8');
  return JSON.parse(decoded) as Record<string, unknown>;
}

/** Destructure the captured mockHandleMessage call arguments. */
function handleMessageCall(index = 0): {
  conversationId: string;
  command: string;
  metadata: { issueContext?: string };
} {
  const args = mockHandleMessage.mock.calls[index] as unknown as [
    unknown,
    string,
    string,
    { issueContext?: string },
  ];
  return { conversationId: args[1], command: args[2], metadata: args[3] };
}

interface CommentPayloadOpts {
  body?: string;
  authorAccountId?: string;
  issueKey?: string;
  projectKey?: string;
}

function commentPayload(opts: CommentPayloadOpts = {}): string {
  const issueKey = opts.issueKey ?? 'PROJ-1';
  const projectKey = opts.projectKey ?? issueKey.split('-')[0];
  return JSON.stringify({
    webhookEvent: 'comment_created',
    issue: {
      id: '10001',
      key: issueKey,
      fields: {
        summary: 'Issue summary',
        status: { name: 'To Do' },
        issuetype: { name: 'Task' },
        reporter: { accountId: 'reporter-1', displayName: 'Reporter' },
        project: { id: '1', key: projectKey, name: projectKey },
      },
    },
    comment: {
      id: '500',
      body: opts.body ?? 'hello there',
      author: {
        accountId: opts.authorAccountId ?? 'user-1',
        displayName: 'User One',
      },
    },
  });
}

function createdPayload(issueKey = 'PROJ-2'): string {
  const projectKey = issueKey.split('-')[0];
  return JSON.stringify({
    webhookEvent: 'jira:issue_created',
    user: { accountId: 'user-1', displayName: 'User One' },
    issue: {
      id: '10002',
      key: issueKey,
      fields: {
        summary: 'A new bug',
        description: 'Something broke',
        status: { name: 'To Do' },
        issuetype: { name: 'Bug' },
        reporter: { accountId: 'user-1', displayName: 'User One' },
        project: { id: '1', key: projectKey, name: projectKey },
      },
    },
  });
}

function statusChangedPayload(): string {
  return JSON.stringify({
    webhookEvent: 'jira:issue_updated',
    user: { accountId: 'user-1', displayName: 'User One' },
    issue: {
      id: '10003',
      key: 'PROJ-3',
      fields: {
        summary: 'In flight',
        status: { name: 'In Progress' },
        issuetype: { name: 'Task' },
        reporter: { accountId: 'user-1', displayName: 'User One' },
        project: { id: '1', key: 'PROJ', name: 'PROJ' },
      },
    },
    changelog: {
      items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
    },
  });
}

function contentChangedPayload(): string {
  return JSON.stringify({
    webhookEvent: 'jira:issue_updated',
    user: { accountId: 'user-1', displayName: 'User One' },
    issue: {
      id: '10004',
      key: 'PROJ-4',
      fields: {
        summary: 'Updated summary',
        status: { name: 'To Do' },
        issuetype: { name: 'Task' },
        reporter: { accountId: 'user-1', displayName: 'User One' },
        project: { id: '1', key: 'PROJ', name: 'PROJ' },
      },
    },
    changelog: {
      items: [{ field: 'summary', fromString: 'Old', toString: 'Updated summary' }],
    },
  });
}

describe('JiraAdapter', () => {
  beforeEach(() => {
    mockHandleMessage.mockClear();
    mockGetOrCreateConversation.mockClear();
    mockUpdateConversation.mockClear();
    mockFindCodebaseByName.mockClear();
    mockFetch.mockClear();
    // Default: a mapped codebase exists
    mockFindCodebaseByName.mockImplementation(async (name: string) => ({
      id: 'cb-1',
      name,
      default_cwd: '/tmp/cwd',
    }));
  });

  describe('basic interface', () => {
    test('returns batch streaming mode', () => {
      expect(createAdapter().getStreamingMode()).toBe('batch');
    });

    test('returns jira platform type', () => {
      expect(createAdapter().getPlatformType()).toBe('jira');
    });

    test('start and stop without error', async () => {
      const adapter = createAdapter();
      await adapter.start();
      adapter.stop();
    });

    test('ensureThread returns original id', async () => {
      const id = await createAdapter().ensureThread('PROJ-1');
      expect(id).toBe('PROJ-1');
    });

    test('constructor rejects empty required fields', () => {
      expect(() => new JiraAdapter('', 'a@b.c', 'tok', 'secret')).toThrow(/baseUrl/);
      expect(() => new JiraAdapter('https://x', '', 'tok', 'secret')).toThrow(/userEmail/);
      expect(() => new JiraAdapter('https://x', 'a@b.c', '', 'secret')).toThrow(/apiToken/);
      expect(() => new JiraAdapter('https://x', 'a@b.c', 'tok', '')).toThrow(/webhookSecret/);
    });
  });

  describe('signature verification', () => {
    test('valid HMAC passes', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload();
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('wrong secret fails', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload();
      await adapter.handleWebhook(payload, sign(payload, 'other-secret'));
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('length mismatch fails safely', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload();
      // Truncated signature
      await adapter.handleWebhook(payload, 'sha256=abc');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('missing signature header rejected', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      await adapter.handleWebhook(commentPayload(), undefined);
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('JSON parse error', () => {
    test('handles malformed JSON gracefully', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = 'not-json';
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('ADF extraction', () => {
    test('plain string body returned verbatim', () => {
      expect(extractPlainText('hello world')).toBe('hello world');
    });

    test('nested ADF doc flattened to text', () => {
      const doc = {
        type: 'doc' as const,
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text' as const, text: 'Hello' },
              { type: 'text' as const, text: ' there' },
            ],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text' as const, text: 'second para' }],
          },
        ],
      };
      const out = extractPlainText(doc);
      expect(out).toContain('Hello there');
      expect(out).toContain('second para');
    });

    test('null/undefined → empty string', () => {
      expect(extractPlainText(null)).toBe('');
      expect(extractPlainText(undefined)).toBe('');
    });

    test('unknown shape falls back to String()', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(extractPlainText(123 as any)).toBe('123');
    });
  });

  describe('conversation ID format', () => {
    test('PROJ-1 uses issueKey::deliveryToken (local token without webhook header)', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload({ issueKey: 'PROJ-1' });
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
      expect(handleMessageCall().conversationId).toMatch(/^PROJ-1::local-[0-9a-f-]{36}$/i);
    });

    test('Atlassian webhook id is used as delivery suffix when provided', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload({ issueKey: 'PROJ-1' });
      await adapter.handleWebhook(payload, sign(payload), {
        atlassianWebhookId: '6606435970124748721',
      });
      expect(handleMessageCall().conversationId).toBe('PROJ-1::6606435970124748721');
    });

    test('two deliveries same issue → two conversation ids', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload({ issueKey: 'PROJ-1' });
      await adapter.handleWebhook(payload, sign(payload), { atlassianWebhookId: 'delivery-a' });
      await adapter.handleWebhook(payload, sign(payload), { atlassianWebhookId: 'delivery-b' });
      expect(handleMessageCall(0).conversationId).toBe('PROJ-1::delivery-a');
      expect(handleMessageCall(1).conversationId).toBe('PROJ-1::delivery-b');
      expect(handleMessageCall(0).conversationId).not.toBe(handleMessageCall(1).conversationId);
    });

    test('FOO_BAR-123 accepted', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { FOO_BAR: 'my-codebase' },
      });
      const payload = commentPayload({ issueKey: 'FOO_BAR-123', projectKey: 'FOO_BAR' });
      await adapter.handleWebhook(payload, sign(payload), { atlassianWebhookId: 'w1' });
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
      expect(handleMessageCall().conversationId).toBe('FOO_BAR-123::w1');
    });

    test('sendMessage rejects invalid conversation ids', async () => {
      const adapter = createAdapter();
      // Lower-case prefix invalid; missing dash invalid; trailing dash invalid
      await adapter.sendMessage('proj-1', 'hi');
      await adapter.sendMessage('PROJ_1', 'hi');
      await adapter.sendMessage('PROJ-', 'hi');
      await adapter.sendMessage('', 'hi');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('router command synthesis', () => {
    test('handleMessage receives the /workflow run jira-router shape exactly once', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload();
      await adapter.handleWebhook(payload, sign(payload));

      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
      const { command } = handleMessageCall();
      // Payload is base64-encoded — single whitespace-free token after "jira-router"
      expect(command).toMatch(/^\/workflow run jira-router [A-Za-z0-9+/]+=*$/);
    });

    test('metadata.issueContext is passed through', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload();
      await adapter.handleWebhook(payload, sign(payload));

      const { metadata } = handleMessageCall();
      expect(metadata.issueContext).toContain('Key: PROJ-1');
      expect(metadata.issueContext).toContain('Summary: Issue summary');
    });

    test('comment_created payload carries body and author', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload({ body: 'please implement this', authorAccountId: 'human-1' });
      await adapter.handleWebhook(payload, sign(payload));

      const router = extractRouterPayload(handleMessageCall().command);
      expect(router.event).toBe('comment_created');
      expect(router.issue_key).toBe('PROJ-1');
      expect(router.project).toBe('PROJ');
      expect(router.codebase_cwd).toBe('/tmp/cwd');
      expect(router.issue_type).toBe('Task');
      expect(router.summary).toBe('Issue summary');
      expect(router.status).toBe('To Do');
      expect(router.comment_body).toBe('please implement this');
      expect(router.author_account_id).toBe('human-1');
    });

    test('created payload has no event-specific extras', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = createdPayload();
      await adapter.handleWebhook(payload, sign(payload));

      const router = extractRouterPayload(handleMessageCall().command);
      expect(router.event).toBe('created');
      expect(router.issue_key).toBe('PROJ-2');
      expect(router.codebase_cwd).toBe('/tmp/cwd');
      expect(router.summary).toBe('A new bug');
      expect(router.issue_type).toBe('Bug');
      expect(router.comment_body).toBeUndefined();
      expect(router.from_status).toBeUndefined();
    });

    test('transition payload carries from_status, to_status, actor', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = statusChangedPayload();
      await adapter.handleWebhook(payload, sign(payload));

      const router = extractRouterPayload(handleMessageCall().command);
      expect(router.event).toBe('transition');
      expect(router.codebase_cwd).toBe('/tmp/cwd');
      expect(router.from_status).toBe('To Do');
      expect(router.to_status).toBe('In Progress');
      expect(router.actor).toBe('User One');
    });

    test('content_changed payload carries changes array with all modified fields', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = contentChangedPayload();
      await adapter.handleWebhook(payload, sign(payload));

      const router = extractRouterPayload(handleMessageCall().command);
      expect(router.event).toBe('content_changed');
      expect(Array.isArray(router.changes)).toBe(true);
      const changes = router.changes as { field: string; new_value: string }[];
      expect(changes).toHaveLength(1);
      expect(changes[0].field).toBe('summary');
      expect(changes[0].new_value).toBe('Updated summary');
      expect(router.actor).toBe('User One');
    });

    test('content_changed with both summary and description carries both in changes array', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const multi = JSON.stringify({
        webhookEvent: 'jira:issue_updated',
        user: { accountId: 'user-1', displayName: 'User One' },
        issue: {
          id: '10004',
          key: 'PROJ-4',
          fields: {
            summary: 'New summary',
            status: { name: 'To Do' },
            issuetype: { name: 'Task' },
            reporter: { accountId: 'user-1', displayName: 'User One' },
            project: { id: '1', key: 'PROJ', name: 'PROJ' },
          },
        },
        changelog: {
          items: [
            { field: 'summary', fromString: 'Old', toString: 'New summary' },
            { field: 'description', fromString: 'Old body', toString: 'New body' },
          ],
        },
      });
      await adapter.handleWebhook(multi, sign(multi));

      const router = extractRouterPayload(handleMessageCall().command);
      expect(router.event).toBe('content_changed');
      const changes = router.changes as { field: string; new_value: string }[];
      expect(changes).toHaveLength(2);
      expect(changes.find(c => c.field === 'summary')?.new_value).toBe('New summary');
      expect(changes.find(c => c.field === 'description')?.new_value).toBe('New body');
    });

    test('base64 payload round-trips arbitrary strings including trailing spaces and special chars', async () => {
      // Regression guard: base64 encoding must preserve all content without
      // corruption — trailing spaces, quotes, apostrophes, and high-range unicode.
      const issueKey = 'PROJ-504';
      const trickySummary = `PROJ-504 Joe's "auth" bug — trailing space `;
      const tricky = JSON.stringify({
        webhookEvent: 'jira:issue_created',
        user: { accountId: 'user-1', displayName: 'User One' },
        issue: {
          id: '504',
          key: issueKey,
          fields: {
            summary: trickySummary,
            description: 'x',
            status: { name: 'To Do' },
            issuetype: { name: 'Bug' },
            reporter: { accountId: 'user-1' },
            project: { id: '1', key: 'PROJ', name: 'PROJ' },
          },
        },
      });
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      await adapter.handleWebhook(tricky, sign(tricky));

      const router = extractRouterPayload(handleMessageCall().command);
      expect(router.summary).toBe(trickySummary);
    });
  });

  describe('event parsing → dispatch', () => {
    test('comment_created → dispatched', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload({ body: 'a normal comment' });
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('jira:issue_created → dispatched', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = createdPayload();
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('jira:issue_updated with status changelog → dispatched', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = statusChangedPayload();
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('jira:issue_updated with summary changelog → dispatched', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = contentChangedPayload();
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('jira:issue_deleted → ignored', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = JSON.stringify({
        webhookEvent: 'jira:issue_deleted',
        issue: { id: '1', key: 'PROJ-1', fields: { summary: 'x' } },
      });
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('jira:issue_updated with no changelog items → ignored', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = JSON.stringify({
        webhookEvent: 'jira:issue_updated',
        user: { accountId: 'user-1' },
        issue: { id: '1', key: 'PROJ-1', fields: { summary: 'x' } },
        changelog: { items: [{ field: 'assignee', fromString: 'a', toString: 'b' }] },
      });
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('self-trigger prevention', () => {
    test('bot accountId skipped', async () => {
      const adapter = createAdapter({
        botAccountId: 'bot-acct',
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload({ authorAccountId: 'bot-acct' });
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('normal comment proceeds when botAccountId configured', async () => {
      const adapter = createAdapter({
        botAccountId: 'bot-acct',
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload({ authorAccountId: 'human-1' });
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('comment proceeds when botAccountId not configured (no self-trigger guard)', async () => {
      // Without botAccountId, self-trigger prevention is disabled — all comments dispatch.
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload({ authorAccountId: 'any-acct' });
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('codebase resolution', () => {
    test('mapped project → dispatched with codebase id', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload();
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockFindCodebaseByName).toHaveBeenCalledWith('my-codebase');
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('unmapped project → warned and aborted', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: {}, // empty
      });
      const payload = commentPayload();
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockFindCodebaseByName).not.toHaveBeenCalled();
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('mapped to unknown codebase name → aborted', async () => {
      mockFindCodebaseByName.mockImplementation(async () => null);
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'missing-codebase' },
      });
      const payload = commentPayload();
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockFindCodebaseByName).toHaveBeenCalledWith('missing-codebase');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    test('empty allowlist allows all', async () => {
      const adapter = createAdapter({
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload({ authorAccountId: 'mallory' });
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('mismatched accountId silently rejected', async () => {
      const adapter = createAdapter({
        allowedAccountIds: ['allowed-1', 'allowed-2'],
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload({ authorAccountId: 'mallory' });
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('matched accountId proceeds', async () => {
      const adapter = createAdapter({
        allowedAccountIds: ['allowed-1'],
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      const payload = commentPayload({ authorAccountId: 'allowed-1' });
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('falls back to comment.author for comment events when event.user absent', async () => {
      const adapter = createAdapter({
        allowedAccountIds: ['comment-author'],
        projectCodebaseMap: { PROJ: 'my-codebase' },
      });
      // commentPayload does not include event.user — only comment.author
      const payload = commentPayload({ authorAccountId: 'comment-author' });
      await adapter.handleWebhook(payload, sign(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendMessage', () => {
    test('short message → single POST with ADF body', async () => {
      const adapter = createAdapter();
      mockFetch.mockClear();
      await adapter.sendMessage('PROJ-1', 'hi');

      // 1 call for the POST comment (no history fetch in the refactored adapter)
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain('/rest/api/3/issue/PROJ-1/comment');
      expect(init.method).toBe('POST');

      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Basic /);
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(init.body as string) as {
        body: { type: string; version: number; content: { type: string }[] };
      };
      expect(body.body.type).toBe('doc');
      expect(body.body.version).toBe(1);
      expect(Array.isArray(body.body.content)).toBe(true);

      // Marker must NOT appear in the comment (would render as literal text in ADF)
      expect(init.body as string).not.toContain('<!-- archon-bot-response -->');
    });

    test('conversation id with ::suffix still posts to bare issue key', async () => {
      const adapter = createAdapter();
      mockFetch.mockClear();
      await adapter.sendMessage('PROJ-1::6606435970124748721', 'hi');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain('/rest/api/3/issue/PROJ-1/comment');
    });

    test('long message splits into multiple POSTs', async () => {
      const adapter = createAdapter();
      mockFetch.mockClear();
      // Build a message that exceeds 32000 chars with paragraph breaks
      const para = 'x'.repeat(10000);
      const long = [para, para, para, para].join('\n\n');
      await adapter.sendMessage('PROJ-1', long);
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    test('non-retryable failure throws', async () => {
      const adapter = createAdapter();
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response('bad request', { status: 400, statusText: 'Bad Request' }))
      );
      await expect(adapter.sendMessage('PROJ-1', 'hi')).rejects.toThrow(/400/);
    });

    test('retries 5xx and eventually succeeds', async () => {
      const adapter = createAdapter();
      let calls = 0;
      mockFetch.mockImplementation(() => {
        calls++;
        if (calls < 2) {
          return Promise.resolve(
            new Response('busy', { status: 503, statusText: 'Service Unavailable' })
          );
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      });
      await adapter.sendMessage('PROJ-1', 'hi');
      expect(calls).toBeGreaterThanOrEqual(2);
    });
  });
});
