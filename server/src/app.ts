import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { ApprovalDecision, NodeUpdate, PostMessageBody, RuntimeUpdate, ServerEvent } from '@ccf/shared';
import type { WebSocket } from 'ws';
import type { Access } from './auth.js';
import { isRunnerMode, repoRoot } from './config.js';
import type { EventBus } from './events.js';
import { HttpError } from './errors.js';
import { registerMcpRoutes } from './mcp.js';
import type { NodeHub } from './nodes/hub.js';
import type { FromNode, Link, ToNode } from './nodes/protocol.js';
import type { RuntimeService } from './runtime.js';
import type { SecretStore } from './secrets.js';
import type { ThreadService } from './threads.js';

export interface AppDeps {
  runtime: RuntimeService;
  threads: ThreadService;
  bus: EventBus;
  nodes: NodeHub;
  secrets: SecretStore;
  /** Present when remote access is configured; without it every request is trusted (tests, localhost-only). */
  access?: Access;
  /** The orchestrator's URL as other machines reach it, for the node install command. */
  publicUrl?: string;
  port?: number;
  /** Built web UI to serve at /, when present. */
  webDist?: string;
  logger?: FastifyBaseLogger;
}

export async function buildApp({ runtime, threads, bus, nodes, secrets, access, publicUrl, port, webDist, logger }: AppDeps): Promise<FastifyInstance> {
  const app = logger
    ? Fastify({ loggerInstance: logger, logController: new LogController({ disableRequestLogging: true }) })
    : Fastify();
  await app.register(fastifyWebsocket);
  access?.register(app);
  app.addHook('onClose', async () => nodes.close());

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

  app.post<{ Body: { name?: string; workspacePath?: string; repoUrl?: string; baseBranch?: string } }>('/api/projects', async (req, reply) => {
    const project = threads.createProject(req.body?.name ?? '', req.body?.workspacePath ?? '', {
      repoUrl: req.body?.repoUrl,
      baseBranch: req.body?.baseBranch,
    });
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

  // ---- Nodes (M5) ----

  app.get('/api/nodes', async () => threads.nodesView());

  app.patch<{ Params: { id: string }; Body: NodeUpdate }>('/api/nodes/:id', async (req) => threads.updateNode(req.params.id, req.body ?? {}));

  app.delete<{ Params: { id: string } }>('/api/nodes/:id', async (req, reply) => {
    threads.removeNode(req.params.id);
    return reply.status(204).send();
  });

  app.post('/api/nodes/pairing', async (req) => {
    const host = req.hostname.replace(/:\d+$/, '');
    const url = publicUrl?.replace(/\/$/, '') || `${req.protocol}://${host.includes(':') ? `[${host}]` : host}:${port ?? 4317}`;
    return nodes.createPairingCode(url);
  });

  app.post<{ Body: { code?: string; name?: string } }>('/api/nodes/pair', async (req) => nodes.pair(req.body?.code ?? '', req.body?.name ?? 'node'));

  app.get('/api/nodes/install.sh', async (_req, reply) =>
    reply.type('text/x-shellscript').send(fs.readFileSync(new URL('../assets/install.sh', import.meta.url), 'utf8')),
  );

  app.get<{ Params: { file: string } }>('/api/nodes/worker/:file', async (req, reply) => {
    switch (req.params.file) {
      case 'worker.mjs':
        return reply.type('text/javascript').send(fs.readFileSync(await workerBundle(), 'utf8'));
      case 'post-hook.mjs':
        return reply.type('text/javascript').send(fs.readFileSync(new URL('../hooks/post-hook.mjs', import.meta.url), 'utf8'));
      case 'package.json':
        return reply.type('application/json').send(workerPackageJson());
      default:
        return reply.status(404).send({ error: 'Not found' });
    }
  });

  app.get('/api/nodes/connect', { websocket: true }, (socket) => nodes.acceptRemote(socketLink(socket)));

  // ---- Credentials (M5): write-only ----

  app.get('/api/secrets', async () => secrets.status());

  app.put<{ Params: { name: string }; Body: { value?: string } }>('/api/secrets/:name', async (req) => {
    const status = secrets.set(req.params.name, req.body?.value as string);
    // A stored API key can make API mode usable; check again rather than wait for the cache.
    void runtime.state(true).then(() => undefined);
    return status;
  });

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

/** A node's WebSocket as one end of a node link. */
function socketLink(socket: WebSocket): Link<FromNode, ToNode> {
  return {
    send: (m) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m)),
    onMessage: (h) =>
      socket.on('message', (data) => {
        try {
          h(JSON.parse(String(data)) as FromNode);
        } catch {
          // Not ours.
        }
      }),
    onClose: (h) => socket.on('close', h),
    close: () => socket.close(),
  };
}

/** The worker bundle nodes download, built on first request when `pnpm build` hasn't made it yet. */
async function workerBundle(): Promise<string> {
  const built = `${repoRoot}/node/dist/worker.mjs`;
  if (fs.existsSync(built)) return built;
  const { buildWorker } = (await import(pathToFileURL(`${repoRoot}/node/build.mjs`).href)) as { buildWorker: () => Promise<string> };
  return buildWorker();
}

/** What a node installs: the Agent SDK (with Claude Code for the node's platform) at the version this server uses. */
function workerPackageJson(): string {
  let sdk = '*';
  try {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    sdk = (JSON.parse(fs.readFileSync(`${entry.replace(/[/\\][^/\\]*$/, '')}/package.json`, 'utf8')) as { version: string }).version;
  } catch {
    // Fall back to the latest.
  }
  return JSON.stringify({ name: 'ccf-node', private: true, type: 'module', dependencies: { '@anthropic-ai/claude-agent-sdk': sdk, zod: '^4.0.0' } }, null, 2);
}
