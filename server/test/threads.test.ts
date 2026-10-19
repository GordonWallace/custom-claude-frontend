import { afterEach, describe, expect, it } from 'vitest';
import type { Message, ServerEvent, ThreadDetail } from '@ccf/shared';
import type { RunEvent } from '../src/runners/types.js';
import { canTransition } from '../src/threadState.js';
import { setup, until } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function firstThread(c: Ctx) {
  c.threads.ensureDefaultProject();
  const [project] = c.threads.listProjects();
  return c.threads.listThreads(project.id)[0];
}

const post = (c: Ctx, threadId: string, payload: object) =>
  c.app.inject({ method: 'POST', url: `/api/threads/${threadId}/messages`, payload });

const detail = async (c: Ctx, threadId: string) =>
  (await c.app.inject({ method: 'GET', url: `/api/threads/${threadId}` })).json<ThreadDetail>();

const kinds = (messages: Message[]) => messages.map((m) => `${m.author}:${m.kind}`);

describe('posting messages', () => {
  it('runs the message, records its events and returns the thread to idle', async () => {
    ctx = await setup({ mode: 'subscription' });
    const thread = await firstThread(ctx);
    ctx.runners.subscription.script = async function* () {
      yield { type: 'init', sessionId: 'sess-1', model: 'm', mode: 'subscription' };
      yield { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } };
      yield { type: 'tool_result', id: 't1', isError: false, summary: 'contents' };
      yield { type: 'assistant_text', text: 'Hello' };
      yield { type: 'usage', inputTokens: 100, outputTokens: 5, contextTokens: 100 };
      yield { type: 'result', ok: true, finalText: 'Hello', inputTokens: 100, outputTokens: 5, notionalCostUsd: 0.2 };
    };

    expect((await post(ctx, thread.id, { text: 'Say hello' })).statusCode).toBe(202);
    await until(() => ctx!.store.getThread(thread.id)!.status === 'idle');

    const d = await detail(ctx, thread.id);
    expect(d.thread).toMatchObject({ title: 'Say hello', claudeSessionId: 'sess-1', lastMode: 'subscription', contextTokens: 100 });
    expect(kinds(d.messages)).toEqual([
      'user:text',
      'system:run_started',
      'assistant:tool_use',
      'system:tool_result',
      'assistant:text',
      'system:run_ended',
    ]);
    expect(d.runs).toEqual([expect.objectContaining({ mode: 'subscription', ok: true, inputTokens: 100, outputTokens: 5, costUsdEstimate: null })]);
    expect(d.resumeCommand).toBe('cd /tmp/ccf-test-workspaces/default && claude --resume sess-1');
    expect(ctx.store.listRunEvents(d.runs[0].id).map((e) => e.type)).toContain('tool_use');
  });

  it('resumes the stored session on the next message', async () => {
    ctx = await setup({ mode: 'subscription' });
    const thread = await firstThread(ctx);
    ctx.store.updateThread(thread.id, { claudeSessionId: 'sess-9' });
    await post(ctx, thread.id, { text: 'again' });
    await until(() => ctx!.store.getThread(thread.id)!.status === 'idle');
    expect(ctx.runners.subscription.calls[0]).toMatchObject({ kind: 'resume', sessionId: 'sess-9', message: 'again' });
  });

  it('queues a message sent mid-run into the same run', async () => {
    ctx = await setup({ mode: 'subscription' });
    const thread = await firstThread(ctx);
    let release!: () => void;
    ctx.runners.subscription.script = async function* () {
      await new Promise<void>((r) => (release = r));
      yield { type: 'result', ok: true, finalText: '' };
    };
    await post(ctx, thread.id, { text: 'one' });
    await until(() => release !== undefined);
    await post(ctx, thread.id, { text: 'two' });
    expect(ctx.runners.subscription.sent).toEqual(['two']);
    release();
    await until(() => ctx!.store.getThread(thread.id)!.status === 'idle');
    expect(ctx.runners.subscription.calls).toHaveLength(1);
  });

  it('asks once before continuing a thread in the other mode', async () => {
    ctx = await setup({ mode: 'subscription' });
    const thread = await firstThread(ctx);
    await post(ctx, thread.id, { text: 'one' });
    await until(() => ctx!.store.getThread(thread.id)!.status === 'idle');
    await ctx.runtime.setMode('api');

    const refused = await post(ctx, thread.id, { text: 'two' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'mode_changed', lastMode: 'subscription', mode: 'api' });

    expect((await post(ctx, thread.id, { text: 'two', continueInMode: 'api' })).statusCode).toBe(202);
    await until(() => ctx!.store.getThread(thread.id)!.lastMode === 'api' && ctx!.store.getThread(thread.id)!.status === 'idle');
    expect(ctx.runners.api.calls).toHaveLength(1);
  });

  it('refuses to run while the active runner is unhealthy', async () => {
    ctx = await setup({ mode: 'api' });
    const thread = await firstThread(ctx);
    ctx.runners.api.ok = false;
    const res = await post(ctx, thread.id, { text: 'hi' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'not signed in' });
  });

  it('marks a failed run and keeps its error', async () => {
    ctx = await setup({ mode: 'subscription' });
    const thread = await firstThread(ctx);
    ctx.runners.subscription.script = async function* () {
      yield { type: 'error', message: 'rate limited' };
      yield { type: 'result', ok: false, finalText: '' };
    };
    await post(ctx, thread.id, { text: 'hi' });
    await until(() => ctx!.store.getThread(thread.id)!.status === 'failed');
    expect((await detail(ctx, thread.id)).messages.some((m) => m.kind === 'error' && m.text === 'rate limited')).toBe(true);
  });
});

