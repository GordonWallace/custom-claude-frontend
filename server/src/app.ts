import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { ApprovalDecision, PostMessageBody, RuntimeUpdate, ServerEvent } from '@ccf/shared';
import { isRunnerMode } from './config.js';
import type { EventBus } from './events.js';
import { HttpError } from './errors.js';
import { registerMcpRoutes } from './mcp.js';
import type { RuntimeService } from './runtime.js';
import type { ThreadService } from './threads.js';

export interface AppDeps {
  runtime: RuntimeService;
  threads: ThreadService;
  bus: EventBus;
  /** Built web UI to serve at /, when present. */
  webDist?: string;
  logger?: FastifyBaseLogger;
}

export async function buildApp({ runtime, threads, bus, webDist, logger }: AppDeps): Promise<FastifyInstance> {
  const app = logger
    ? Fastify({ loggerInstance: logger, logController: new LogController({ disableRequestLogging: true }) })
    : Fastify();
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, ...err.body });
    }
    const { statusCode = 500, message = String(err) } = err as { statusCode?: number; message?: string };
    if (statusCode >= 500) app.log.error(err);
    return reply.status(statusCode).send({ error: message });
  });

  app.get<{ Querystring: { refresh?: string } }>('/api/runtime', async (req) => {
    return runtime.state(req.query.refresh !== undefined);
  });

  app.put<{ Body: RuntimeUpdate }>('/api/runtime', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.mode === undefined && body.concurrency === undefined) {
      return reply.status(400).send({ error: 'Send { "mode": "api" | "subscription" } and/or { "concurrency": n }.' });
    }
    if (body.mode !== undefined && !isRunnerMode(body.mode)) {
      return reply.status(400).send({ error: `Unknown mode ${JSON.stringify(body.mode)}: use "api" or "subscription".` });
    }
    let state = undefined;
    if (body.concurrency !== undefined) state = await runtime.setConcurrency(Number(body.concurrency));
    if (body.mode !== undefined) state = await runtime.setMode(body.mode);
    return state;
  });

  app.get('/api/projects', async () => threads.listProjects());

  app.post<{ Body: { name?: string; workspacePath?: string } }>('/api/projects', async (req, reply) => {
    const project = threads.createProject(req.body?.name ?? '', req.body?.workspacePath ?? '');
    return reply.status(201).send(project);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/threads', async (req) => threads.listThreads(req.params.id));

  app.post<{ Params: { id: string }; Body: { title?: string } }>('/api/projects/:id/threads', async (req, reply) => {
    return reply.status(201).send(threads.createThread(req.params.id, req.body?.title));
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/memory', async (req) => ({ text: threads.getMemory(req.params.id) }));

  app.put<{ Params: { id: string }; Body: { text?: string } }>('/api/projects/:id/memory', async (req) => {
    threads.setMemory(req.params.id, req.body?.text as string);
    return { text: threads.getMemory(req.params.id) };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/usage', async (req) => threads.usage(req.params.id));

  app.post<{ Params: { id: string } }>('/api/projects/:id/coordinator/reset', async (req) =>
    threads.resetCoordinator(req.params.id),
  );

  app.get<{ Params: { id: string } }>('/api/threads/:id', async (req) => threads.detail(req.params.id));

  app.get<{ Params: { id: string } }>('/api/threads/:id/messages', async (req) => threads.messages(req.params.id));

  app.post<{ Params: { id: string }; Body: PostMessageBody }>('/api/threads/:id/messages', async (req, reply) => {
    const message = await threads.postMessage(req.params.id, req.body ?? { text: '' });
    return reply.status(202).send(message);
  });

  app.post<{ Params: { id: string } }>('/api/threads/:id/interrupt', async (req, reply) => {
    await threads.interrupt(req.params.id);
    return reply.status(202).send({ ok: true });
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (req) => threads.runEvents(Number(req.params.id)));

  app.post<{ Params: { id: string }; Body: ApprovalDecision }>('/api/approvals/:id', async (req) => {
    threads.decideApproval(req.params.id, req.body ?? ({} as ApprovalDecision));
    return { ok: true };
  });

  // Called by the SessionStart command hook inside each run (see runners/sdkRunner.ts).
  app.post<{ Params: { token: string }; Body: { session_id?: string; source?: string } }>(
    '/api/hooks/session-start/:token',
    async (req, reply) => reply.status(threads.handleSessionHook(req.params.token, req.body ?? {}) ? 204 : 404).send(),
  );

  // The app's own MCP server, which every session gets (coordinator tools, memory).
  registerMcpRoutes(app, threads);

  app.get('/api/events', { websocket: true }, (socket) => {
    const send = (event: ServerEvent) => socket.send(JSON.stringify(event));
    const unsubscribe = bus.subscribe(send);
    socket.on('close', unsubscribe);
    void runtime.state().then((state) => send({ type: 'runtime', state }));
  });

  if (webDist && fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
