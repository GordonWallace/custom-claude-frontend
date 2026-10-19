import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunConfig } from '../src/runners/types.js';
import type { RunContext } from '../src/threads.js';
import { setup, until } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

/** Runs that wait until the test releases them, keyed by the first line of their first message. */
function gatedRuns(c: Ctx) {
  const gates = new Map<string, () => void>();
  const configs = new Map<string, RunConfig>();
  c.runners.subscription.script = async function* (cfg, message) {
    const key = message.split('\n')[0];
    configs.set(key, cfg);
    await new Promise<void>((resolve) => gates.set(key, resolve));
    yield { type: 'assistant_text', text: `result of ${key}` };
    yield { type: 'result', ok: true, finalText: `result of ${key}` };
  };
  return {
    started: (key: string) => gates.has(key),
    release: (key: string) => gates.get(key)!(),
    config: (key: string) => configs.get(key)!,
  };
}

function project(c: Ctx) {
  c.threads.ensureDefaultProject();
  const [p] = c.threads.listProjects();
  const coordinator: RunContext = { threadId: p.coordinatorThreadId, projectId: p.id, kind: 'coordinator' };
  return { project: p, coordinator };
}

const textOf = (result: Record<string, unknown>) => (result.content as { text: string }[]).map((c) => c.text).join('\n');

const status = (c: Ctx, id: string) => c.store.getThread(id)!.status;

describe('scheduler', () => {
  it('runs coordinator threads in parallel up to the concurrency cap and starts the rest as slots free', async () => {
    ctx = await setup({ mode: 'subscription' });
    await ctx.runtime.setConcurrency(2);
    const runs = gatedRuns(ctx);
    const { coordinator } = project(ctx);

    const a = ctx.threads.startThreadFor(coordinator, 'A', 'research A');
    const b = ctx.threads.startThreadFor(coordinator, 'B', 'research B');
    const c = ctx.threads.startThreadFor(coordinator, 'C', 'research C');
    await until(() => runs.started('research A') && runs.started('research B'));
    await ctx.threads.pump();
    expect([status(ctx, a.id), status(ctx, b.id), status(ctx, c.id)]).toEqual(['running', 'running', 'queued']);

    runs.release('research A');
    await until(() => runs.started('research C'));
    expect(status(ctx, c.id)).toBe('running');
  });

  it('never makes the coordinator wait for a slot', async () => {
    ctx = await setup({ mode: 'subscription' });
    await ctx.runtime.setConcurrency(1);
    const runs = gatedRuns(ctx);
    const { project: p, coordinator } = project(ctx);
    ctx.threads.startThreadFor(coordinator, 'A', 'research A');
    await until(() => runs.started('research A'));

    await ctx.app.inject({ method: 'POST', url: `/api/threads/${p.coordinatorThreadId}/messages`, payload: { text: 'hello coordinator' } });
    await until(() => runs.started('hello coordinator'));
  });

  it('fails queued threads clearly when the runner is unusable', async () => {
    ctx = await setup({ mode: 'subscription' });
    const { coordinator } = project(ctx);
    ctx.runners.subscription.ok = false;
    const a = ctx.threads.startThreadFor(coordinator, 'A', 'research A');
    await until(() => status(ctx!, a.id) === 'failed');
    expect(ctx.store.listMessages(a.id).at(-1)).toMatchObject({ kind: 'error', text: expect.stringContaining('not signed in') });
  });

  it('keeps queued input across a restart and starts it when the scheduler runs', async () => {
    ctx = await setup({ mode: 'subscription' });
    const { project: p } = project(ctx);
    const thread = ctx.threads.createThread(p.id);
    ctx.store.updateThread(thread.id, { status: 'running' });
    ctx.store.enqueueInput(thread.id, 'left over');
    ctx.threads.recoverAfterRestart();
    expect(status(ctx, thread.id)).toBe('queued');
    await ctx.threads.pump();
    await until(() => status(ctx!, thread.id) === 'idle');
    expect(ctx.runners.subscription.calls[0].message).toBe('left over');
  });

  it('drops queued input when a waiting thread is stopped', async () => {
    ctx = await setup({ mode: 'subscription' });
    await ctx.runtime.setConcurrency(1);
    const runs = gatedRuns(ctx);
    const { coordinator } = project(ctx);
    ctx.threads.startThreadFor(coordinator, 'A', 'research A');
    const b = ctx.threads.startThreadFor(coordinator, 'B', 'research B');
    await until(() => runs.started('research A'));
    await ctx.threads.interrupt(b.id);
    expect(status(ctx, b.id)).toBe('idle');
    expect(ctx.store.hasQueuedInput(b.id)).toBe(false);
  });
});