describe('approvals', () => {
  it('parks the thread on awaiting_permission until the user answers, and broadcasts both sides', async () => {
    ctx = await setup({ mode: 'subscription' });
    const thread = await firstThread(ctx);
    const events: ServerEvent[] = [];
    ctx.bus.subscribe((e) => events.push(e));
    let decision: unknown;
    ctx.runners.subscription.script = async function* (cfg) {
      decision = await cfg.onPermission({
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
        suggestions: [{ type: 'addRules' }],
        signal: new AbortController().signal,
      });
      yield { type: 'result', ok: true, finalText: '' };
    };

    await post(ctx, thread.id, { text: 'clean' });
    await until(() => ctx!.store.getThread(thread.id)!.status === 'awaiting_permission');
    const [approval] = (await detail(ctx, thread.id)).approvals;
    expect(approval).toMatchObject({ toolName: 'Bash', input: { command: 'rm -rf build' }, canAlwaysAllow: true });

    const res = await ctx.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}`, payload: { behavior: 'allow', always: true } });
    expect(res.statusCode).toBe(200);
    await until(() => ctx!.store.getThread(thread.id)!.status === 'idle');

    expect(decision).toEqual({ behavior: 'allow', updatedPermissions: [{ type: 'addRules' }] });
    expect(events.filter((e) => e.type.startsWith('approval_')).map((e) => e.type)).toEqual(['approval_requested', 'approval_resolved']);
    expect(
      (await ctx.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}`, payload: { behavior: 'deny' } })).statusCode,
    ).toBe(404);
  });

  it('denies a pending approval when the run is stopped', async () => {
    ctx = await setup({ mode: 'subscription' });
    const thread = await firstThread(ctx);
    let decision: unknown;
    ctx.runners.subscription.script = async function* (cfg) {
      decision = await cfg.onPermission({ toolName: 'Bash', input: {}, signal: new AbortController().signal });
      yield { type: 'result', ok: false, finalText: '' };
    };
    await post(ctx, thread.id, { text: 'x' });
    await until(() => ctx!.store.getThread(thread.id)!.status === 'awaiting_permission');

    expect((await ctx.app.inject({ method: 'POST', url: `/api/threads/${thread.id}/interrupt` })).statusCode).toBe(202);
    await until(() => ctx!.store.getThread(thread.id)!.status === 'interrupted');
    expect(ctx.runners.subscription.interrupted).toBe(true);
    expect(decision).toMatchObject({ behavior: 'deny' });
    expect((await detail(ctx, thread.id)).approvals).toEqual([]);
  });
});

