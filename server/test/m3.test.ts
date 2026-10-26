import fs from 'node:fs';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectUsage } from '@ccf/shared';
import { calibrate, type PlanReading, projectUsage, type RunWeight } from '../src/planUsage.js';
import { CliRunner } from '../src/runners/cliRunner.js';
import type { QueryFn } from '../src/runners/sdkRunner.js';
import type { RunEvent } from '../src/runners/types.js';
import { setup, until } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

function defaultProject(c: Ctx) {
  c.threads.ensureDefaultProject();
  return c.threads.listProjects()[0];
}

const reading = (at: string, week: number, resets = '2026-10-25T00:00:00.000Z'): PlanReading => ({
  at,
  sevenDay: { utilization: week, resetsAt: resets },
});
const run = (runId: number, threadId: string, endedAt: string, usd: number, projectId = 'p'): RunWeight => ({
  runId,
  threadId,
  projectId,
  endedAt,
  usd,
});

describe('plan usage estimates', () => {
  it('learns percentage points per notional dollar from meter rises during app runs', () => {
    const readings = [reading('t1', 0.1), reading('t3', 0.12), reading('t5', 0.12), reading('t7', 0.15)];
    const runs = [run(1, 'a', 't2', 1), run(2, 'b', 't4', 1)];
    // t1→t3: +2 points over $1; t3→t5: 0 points over $1 (still counted); t5→t7: +3 points, no app run.
    expect(calibrate(readings, runs, 'sevenDay')).toEqual({ pctPerUsd: expect.closeTo(1), samples: 1, unattributedPct: expect.closeTo(3) });
  });

  it('ignores pairs that straddle a window reset', () => {
    const readings = [reading('t1', 0.9, 'old'), reading('t3', 0.02, 'new')];
    expect(calibrate(readings, [run(1, 'a', 't2', 5)], 'sevenDay').pctPerUsd).toBeNull();
  });

  it('splits the current window between threads and sums the project', () => {
    const readings = [reading('2026-10-19T10:00:00.000Z', 0.1), reading('2026-10-19T12:00:00.000Z', 0.14)];
    const runs = [
      run(1, 'a', '2026-10-19T11:00:00.000Z', 3),
      run(2, 'b', '2026-10-19T11:30:00.000Z', 1),
      run(3, 'c', '2026-10-19T11:40:00.000Z', 4, 'other'),
    ];
    const usage = projectUsage(readings, runs, 'p', Date.parse('2026-10-19T13:00:00.000Z'));
    // 4 points over $8 → 0.5 points per dollar.
    expect(usage.calibration.sevenDay.pctPerUsd).toBeCloseTo(0.5);
    expect(usage.threads.a).toMatchObject({ notionalUsd: 3, sevenDay: expect.closeTo(1.5), fiveHour: null });
    expect(usage.project).toMatchObject({ notionalUsd: 4, sevenDay: expect.closeTo(2) });
    expect(usage.threads.c).toBeUndefined();
  });

  it('records readings and notional cost from Subscription runs and serves the estimate', async () => {
    ctx = await setup({ mode: 'subscription' });
    const p = defaultProject(ctx);
    const thread = ctx.threads.createThread(p.id);
    let n = 0;
    ctx.runners.subscription.script = async function* () {
      n++;
      yield { type: 'plan_usage', sevenDay: { utilization: 0.1 + 0.02 * n, resetsAt: '2026-10-25T00:00:00.000Z' } };
      // Readings and run ends are compared by timestamp, so keep them apart.
      await new Promise((r) => setTimeout(r, 5));
      yield { type: 'result', ok: true, finalText: 'ok', notionalCostUsd: 2 };
    };
    for (const text of ['one', 'two']) {
      await ctx.app.inject({ method: 'POST', url: `/api/threads/${thread.id}/messages`, payload: { text } });
      await until(() => ctx!.store.getThread(thread.id)!.status === 'idle');
    }
    const usage = (await ctx.app.inject({ method: 'GET', url: `/api/projects/${p.id}/usage` })).json<ProjectUsage>();
    // Run one ended between the two readings: +2 points over $2.
    expect(usage.calibration.sevenDay.pctPerUsd).toBeCloseTo(1);
    expect(usage.threads[thread.id]).toMatchObject({ notionalUsd: 4, sevenDay: expect.closeTo(4) });
  });
});

describe('memory', () => {
  it('puts MEMORY.md in every session prompt and edits it through the API', async () => {
    ctx = await setup({ mode: 'subscription' });
    const p = defaultProject(ctx);
    const put = await ctx.app.inject({ method: 'PUT', url: `/api/projects/${p.id}/memory`, payload: { text: 'Deploys go out on Fridays.' } });
    expect(put.json()).toEqual({ text: 'Deploys go out on Fridays.\n' });
    expect(fs.readFileSync(`${p.workspacePath}/MEMORY.md`, 'utf8')).toBe('Deploys go out on Fridays.\n');

    const thread = ctx.threads.createThread(p.id);
    await ctx.app.inject({ method: 'POST', url: `/api/threads/${thread.id}/messages`, payload: { text: 'hi' } });
    await until(() => ctx!.store.getThread(thread.id)!.status === 'idle');
    const prompt = ctx.runners.subscription.calls[0].cfg.appendSystemPrompt!;
    expect(prompt).toContain('<project-memory>\nDeploys go out on Fridays.\n</project-memory>');
    expect(prompt).toContain('write_memory');
    fs.rmSync(`${p.workspacePath}/MEMORY.md`);
  });
});

