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
      ...(cfg.thinking === 'off' ? { thinking: { type: 'disabled' as const } } : cfg.thinking ? { effort: cfg.thinking } : {}),
      resume,
      pathToClaudeCodeExecutable: executablePath,
      // CLAUDE_CODE_ENTRYPOINT=cli makes the transcript look like a plain `claude -p` session rather than an SDK one.
      env: { ...env, ...cfg.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
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
      let askedModels = false;
      try {
        for await (const msg of q) {
          for (const event of mapSdkMessage(msg, mode)) yield event;
          if (!askedModels && msg.type === 'system' && msg.subtype === 'init') {
            askedModels = true;
            const models = await modelOptions(q);
            if (models) yield models;
          }
          if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
            input.setBackground(msg.tasks.filter((t) => !t.ambient).length);
          } else if (msg.type === 'assistant' || (msg.type === 'system' && msg.subtype === 'init')) {
            // The CLI can start a turn itself, e.g. when a background task finishes.
            input.cliTurnStarted();
          }
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

/** The CLI's model list, for the model pickers. Optional and bounded like contextUsage. */
async function modelOptions(q: ReturnType<QueryFn>): Promise<RunEvent | undefined> {
  if (typeof q.supportedModels !== 'function') return undefined;
  try {
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000).unref()),
    ]);
    return {
      type: 'models',
      models: models.map((m) => ({
        value: m.value,
        ...versionedName(m.displayName, m.description),
        efforts: m.supportsEffort === false ? [] : m.supportedEffortLevels,
      })),
    };
  } catch {
    return undefined;
  }
}

/**
 * The CLI names models by alias ("Opus") and puts the version at the start of the description
 * ("Opus 5.5 · Best for everyday, complex tasks"); use the versioned name when it's there.
 */
export function versionedName(displayName: string, description: string): { label: string; description?: string } {
  const [head, ...rest] = description.split(' · ');
  // Keep a qualifier such as "(1M context)" that the description doesn't repeat.
  const qualifier = displayName.match(/\s*\([^)]*\)$/)?.[0] ?? '';
  const alias = displayName.slice(0, displayName.length - qualifier.length);
  if (rest.length > 0 && head.toLowerCase().startsWith(alias.toLowerCase()) && head.length <= 40) {
    return { label: head + qualifier, description: rest.join(' · ') };
  }
  return { label: displayName, description: description || undefined };
}

let hookScript = fileURLToPath(new URL('../../hooks/post-hook.mjs', import.meta.url));

/** The node worker ships the hook script next to itself rather than in this repo's layout. */
export function setHookScript(file: string): void {
  hookScript = file;
}

/** Settings carrying a SessionStart command hook that POSTs the hook's JSON (with session_id) to the app. */
export function sessionHookSettings(url: string) {
  const script = hookScript;
  return {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command' as const, command: `"${process.execPath}" "${script}" "${url}"`, timeout: 10 }] },
      ],
    },
  };
}

/** After the last background task ends, how long to wait for the turn the CLI starts to report it. */
const BACKGROUND_GRACE_MS = 15_000;

/**
 * The streaming prompt for one run: yields the first message, then one queued follow-up per
 * finished turn, and ends when a turn finishes with nothing queued (which lets the CLI exit).
 * While background tasks run (a backgrounded shell command or agent), it stays open: the CLI
 * starts a turn of its own when one finishes, and needs the stream to ask for tool approvals.
 */
export class TurnInput implements AsyncIterable<SDKUserMessage> {
  private readonly queue: string[];
  private turnOpen = false;
  private closed = false;
  private background = 0;
  private holdUntil = 0;
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

  /** How many (non-ambient) background tasks the CLI reports running. */
  setBackground(count: number): void {
    if (this.background > 0 && count === 0) this.holdUntil = Date.now() + BACKGROUND_GRACE_MS;
    this.background = count;
    this.notify();
  }

  /** The CLI began a turn without our input (it reports a finished background task). */
  cliTurnStarted(): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.holdUntil = 0;
    this.notify();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (!this.turnOpen) {
        const next = this.queue.shift();
        if (next !== undefined) {
          this.turnOpen = true;
          yield { type: 'user', message: { role: 'user', content: next }, parent_tool_use_id: null, session_id: '' };
          continue;
        }
        const hold = this.holdUntil - Date.now();
        if (this.background === 0 && hold <= 0) {
          this.ended = true;
          return;
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          if (this.background === 0) setTimeout(resolve, hold).unref();
        });
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
