import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { RuntimeUpdate, ServerEvent } from '@ccf/shared';
import { isRunnerMode } from './config.js';
import type { EventBus } from './events.js';
import { RuntimeError, type RuntimeService } from './runtime.js';

export interface AppDeps {
  runtime: RuntimeService;
  bus: EventBus;
  /** Built web UI to serve at /, when present. */
  webDist?: string;
  logger?: FastifyBaseLogger;
}

export async function buildApp({ runtime, bus, webDist, logger }: AppDeps): Promise<FastifyInstance> {
  const app = logger
    ? Fastify({ loggerInstance: logger, logController: new LogController({ disableRequestLogging: true }) })
    : Fastify();
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RuntimeError) {
      return reply.status(err.statusCode).send({ error: err.message, reason: err.reason, health: err.health });
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
