import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { toolsFor } from './mcpTools.js';
import type { RunContext, ThreadService } from './threads.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });

/** Runs a tool body, turning a thrown error into a tool error the session can read and recover from. */
function attempt(body: () => string): ToolResult {
  try {
    return text(body());
  } catch (err) {
    return { ...text((err as Error).message), isError: true };
  }
}

/** One MCP server per request, holding only the tools the calling session's kind may use. */
function buildServer(threads: ThreadService, ctx: RunContext): McpServer {
  const server = new McpServer({ name: 'custom-claude-frontend', version: '0.0.0' });
  const allowed = new Set(toolsFor(ctx.kind));

  if (allowed.has('start_thread')) {
    server.registerTool(
      'start_thread',
      {
        description:
          'Start a new thread (a separate Claude Code session in this project) for one piece of work. Returns immediately; ' +
          'the thread runs in parallel with others, up to the concurrency cap, and you get a [Thread update] message when it finishes. ' +
          'The thread cannot see the project chat, so the brief must be self-contained.',
        inputSchema: {
          title: z.string().min(1).max(100).describe('A few words naming the work, shown to the user.'),
          brief: z.string().min(1).describe('Everything the thread needs to do the work and what it should deliver.'),
        },
      },
      ({ title, brief }) =>
        attempt(() => {
          const thread = threads.startThreadFor(ctx, title, brief);
          return `Started thread "${thread.title}" (thread_id: ${thread.id}), status ${thread.status}. You'll get a [Thread update] when it finishes.`;
        }),
    );
  }

  if (allowed.has('message_thread')) {
    server.registerTool(
      'message_thread',
      {
        description: 'Send a follow-up message to an existing thread. It joins the current run if the thread is working, or starts a new run.',
        inputSchema: { thread_id: z.string(), text: z.string().min(1) },
      },
      ({ thread_id, text: body }) =>
        attempt(() =>
          threads.messageThreadFor(ctx, thread_id, body) === 'sent'
            ? 'Sent into the thread\'s current run.'
            : 'Queued; the thread will start a run with it.',
        ),
    );
  }

  if (allowed.has('list_threads')) {
    server.registerTool(
      'list_threads',
      { description: 'List every thread in this project with its id, status and the first line of its latest reply.', inputSchema: {} },
      () =>
        attempt(() => {
          const list = threads.summarizeThreads(ctx);
          if (list.length === 0) return 'No threads yet.';
          return list
            .map((t) => `- ${t.title} (thread_id: ${t.id}) · ${t.status}${t.lastResult ? ` · last reply: ${t.lastResult}` : ''}`)
            .join('\n');
        }),
    );
  }

  if (allowed.has('read_thread')) {
    server.registerTool(
      'read_thread',
      {
        description: "Read a thread's most recent messages (user, assistant and errors; tool output is left out), in full.",
        inputSchema: {
          thread_id: z.string(),
          last_n: z.number().int().min(1).max(50).optional().describe('How many messages, default 10.'),
        },
      },
      ({ thread_id, last_n }) =>
        attempt(() => {
          const messages = threads.readThreadFor(ctx, thread_id, last_n ?? 10);
          if (messages.length === 0) return 'The thread has no messages yet.';
          return messages
            .map((m) => `[${m.kind === 'error' ? 'error' : m.meta?.from === 'coordinator' ? 'coordinator' : m.author}] ${m.text}`)
            .join('\n\n');
        }),
    );
  }

  server.registerTool(
    'read_memory',
    { description: "Read the project's memory file (MEMORY.md in the workspace), shared by every session in the project.", inputSchema: {} },
    () => attempt(() => threads.readMemoryFor(ctx) || '(The memory file is empty.)'),
  );

  server.registerTool(
    'write_memory',
    {
      description:
        "Replace the project's memory file with new text. Read it first and keep what is still true: this overwrites the whole file. " +
        'Use it for durable facts and decisions that other sessions in the project should know.',
      inputSchema: { text: z.string() },
    },
    ({ text: body }) =>
      attempt(() => {
        threads.writeMemoryFor(ctx, body);
        return 'Memory saved.';
      }),
  );

  return server;
}

/**
 * The app's MCP server over streamable HTTP, stateless: each POST carries the run's token in its
 * Authorization header, which says which project and session is calling. HTTP rather than the SDK's
 * in-process MCP is what lets both runner modes use the same tools.
 */
export function registerMcpRoutes(app: FastifyInstance, threads: ThreadService): void {
  app.post('/mcp', async (req, reply) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const ctx = token ? threads.runContext(token) : undefined;
    if (!ctx) return reply.status(401).send({ error: 'Unknown or expired run token.' });

    const server = buildServer(threads, ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless: no server-initiated stream and no session to end.
  const notAllowed = async (_req: unknown, reply: FastifyReply) =>
    reply.status(405).header('allow', 'POST').send({ error: 'Method not allowed.' });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