describe('session ids, restarts and plan usage', () => {
  it('takes the session id from the SessionStart hook', async () => {
    ctx = await setup({ mode: 'subscription' });
    const thread = await firstThread(ctx);
    let release!: () => void;
    ctx.runners.subscription.script = async function* () {
      await new Promise<void>((r) => (release = r));
      yield { type: 'result', ok: true, finalText: '' };
    };
    await post(ctx, thread.id, { text: 'x' });
    await until(() => release !== undefined);
    const url = ctx.runners.subscription.calls[0].cfg.sessionHookUrl!;
    const path = new URL(url).pathname;

    expect((await ctx.app.inject({ method: 'POST', url: path, payload: { session_id: 'from-hook', source: 'startup' } })).statusCode).toBe(204);
    expect(ctx.store.getThread(thread.id)!.claudeSessionId).toBe('from-hook');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/hooks/session-start/bogus', payload: { session_id: 'x' } })).statusCode).toBe(404);
    release();
  });

  it('marks runs a restart cut off as interrupted', async () => {
    ctx = await setup({ mode: 'subscription' });
    const thread = await firstThread(ctx);
    ctx.store.startRun(thread.id, 'subscription');
    ctx.store.updateThread(thread.id, { status: 'running' });
    ctx.threads.recoverAfterRestart();
    expect(ctx.store.getThread(thread.id)!.status).toBe('interrupted');
    expect(ctx.store.listRuns(thread.id)[0]).toMatchObject({ ok: false, endedAt: expect.any(String) });
  });

  it('records plan usage from Subscription runs only', async () => {
    ctx = await setup({ mode: 'api' });
    const thread = await firstThread(ctx);
    const usage: RunEvent = { type: 'plan_usage', status: 'allowed', fiveHour: { utilization: 0.4 } };
    const script = async function* () {
      yield usage;
      yield { type: 'result', ok: true, finalText: '' } as RunEvent;
    };
    ctx.runners.api.script = script;
    ctx.runners.subscription.script = script;

    await post(ctx, thread.id, { text: 'x' });
    await until(() => ctx!.store.getThread(thread.id)!.status === 'idle');
    expect((await ctx.runtime.state()).planUsage).toBeNull();

    await ctx.runtime.setMode('subscription');
    await post(ctx, thread.id, { text: 'y', continueInMode: 'subscription' });
    await until(() => ctx!.store.getThread(thread.id)!.lastMode === 'subscription' && ctx!.store.getThread(thread.id)!.status === 'idle');
    expect((await ctx.runtime.state()).planUsage).toMatchObject({ fiveHour: { utilization: 0.4 } });
  });

  it('sums estimated spend over API runs only', async () => {
    ctx = await setup({ mode: 'api' });
    const thread = await firstThread(ctx);
    ctx.runners.api.script = async function* () {
      yield { type: 'result', ok: true, finalText: '', costUsdEstimate: 0.25 };
    };
    await post(ctx, thread.id, { text: 'x' });
    await until(() => ctx!.store.getThread(thread.id)!.status === 'idle');
    expect((await ctx.runtime.state()).spendUsdEstimate).toBeCloseTo(0.25);
  });
});

describe('thread state machine', () => {
  it('allows only the defined moves', () => {
    expect(canTransition('idle', 'running')).toBe(true);
    expect(canTransition('running', 'awaiting_permission')).toBe(true);
    expect(canTransition('idle', 'awaiting_permission')).toBe(false);
    expect(canTransition('interrupted', 'idle')).toBe(false);
  });
});
