import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ApiRunner } from '../src/runners/apiRunner.js';
import { CliRunner } from '../src/runners/cliRunner.js';
import { mapSdkMessage } from '../src/runners/mapSdkMessage.js';
import type { QueryFn } from '../src/runners/sdkRunner.js';
import type { RunConfig, RunEvent } from '../src/runners/types.js';

// Recorded from claude 2.1.303 in Subscription mode (a Write tool call, approved). API mode drives the
// same CLI protocol through the same SDK, so both runners must turn this stream into the same events.
const recorded = JSON.parse(
  fs.readFileSync(new URL('./fixtures/tool-run.stream.json', import.meta.url), 'utf8'),
) as SDKMessage[];

const replay: QueryFn = (() => {
  async function* messages() {
    for (const m of recorded) yield m;
  }
  return Object.assign(messages(), { interrupt: async () => undefined });
}) as unknown as QueryFn;

const cfg: RunConfig = {
  cwd: '/workspace',
  mcpServers: [],
  permissionMode: 'default',
  onPermission: async () => ({ behavior: 'allow' }),
};

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('recorded-stream contract', () => {
  it('normalizes the recorded stream into the expected events', () => {
    const events = recorded.flatMap((m) => mapSdkMessage(m, 'subscription'));
    expect(events.map((e) => e.type)).toEqual([
      'init',
      'tool_use',
      'usage',
      'plan_usage',
      'tool_result',
      'assistant_text',
      'usage',
      'result',
    ]);
    expect(events[0]).toMatchObject({ type: 'init', sessionId: '411c6bf2-f0a1-4f4e-8919-9aa965d177b4', mode: 'subscription' });
    expect(events[1]).toMatchObject({ type: 'tool_use', name: 'Write', input: { file_path: '/workspace/hello.txt', content: 'hi' } });
    expect(events[3]).toMatchObject({ type: 'plan_usage', fiveHour: { utilization: 0.61 }, sevenDay: { utilization: 0.15 } });
    expect(events[4]).toMatchObject({ type: 'tool_result', isError: false });
    expect(events[5]).toEqual({ type: 'assistant_text', text: 'done' });
    expect(events.at(-1)).toMatchObject({ type: 'result', ok: true, finalText: 'done', costUsdEstimate: undefined });
  });

  it('gives the same events from both runners, except that only API mode reports billed cost', async () => {
    const api = await collect(new ApiRunner({ ANTHROPIC_API_KEY: 'sk' }, replay).start(cfg, 'hi').events);
    const sub = await collect(new CliRunner('/usr/bin/claude', { PATH: '/bin' }, replay).start(cfg, 'hi').events);

    const strip = (events: RunEvent[]) =>
      events.map((e) => (e.type === 'init' ? { ...e, mode: undefined } : e.type === 'result' ? { ...e, costUsdEstimate: undefined } : e));
    expect(strip(api)).toEqual(strip(sub));
    expect(api.at(-1)).toMatchObject({ type: 'result', costUsdEstimate: expect.any(Number) });
    expect(sub.at(-1)).toMatchObject({ type: 'result', costUsdEstimate: undefined, notionalCostUsd: expect.any(Number) });
  });
});