describe('completion notices', () => {
  it('tells the coordinator when a thread it started finishes, with the final text trimmed', async () => {
    ctx = await setup({ mode: 'subscription' });
    const { project: p, coordinator } = project(ctx);
    const long = 'x'.repeat(5000);
    ctx.runners.subscription.script = async function* (_cfg, message) {
      yield { type: 'result', ok: true, finalText: message.startsWith('[Thread update]') ? 'Noted.' : long };
    };

    const a = ctx.threads.startThreadFor(coordinator, 'Research A', 'research A');
    await until(() => ctx!.runners.subscription.calls.length === 2 && status(ctx!, p.coordinatorThreadId) === 'idle');

    expect(status(ctx, a.id)).toBe('idle');
    const notice = ctx.runners.subscription.calls[1];
    expect(notice.message).toMatch(new RegExp(`^\\[Thread update\\] "Research A" \\(thread_id: ${a.id}\\) finished\\.`));
    expect(notice.message.length).toBeLessThan(4200);
    expect(notice.message).toMatch(/\[Cut at 4,000 characters\. Use read_thread for the full message\.\]$/);
    expect(ctx.store.listMessages(p.coordinatorThreadId).map((m) => m.kind)).toEqual([
      'thread_started',
      'thread_notice',
      'run_started',
      'run_ended',
    ]);
    expect(ctx.store.listMessages(a.id)[0]).toMatchObject({ author: 'user', text: 'research A', meta: { from: 'coordinator' } });
  });

  it('joins a coordinator run that is still taking input, and queues the notice when it is not', async () => {
    ctx = await setup({ mode: 'subscription' });
    const runs = gatedRuns(ctx);
    const { project: p, coordinator } = project(ctx);
    // A session id, so the later run resumes rather than starting a fresh, seeded coordinator.
    ctx.store.updateThread(p.coordinatorThreadId, { claudeSessionId: 'coord-session' });
    await ctx.app.inject({ method: 'POST', url: `/api/threads/${p.coordinatorThreadId}/messages`, payload: { text: 'plan' } });
    await until(() => runs.started('plan'));

    ctx.threads.startThreadFor(coordinator, 'A', 'research A');
    await until(() => runs.started('research A'));
    runs.release('research A');
    await until(() => ctx!.runners.subscription.sent.length === 1);
    expect(ctx.runners.subscription.sent[0]).toMatch(/^\[Thread update\] "A"/);

    ctx.runners.subscription.acceptSends = false;
    ctx.threads.startThreadFor(coordinator, 'B', 'research B');
    await until(() => runs.started('research B'));
    runs.release('research B');
    await until(() => ctx!.store.hasQueuedInput(p.coordinatorThreadId));
    runs.release('plan');
    await until(() => runs.started('[Thread update] "B" (thread_id: ' + ctx!.store.listThreads(p.id).find((t) => t.title === 'B')!.id + ') finished.'));
  });

  it('does not notify for threads the user opened', async () => {
    ctx = await setup({ mode: 'subscription' });
    const { project: p } = project(ctx);
    const thread = ctx.threads.createThread(p.id);
    await ctx.app.inject({ method: 'POST', url: `/api/threads/${thread.id}/messages`, payload: { text: 'hi' } });
    await until(() => status(ctx!, thread.id) === 'idle');
    expect(ctx.runners.subscription.calls).toHaveLength(1);
    expect(ctx.store.listMessages(p.coordinatorThreadId)).toEqual([]);
  });
});

describe('the app MCP server', () => {
  async function connect(c: Ctx, cfg: RunConfig) {
    await c.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = c.app.server.address() as AddressInfo;
    const [server] = cfg.mcpServers;
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: server.headers } }),
    );
    return client;
  }

  it('gives the coordinator its tools, pre-approved, and starts threads through them', async () => {
    ctx = await setup({ mode: 'subscription' });
    const runs = gatedRuns(ctx);
    const { project: p } = project(ctx);
    await ctx.app.inject({ method: 'POST', url: `/api/threads/${p.coordinatorThreadId}/messages`, payload: { text: 'plan' } });
    await until(() => runs.started('plan'));
    const cfg = runs.config('plan');
    expect(cfg.allowedTools).toEqual(expect.arrayContaining(['mcp__app__start_thread', 'mcp__app__write_memory']));
    expect(cfg.disallowedTools).toEqual(['Task', 'Agent']);
    expect(cfg.appendSystemPrompt).toContain('project coordinator');

    const client = await connect(ctx, cfg);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['list_threads', 'message_thread', 'read_memory', 'read_thread', 'start_thread', 'write_memory'].sort(),
    );

    const started = await client.callTool({ name: 'start_thread', arguments: { title: 'Research A', brief: 'research A' } });
    expect(textOf(started)).toContain('Started thread "Research A"');
    await until(() => runs.started('research A'));

    const listed = await client.callTool({ name: 'list_threads', arguments: {} });
    expect(textOf(listed)).toMatch(/Research A \(thread_id: [\w-]+\) · running/);

    const bad = await client.callTool({ name: 'message_thread', arguments: { thread_id: 'nope', text: 'hi' } });
    expect(bad.isError).toBe(true);

    await client.callTool({ name: 'write_memory', arguments: { text: 'The user prefers short answers.' } });
    const memory = await client.callTool({ name: 'read_memory', arguments: {} });
    expect(textOf(memory)).toContain('prefers short answers');
    await client.close();
  });

  it('gives a thread only the memory tools and rejects unknown tokens', async () => {
    ctx = await setup({ mode: 'subscription' });
    const runs = gatedRuns(ctx);
    const { coordinator } = project(ctx);
    ctx.threads.startThreadFor(coordinator, 'A', 'research A');
    await until(() => runs.started('research A'));
    const cfg = runs.config('research A');
    expect(cfg.disallowedTools).toBeUndefined();
    expect(cfg.appendSystemPrompt).toContain('a thread in a project');

    const client = await connect(ctx, cfg);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['read_memory', 'write_memory']);
    await client.close();

    const { port } = ctx.app.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer bogus', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });
});
