import { describe, expect, it } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ApiRunner } from '../src/runners/apiRunner.js';
import { CliRunner } from '../src/runners/cliRunner.js';
import { type QueryFn, TurnInput } from '../src/runners/sdkRunner.js';
import type { PermissionRequest, RunConfig } from '../src/runners/types.js';

const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.01, usage: {} } as unknown as SDKMessage;

/** A fake query() that records its options and answers each user turn with a result. */
function fakeQuery() {
  const seen: { options?: Options; prompts: string[] } = { prompts: [] };
  const fn = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    seen.options = options;
    async function* run() {
      for await (const msg of prompt) {
        seen.prompts.push(msg.message.content as string);
        yield result;
      }
    }
    return Object.assign(run(), { interrupt: async () => undefined });
  }) as unknown as QueryFn;
  return { fn, seen };
}

const cfg = (over: Partial<RunConfig> = {}): RunConfig => ({
  cwd: '/w',
  mcpServers: [],
  permissionMode: 'default',
  onPermission: async () => ({ behavior: 'allow' }),
  ...over,
});

async function drain(events: AsyncIterable<unknown>) {
  for await (const _ of events) void _;
}

describe('TurnInput', () => {
  it('yields one queued follow-up per finished turn, then ends', async () => {
    const input = new TurnInput('first');
    const it = input[Symbol.asyncIterator]();
    expect((await it.next()).value?.message.content).toBe('first');
    const pending = it.next();
    input.push('second');
    input.turnDone();
    expect((await pending).value?.message.content).toBe('second');
    input.turnDone();
    expect((await it.next()).done).toBe(true);
  });

  it('stays open while background tasks run, for the turn the CLI starts when they finish', async () => {
    const input = new TurnInput('first');
    const it = input[Symbol.asyncIterator]();
    await it.next();
    input.setBackground(1);
    input.turnDone();
    const pending = it.next();
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(input.push('still listening')).toBe(true);
    expect((await pending).value?.message.content).toBe('still listening');

    // The task finishes and the CLI reports it in a turn of its own; then the stream can end.
    input.setBackground(0);
    input.turnDone();
    const after = it.next();
    input.cliTurnStarted();
    input.turnDone();
    expect((await after).done).toBe(true);
  });
});

describe('SdkRunner launch profiles', () => {
  it('runs Subscription mode on the user\'s claude with API credentials stripped', async () => {
    const { fn, seen } = fakeQuery();
    const runner = new CliRunner('/opt/bin/claude', { PATH: '/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_USE_BEDROCK: '1' }, fn);
    await drain(runner.start(cfg({ sessionHookUrl: 'http://127.0.0.1:1/api/hooks/session-start/t' }), 'hi').events);

    expect(seen.options?.pathToClaudeCodeExecutable).toBe('/opt/bin/claude');
    expect(seen.options?.env).toEqual({ PATH: '/bin', HOME: '/home/u', CLAUDE_CODE_ENTRYPOINT: 'cli' });
    expect(JSON.stringify(seen.options?.settings)).toContain('session-start/t');
  });

  it('runs API mode on the bundled executable with the key', async () => {
    const { fn, seen } = fakeQuery();
    await drain(new ApiRunner({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk' }, fn).resume('sess-1', cfg(), 'hi').events);
    expect(seen.options?.pathToClaudeCodeExecutable).toBeUndefined();
    expect(seen.options?.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_ENTRYPOINT: 'cli' });
    expect(seen.options?.resume).toBe('sess-1');
  });

  it('runs a follow-up sent mid-run as the next turn of the same run', async () => {
    const { fn, seen } = fakeQuery();
    const handle = new CliRunner('/c', {}, fn).start(cfg(), 'one');
    handle.send('two');
    await drain(handle.events);
    expect(seen.prompts).toEqual(['one', 'two']);
  });

  it('routes canUseTool through onPermission, passing suggestions back on "always allow"', async () => {
    const { fn, seen } = fakeQuery();
    const requests: PermissionRequest[] = [];
    const handle = new CliRunner('/c', {}, fn).start(
      cfg({
        onPermission: async (req) => {
          requests.push(req);
          return req.toolName === 'Write'
            ? { behavior: 'allow', updatedPermissions: req.suggestions }
            : { behavior: 'deny', message: 'no' };
        },
      }),
      'x',
    );
    await drain(handle.events);
    const canUseTool = seen.options!.canUseTool!;
    const signal = new AbortController().signal;
    const suggestions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
    expect(await canUseTool('Write', { a: 1 }, { signal, suggestions: suggestions as never, toolUseID: 't1', requestId: 'r1' })).toEqual({
      behavior: 'allow',
      updatedInput: { a: 1 },
      updatedPermissions: suggestions,
    });
    expect(await canUseTool('Bash', {}, { signal, toolUseID: 't2', requestId: 'r2' })).toEqual({ behavior: 'deny', message: 'no' });
    expect(requests.map((r) => r.toolUseId)).toEqual(['t1', 't2']);
  });
});