describe('context', () => {
  it('keeps the context meter from context reports and marks compactions', async () => {
    ctx = await setup({ mode: 'subscription' });
    const p = defaultProject(ctx);
    const thread = ctx.threads.createThread(p.id);
    ctx.runners.subscription.script = async function* () {
      yield { type: 'compacted', trigger: 'auto', preTokens: 167_000, postTokens: 21_000 };
      yield { type: 'result', ok: true, finalText: 'ok' };
      yield { type: 'context', usedTokens: 24_000, maxTokens: 200_000, autoCompactAt: 167_000 };
    };
    await ctx.app.inject({ method: 'POST', url: `/api/threads/${thread.id}/messages`, payload: { text: 'hi' } });
    await until(() => ctx!.store.getThread(thread.id)!.status === 'idle');
    expect(ctx.store.getThread(thread.id)).toMatchObject({ contextTokens: 24_000, contextWindow: 200_000, autoCompactAt: 167_000 });
    expect(ctx.store.listMessages(thread.id).find((m) => m.kind === 'compacted')).toMatchObject({
      text: 'Context compacted automatically · 167k → 21k tokens',
      meta: { trigger: 'auto', preTokens: 167_000, postTokens: 21_000 },
    });
  });

  it('asks the CLI for context use after each turn', async () => {
    const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, usage: {} } as unknown as SDKMessage;
    const fn = (({ prompt }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      async function* go() {
        for await (const _ of prompt) yield result;
      }
      return Object.assign(go(), {
        interrupt: async () => undefined,
        getContextUsage: async () => ({ totalTokens: 1234, maxTokens: 200_000, autoCompactThreshold: 160_000 }),
      });
    }) as unknown as QueryFn;
    const events: RunEvent[] = [];
    const handle = new CliRunner('/c', {}, fn).start(
      { cwd: '/w', mcpServers: [], permissionMode: 'default', onPermission: async () => ({ behavior: 'allow' }) },
      'hi',
    );
    for await (const e of handle.events) events.push(e);
    expect(events).toContainEqual({ type: 'context', usedTokens: 1234, maxTokens: 200_000, autoCompactAt: 160_000 });
  });
});

describe('fresh coordinator', () => {
  it('retires the session and seeds the next one with the project threads', async () => {
    ctx = await setup({ mode: 'subscription' });
    const p = defaultProject(ctx);
    ctx.runners.subscription.script = async function* () {
      yield { type: 'init', sessionId: 'coord-1', model: 'm', mode: 'subscription' };
      yield { type: 'result', ok: true, finalText: 'ok' };
    };
    const send = (text: string) => ctx!.app.inject({ method: 'POST', url: `/api/threads/${p.coordinatorThreadId}/messages`, payload: { text } });
    await send('first');
    await until(() => ctx!.store.getThread(p.coordinatorThreadId)!.status === 'idle');
    ctx.threads.startThreadFor({ threadId: p.coordinatorThreadId, projectId: p.id, kind: 'coordinator' }, 'Research A', 'research A');
    await until(() => ctx!.runners.subscription.calls.length >= 3 && ctx!.store.getThread(p.coordinatorThreadId)!.status === 'idle');

    const res = await ctx.app.inject({ method: 'POST', url: `/api/projects/${p.id}/coordinator/reset` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ claudeSessionId: null });

    const before = ctx.runners.subscription.calls.length;
    await send('what is running?');
    await until(() => ctx!.runners.subscription.calls.length > before);
    const call = ctx.runners.subscription.calls[before];
    expect(call.kind).toBe('start');
    expect(call.message).toMatch(/^\[Fresh coordinator session\]/);
    expect(call.message).toMatch(/- Research A \(thread_id: [\w-]+\) · idle/);
    expect(call.message.endsWith("The user's message:\n\nwhat is running?")).toBe(true);
    expect(ctx.store.listMessages(p.coordinatorThreadId).some((m) => m.kind === 'session_reset')).toBe(true);
  });

  it('refuses while the coordinator is working', async () => {
    ctx = await setup({ mode: 'subscription' });
    const p = defaultProject(ctx);
    let release!: () => void;
    ctx.runners.subscription.script = async function* () {
      await new Promise<void>((r) => (release = r));
      yield { type: 'result', ok: true, finalText: '' };
    };
    await ctx.app.inject({ method: 'POST', url: `/api/threads/${p.coordinatorThreadId}/messages`, payload: { text: 'x' } });
    await until(() => release !== undefined);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/projects/${p.id}/coordinator/reset` })).statusCode).toBe(409);
    release();
  });
});
