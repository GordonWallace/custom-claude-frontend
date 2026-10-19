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
      disallowedTools: cfg.disallowedTools,
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
            const context = await contextUsage(q);
            if (context) yield context;
            input.turnDone();
          }
        }
      } catch (err) {
        // The SDK also throws for an error result it has already delivered; that one is reported.
        if (sawResult) return;
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

/**
 * Asks the CLI how full the context window is, between turns while it is still listening. Optional:
 * an older CLI that doesn't answer just leaves the meter on the last turn's token count.
 */
async function contextUsage(q: ReturnType<QueryFn>): Promise<RunEvent | undefined> {
  if (typeof q.getContextUsage !== 'function') return undefined;
  try {
    // Bounded, so a CLI that never answers can't hold the run open.
    const usage = await Promise.race([
      q.getContextUsage({ detail: 'summary' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000).unref()),
    ]);
    return { type: 'context', usedTokens: usage.totalTokens, maxTokens: usage.maxTokens, autoCompactAt: usage.autoCompactThreshold };
  } catch {
    return undefined;
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
  /** Set once the stream has ended: the CLI is exiting and won't read another turn. */
  private ended = false;
  private wake?: () => void;

  constructor(first: string) {
    this.queue = [first];
  }

  /** Queues a follow-up turn; false if the stream has already ended. */
  push(text: string): boolean {
    if (this.closed || this.ended) return false;
    this.queue.push(text);
    this.notify();
    return true;
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
        if (next === undefined) {
          this.ended = true;
          return;
        }
        this.turnOpen = true;
        yield { type: 'user', message: { role: 'user', content: next }, parent_tool_use_id: null, session_id: '' };
        continue;
      }
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
    this.ended = true;
  }

  private notify(): void {
    this.wake?.();
    this.wake = undefined;
  }
}
