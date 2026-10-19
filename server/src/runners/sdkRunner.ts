import { fileURLToPath } from 'node:url';
import { query as sdkQuery, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapSdkMessage } from './mapSdkMessage.js';
import type { RunConfig, RunEvent, RunHandle, RunnerHealth, RunnerMode, SessionRunner } from './types.js';

export type QueryFn = typeof sdkQuery;

/** How a profile launches Claude Code: which executable, with which environment. */
export interface LaunchProfile {
  /** Undefined means the Agent SDK's bundled executable. */
  executablePath?: string;
  /** The child's whole environment: since SDK 0.2.113 this replaces process.env rather than merging. */
  env: Record<string, string | undefined>;
}

/**
 * One runner for both modes: the Agent SDK's query(), which speaks the CLI's stream-json control
 * protocol. Tool approvals arrive as can_use_tool control requests (canUseTool) in either mode.
 * Subclasses differ only in health checks and LaunchProfile.
 */
export abstract class SdkRunner implements SessionRunner {
  abstract readonly mode: RunnerMode;
  abstract health(): Promise<RunnerHealth>;
  protected abstract launchProfile(): LaunchProfile;

  constructor(protected readonly queryFn: QueryFn = sdkQuery) {}

  start(cfg: RunConfig, firstMessage: string): RunHandle {
    return this.run(cfg, firstMessage);
  }

  resume(sessionId: string, cfg: RunConfig, message: string): RunHandle {
    return this.run(cfg, message, sessionId);
  }

  private run(cfg: RunConfig, message: string, resume?: string): RunHandle {
    const { executablePath, env } = this.launchProfile();
    const input = new TurnInput(message);
    const stderr: string[] = [];
    const options: Options = {
      cwd: cfg.cwd,
      model: cfg.model,
      resume,
      pathToClaudeCodeExecutable: executablePath,
      // CLAUDE_CODE_ENTRYPOINT=cli makes the transcript look like a plain `claude -p` session rather than an SDK one.
      env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
      permissionMode: cfg.permissionMode,
      allowedTools: cfg.allowedTools,
      maxTurns: cfg.maxTurns,
      systemPrompt: cfg.appendSystemPrompt
        ? { type: 'preset', preset: 'claude_code', append: cfg.appendSystemPrompt }
        : undefined,
      mcpServers: Object.fromEntries(
        cfg.mcpServers.map(({ name, ...server }) => [name, server]),
      ),
      settings: cfg.sessionHookUrl ? sessionHookSettings(cfg.sessionHookUrl) : undefined,
      canUseTool: async (toolName, toolInput, opts) => {
        const decision = await cfg.onPermission({
          toolName,
          input: toolInput,
          toolUseId: opts.toolUseID,
          decisionReason: opts.decisionReason,
          suggestions: opts.suggestions,
          signal: opts.signal,
        });
        return decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: toolInput, updatedPermissions: decision.updatedPermissions as never }
          : { behavior: 'deny', message: decision.message };
      },
      stderr: (data) => {
        stderr.push(data);
        if (stderr.length > 50) stderr.shift();
      },
    };

    const q = this.queryFn({ prompt: input, options });
    const mode = this.mode;

    async function* events(): AsyncGenerator<RunEvent> {
      let sawResult = false;
      try {
        for await (const msg of q) {
          for (const event of mapSdkMessage(msg, mode)) yield event;
          if (msg.type === 'result') {
            sawResult = true;
            input.turnDone();
          }
        }
      } catch (err) {
        const detail = stderr.join('').trim().split('\n').slice(-5).join('\n');
        yield { type: 'error', message: [(err as Error).message, detail].filter(Boolean).join('\n') };
        if (!sawResult) yield { type: 'result', ok: false, finalText: (err as Error).message };
      } finally {
        input.close();
      }
    }

    return {
      events: events(),
      send: (text) => input.push(text),
      interrupt: async () => {
        input.close();
        await q.interrupt().catch(() => q.return(undefined));
      },
    };
  }
}

/** Settings carrying a SessionStart command hook that POSTs the hook's JSON (with session_id) to the app. */
export function sessionHookSettings(url: string) {
  const script = fileURLToPath(new URL('../../hooks/post-hook.mjs', import.meta.url));
  return {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command' as const, command: `"${process.execPath}" "${script}" "${url}"`, timeout: 10 }] },
      ],
    },
  };
}

/**
 * The streaming prompt for one run: yields the first message, then one queued follow-up per
 * finished turn, and ends when a turn finishes with nothing queued (which lets the CLI exit).
 */
export class TurnInput implements AsyncIterable<SDKUserMessage> {
  private readonly queue: string[];
  private turnOpen = false;
  private closed = false;
  private wake?: () => void;

  constructor(first: string) {
    this.queue = [first];
  }

  push(text: string): void {
    this.queue.push(text);
    this.notify();
  }

  turnDone(): void {
    this.turnOpen = false;
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (!this.turnOpen) {
        const next = this.queue.shift();
        if (next === undefined) return;
        this.turnOpen = true;
        yield { type: 'user', message: { role: 'user', content: next }, parent_tool_use_id: null, session_id: '' };
        continue;
      }
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private notify(): void {
    this.wake?.();
    this.wake = undefined;
  }
}
