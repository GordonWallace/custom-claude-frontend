import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { RuntimeState, ServerEvent } from '@ccf/shared';
import { setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

const put = (c: Ctx, payload: unknown) =>
  c.app.inject({ method: 'PUT', url: '/api/runtime', payload: payload as object });

describe('GET /api/runtime', () => {
  it('reports no mode when neither config nor settings set one', async () => {
    ctx = await setup();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/runtime' });
    const state = res.json<RuntimeState>();
    expect(res.statusCode).toBe(200);
    expect(state.mode).toBeNull();
    expect(state.health.api.ok).toBe(true);
    expect(state.health.subscription.ok).toBe(true);
    expect(state.activeRuns).toBe(0);
    expect(state.concurrency).toBe(3);
  });

  it('uses the configured default until a mode is chosen', async () => {
    ctx = await setup({ mode: 'api' });
    expect((await ctx.runtime.state()).mode).toBe('api');
    await put(ctx, { mode: 'subscription' });
    expect((await ctx.runtime.state()).mode).toBe('subscription');
  });

  it('flags an API key that Subscription mode ignores', async () => {
    ctx = await setup({ mode: 'subscription', env: { ANTHROPIC_API_KEY: 'sk-test' } });
    expect((await ctx.runtime.state()).apiKeyIgnored).toBe(true);
    await put(ctx, { mode: 'api' });
    expect((await ctx.runtime.state()).apiKeyIgnored).toBe(false);
  });
});

describe('PUT /api/runtime', () => {
  it('switches mode, persists it, logs it and publishes an event', async () => {
    ctx = await setup();
    const events: ServerEvent[] = [];
    ctx.bus.subscribe((e) => events.push(e));

    const res = await put(ctx, { mode: 'api' });
    expect(res.statusCode).toBe(200);
    expect(res.json<RuntimeState>().mode).toBe('api');
    expect(ctx.settings.get('runtime.mode')).toBe('api');
    expect(ctx.logs.at(-1)).toContain('unset -> api; credential: fake api credential');
    expect(events).toHaveLength(1);
    expect(events[0].state.mode).toBe('api');
  });

  it('refuses with 409 and the reason when the target runner is unhealthy', async () => {
    ctx = await setup({ mode: 'api' });
    ctx.runners.subscription.ok = false;
    const res = await put(ctx, { mode: 'subscription' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "Can't switch to Subscription mode.", reason: 'not signed in' });
    expect((await ctx.runtime.state()).mode).toBe('api');
  });

  it('re-checks health on every switch instead of trusting the cache', async () => {
    ctx = await setup();
    await ctx.app.inject({ method: 'GET', url: '/api/runtime' }); // caches healthy
    ctx.runners.api.ok = false;
    expect((await put(ctx, { mode: 'api' })).statusCode).toBe(409);
  });

  it('rejects unknown modes and empty bodies with 400', async () => {
    ctx = await setup();
    expect((await put(ctx, { mode: 'raw' })).statusCode).toBe(400);
    expect((await put(ctx, {})).statusCode).toBe(400);
  });

  it('sets the concurrency cap within bounds', async () => {
    ctx = await setup();
    expect((await put(ctx, { concurrency: 5 })).json<RuntimeState>().concurrency).toBe(5);
    expect((await put(ctx, { concurrency: 0 })).statusCode).toBe(400);
    expect((await put(ctx, { concurrency: 2.5 })).statusCode).toBe(400);
    expect((await ctx.runtime.state()).concurrency).toBe(5);
  });
});

describe('WS /api/events', () => {
  it('sends the current state on connect and every mode change after', async () => {
    ctx = await setup();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
    const received: ServerEvent[] = [];
    const next = () =>
      new Promise<ServerEvent>((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));

    received.push(await next());
    const changed = next();
    await put(ctx, { mode: 'subscription' });
    received.push(await changed);
    ws.close();

    expect(received.map((e) => e.state.mode)).toEqual([null, 'subscription']);
  });
});
