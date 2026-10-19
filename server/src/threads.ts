import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ApprovalDecision,
  Message,
  PostMessageBody,
  Project,
  RunnerMode,
  Thread,
  ThreadDetail,
  ThreadStatus,
} from '@ccf/shared';
import type { ApprovalStore } from './approvals.js';
import { HttpError } from './errors.js';
import type { EventBus } from './events.js';
import { APP_MCP_SERVER, toolsFor } from './mcpTools.js';
import { readMemory, writeMemory } from './memory.js';
import type { PermissionDecision, PermissionRequest, RunConfig, RunHandle, SessionRunner } from './runners/types.js';
import { modeLabel, type RuntimeLogger, type RuntimeService } from './runtime.js';
import type { Store } from './store.js';
import { assertTransition, isBusy } from './threadState.js';

const NEW_THREAD_TITLE = 'New chat';
const PROJECT_CHAT_TITLE = 'Project chat';
/** How much of a thread's final message the coordinator's completion notice carries. */
const NOTICE_TEXT_LIMIT = 1500;

interface ActiveRun {
  runId: number;
  mode: RunnerMode;
  kind: Thread['kind'];
  handle: RunHandle;
  /** Identifies the run to the SessionStart hook and the app's MCP server. */
  token: string;
  interrupted: boolean;
}

/** Who is calling the app's MCP server: resolved from the per-run token in its request header. */
export interface RunContext {
  threadId: string;
  projectId: string;
  kind: Thread['kind'];
}

export interface ThreadSummary {
  id: string;
  title: string;
  status: ThreadStatus;
  lastResult: string | null;
}

export interface ThreadServiceOptions {
  workspacesDir: string;
  /** Base URL sessions use to call back into this server, e.g. http://127.0.0.1:4317. */
  serverUrl: () => string;
  maxTurns?: number;
  log: RuntimeLogger;
}

/**
 * Projects, threads and their runs. Input for an idle thread is queued and the scheduler starts it
 * when a slot is free under the concurrency cap (the coordinator never waits for one). Threads the
 * coordinator started report back to it when each run ends.
 */
export class ThreadService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly runTokens = new Map<string, string>();
  private pumping: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly runtime: RuntimeService,
    private readonly approvals: ApprovalStore,
    private readonly bus: EventBus,
    private readonly opts: ThreadServiceOptions,
  ) {}

  /** A first project so a new install has somewhere to type, and a project chat for every project. */
  ensureDefaultProject(): void {
    for (const projectId of this.store.projectsWithoutCoordinator()) {
      this.store.createThread(projectId, 'coordinator', PROJECT_CHAT_TITLE);
    }
    if (this.store.listProjects().length > 0) return;
    this.createProject('My project', path.join(this.opts.workspacesDir, 'default'));
  }

  /**
   * Runs can't survive a restart: mark what was in flight as interrupted (the next message resumes
   * the session). Queued input survives; call `pump` once the server is up to start it.
   */
  recoverAfterRestart(): void {
    this.store.closeOpenRuns();
    for (const thread of this.store.threadsWithStatus(['running', 'awaiting_permission'])) {
      this.store.updateThread(thread.id, { status: this.store.hasQueuedInput(thread.id) ? 'queued' : 'interrupted' });
    }
  }

  createProject(name: string, workspacePath: string): Project {
    if (!name.trim()) throw new HttpError(400, 'A project needs a name.');
    if (!path.isAbsolute(workspacePath)) throw new HttpError(400, 'The workspace path must be absolute.');
    fs.mkdirSync(workspacePath, { recursive: true });
    return this.store.createProject(name.trim(), workspacePath, PROJECT_CHAT_TITLE);
  }

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  createThread(projectId: string, title = NEW_THREAD_TITLE): Thread {
    if (!this.store.getProject(projectId)) throw new HttpError(404, 'No such project.');
    const thread = this.store.createThread(projectId, 'thread', title.trim() || NEW_THREAD_TITLE);
    this.publishThread(thread);
    return thread;
  }

  listThreads(projectId: string): Thread[] {
    if (!this.store.getProject(projectId)) throw new HttpError(404, 'No such project.');
    return this.store.listThreads(projectId);
  }

  detail(threadId: string): ThreadDetail {
    const thread = this.getThread(threadId);
    const project = this.store.getProject(thread.projectId)!;
    return {
      thread,
      project,
      messages: this.store.listMessages(threadId),
      runs: this.store.listRuns(threadId),
      approvals: this.approvals.forThread(threadId),
      resumeCommand: thread.claudeSessionId
        ? `cd ${shellQuote(project.workspacePath)} && claude --resume ${thread.claudeSessionId}`
        : null,
    };
  }

  messages(threadId: string): Message[] {
    this.getThread(threadId);
    return this.store.listMessages(threadId);
  }

  runEvents(runId: number) {
    if (!this.store.getRun(runId)) throw new HttpError(404, 'No such run.');
    return this.store.listRunEvents(runId);
  }

  /**
   * Posts a user message. Mid-run it goes to the run as its next turn; otherwise it is queued and
   * starts in the active mode, resuming the thread's session if it has one. A thread whose last run
   * used the other mode needs `continueInMode` once, so the user sees the billing change first.
   */
  async postMessage(threadId: string, body: PostMessageBody): Promise<Message> {
    const thread = this.getThread(threadId);
    const text = body.text?.trim();
    if (!text) throw new HttpError(400, 'Message text is empty.');

    const active = this.active.get(threadId);
    if (!active && thread.status !== 'queued') {
      const runner = await this.runtime.activeRunner();
      if (thread.lastMode && thread.lastMode !== runner.mode && body.continueInMode !== runner.mode) {
        throw new HttpError(409, 'mode_changed', { lastMode: thread.lastMode, mode: runner.mode });
      }
    }

    if (thread.kind === 'thread' && thread.title === NEW_THREAD_TITLE) {
      this.publishThread(this.store.updateThread(threadId, { title: titleFrom(text) }));
    }
    const message = this.addMessage({
      threadId,
      runId: null,
      author: 'user',
      kind: 'text',
      text,
      meta: active ? { queued: true } : null,
    });
    this.deliver(threadId, text);
    return message;
  }

  /** Stops the thread's run, or drops its queued input if it is waiting for a slot. */
  async interrupt(threadId: string): Promise<void> {
    const thread = this.getThread(threadId);
    const active = this.active.get(threadId);
    if (!active) {
      if (thread.status !== 'queued') throw new HttpError(409, 'This thread has no run in progress.');
      this.store.takeQueuedInputs(threadId);
      this.setStatus(threadId, 'idle');
      return;
    }
    active.interrupted = true;
    this.approvals.cancelRun(active.runId);
    await active.handle.interrupt();
  }

  decideApproval(id: string, decision: ApprovalDecision): void {
    if (decision.behavior !== 'allow' && decision.behavior !== 'deny') {
      throw new HttpError(400, 'behavior must be "allow" or "deny".');
    }
    if (!this.approvals.decide(id, decision)) throw new HttpError(404, 'That approval was already answered or its run ended.');
  }

  /** SessionStart hook callback: the authoritative session id, on start, resume and after compaction. */
  handleSessionHook(token: string, payload: { session_id?: string; source?: string }): boolean {
    const threadId = this.runTokens.get(token);
    if (!threadId || !payload.session_id) return false;
    this.recordSessionId(threadId, payload.session_id, `SessionStart hook (${payload.source ?? 'unknown'})`);
    return true;
  }

  // ---- The app's MCP tools (see mcp.ts) ----

  runContext(token: string): RunContext | undefined {
    const threadId = this.runTokens.get(token);
    const thread = threadId ? this.store.getThread(threadId) : undefined;
    return thread && { threadId: thread.id, projectId: thread.projectId, kind: thread.kind };
  }

  /** start_thread: creates a thread in the coordinator's project and queues its brief as the first turn. */
  startThreadFor(ctx: RunContext, title: string, brief: string): Thread {
    this.requireCoordinator(ctx);
    const thread = this.store.createThread(ctx.projectId, 'thread', title.trim() || NEW_THREAD_TITLE, 'coordinator');
    this.publishThread(thread);
    this.addMessage({ threadId: ctx.threadId, runId: null, author: 'system', kind: 'thread_started', text: thread.title, meta: { threadId: thread.id } });
    this.addMessage({ threadId: thread.id, runId: null, author: 'user', kind: 'text', text: brief, meta: { from: 'coordinator' } });
    this.deliver(thread.id, brief);
    return this.getThread(thread.id);
  }

  /** message_thread: a follow-up from the coordinator, sent mid-run or queued. */
  messageThreadFor(ctx: RunContext, threadId: string, text: string): 'sent' | 'queued' {
    this.requireCoordinator(ctx);
    const thread = this.projectThread(ctx, threadId);
    const running = this.active.has(thread.id);
    this.addMessage({ threadId: thread.id, runId: null, author: 'user', kind: 'text', text, meta: { from: 'coordinator', ...(running && { queued: true }) } });
    return this.deliver(thread.id, text);
  }

  /** list_threads: every thread in the project with its status and the first line of its latest reply. */
  summarizeThreads(ctx: RunContext): ThreadSummary[] {
    this.requireCoordinator(ctx);
    return this.store
      .listThreads(ctx.projectId)
      .filter((t) => t.kind === 'thread')
      .map((t) => {
        const [last] = this.store.recentMessages(t.id, ['text'], 1).filter((m) => m.author === 'assistant');
        return { id: t.id, title: t.title, status: t.status, lastResult: last ? trimText(last.text.split('\n')[0], 200) : null };
      });
  }

  /** read_thread: the thread's latest conversation messages and errors, each trimmed. */
  readThreadFor(ctx: RunContext, threadId: string, lastN: number): Message[] {
    this.requireCoordinator(ctx);
    const thread = this.projectThread(ctx, threadId);
    return this.store.recentMessages(thread.id, ['text', 'error'], lastN).map((m) => ({ ...m, text: trimText(m.text, 2000) }));
  }

  readMemoryFor(ctx: RunContext): string {
    return readMemory(this.store.getProject(ctx.projectId)!);
  }

  writeMemoryFor(ctx: RunContext, text: string): void {
    writeMemory(this.store.getProject(ctx.projectId)!, text);
  }

  // ---- Scheduling ----

  /**
   * Hands text to the thread: to its run if one is taking input, otherwise into its queue for the
   * scheduler to start.
   */
  private deliver(threadId: string, text: string): 'sent' | 'queued' {
    const active = this.active.get(threadId);
    if (active?.handle.send(text)) return 'sent';
    this.store.enqueueInput(threadId, text);
    // A run that refused the input is ending; finishRun moves its thread to queued.
    if (!active && this.getThread(threadId).status !== 'queued') this.setStatus(threadId, 'queued');
    void this.pump();
    return 'queued';
  }

  /** Starts queued threads while slots are free. Serialized, so two calls never race for a slot. */
  pump(): Promise<void> {
    this.pumping = this.pumping
      .then(() => this.pumpOnce())
      .catch((err: Error) => this.opts.log.warn(`Scheduler: ${err.message}`));
    return this.pumping;
  }

  private async pumpOnce(): Promise<void> {
    const waiting = this.store.threadsWithQueuedInput().filter((id) => !this.active.has(id));
    if (waiting.length === 0) return;

    let runner: SessionRunner;
    try {
      runner = await this.runtime.activeRunner();
    } catch (err) {
      const reason = (err as HttpError).body?.reason;
      for (const id of waiting) {
        this.store.takeQueuedInputs(id);
        this.addMessage({ threadId: id, runId: null, author: 'system', kind: 'error', text: [`Couldn't start: ${(err as Error).message}`, reason].filter(Boolean).join(' '), meta: null });
        this.setStatus(id, 'failed');
      }
      return;
    }

    for (const id of waiting) {
      const thread = this.store.getThread(id);
      if (!thread || this.active.has(id)) continue;
      // The cap is on parallel threads; the coordinator always gets to run so it can hear back.
      if (thread.kind === 'thread' && this.runningThreads() >= this.runtime.concurrency) continue;
      const inputs = this.store.takeQueuedInputs(id);
      if (inputs.length > 0) this.startRun(thread, runner, inputs.join('\n\n'));
    }
  }

  private runningThreads(): number {
    let n = 0;
    for (const run of this.active.values()) if (run.kind === 'thread') n++;
    return n;
  }

  // ---- Runs ----

  private startRun(thread: Thread, runner: SessionRunner, text: string): void {
    const project = this.store.getProject(thread.projectId)!;
    const run = this.store.startRun(thread.id, runner.mode);
    const token = randomUUID();
    this.runTokens.set(token, thread.id);

    this.setStatus(thread.id, 'running', { lastMode: runner.mode });
    this.addMessage({
      threadId: thread.id,
      runId: run.id,
      author: 'system',
      kind: 'run_started',
      text: modeLabel(runner.mode),
      meta: { mode: runner.mode, resumed: Boolean(thread.claudeSessionId) },
    });

    const cfg: RunConfig = {
      cwd: project.workspacePath,
      mcpServers: [
        { name: APP_MCP_SERVER, type: 'http', url: `${this.opts.serverUrl()}/mcp`, headers: { Authorization: `Bearer ${token}` } },
      ],
      allowedTools: toolsFor(thread.kind).map((name) => `mcp__${APP_MCP_SERVER}__${name}`),
      // The coordinator delegates through threads the user can see, not hidden subagents.
      disallowedTools: thread.kind === 'coordinator' ? ['Task', 'Agent'] : undefined,
      appendSystemPrompt: rolePrompt(thread.kind),
      permissionMode: 'default',
      maxTurns: this.opts.maxTurns,
      onPermission: (req) => this.askPermission(thread.id, run.id, req),
      sessionHookUrl: `${this.opts.serverUrl()}/api/hooks/session-start/${token}`,
    };

    const untrack = this.runtime.trackRun();
    let handle: RunHandle;
    try {
      handle = thread.claudeSessionId ? runner.resume(thread.claudeSessionId, cfg, text) : runner.start(cfg, text);
    } catch (err) {
      const message = (err as Error).message;
      this.addMessage({ threadId: thread.id, runId: run.id, author: 'system', kind: 'error', text: message, meta: null });
      this.finishRun(thread.id, run.id, token, { ok: false, inputTokens: 0, outputTokens: 0 }, false, message);
      untrack();
      return;
    }
    const active: ActiveRun = { runId: run.id, mode: runner.mode, kind: thread.kind, handle, token, interrupted: false };
    this.active.set(thread.id, active);
    void this.consume(thread.id, active).finally(untrack);
  }

  private async consume(threadId: string, active: ActiveRun): Promise<void> {
    const { runId, mode } = active;
    let seq = 0;
    let errorShown = false;
    let lastText = '';
    let lastError = '';
    let result = { ok: false, inputTokens: 0, outputTokens: 0, costUsdEstimate: undefined as number | undefined };
    const add = (m: Pick<Message, 'author' | 'kind' | 'text' | 'meta'>) => this.addMessage({ threadId, runId, ...m });

    try {
      for await (const event of active.handle.events) {
        this.store.addRunEvent(runId, seq++, event.type, event);
        switch (event.type) {
          case 'init':
            this.recordSessionId(threadId, event.sessionId, 'init message');
            break;
          case 'assistant_text':
            lastText = event.text;
            add({ author: 'assistant', kind: 'text', text: event.text, meta: null });
            break;
          case 'tool_use':
            add({ author: 'assistant', kind: 'tool_use', text: event.name, meta: { toolUseId: event.id, input: event.input } });
            break;
          case 'tool_result':
            add({ author: 'system', kind: 'tool_result', text: event.summary, meta: { toolUseId: event.id, isError: event.isError } });
            break;
          case 'usage':
            if (event.contextTokens) {
              this.publishThread(this.store.updateThread(threadId, { contextTokens: event.contextTokens }));
            }
            break;
          case 'plan_usage':
            // The plan meter only means something for runs billed to the plan.
            if (mode === 'subscription') {
              this.runtime.recordPlanUsage({ status: event.status, fiveHour: event.fiveHour, sevenDay: event.sevenDay });
            }
            break;
          case 'compacted':
            add({ author: 'system', kind: 'compacted', text: 'Context compacted', meta: null });
            break;
          case 'error':
            errorShown = true;
            lastError = event.message;
            add({ author: 'system', kind: 'error', text: event.message, meta: null });
            break;
          case 'result':
            result = {
              ok: event.ok,
              inputTokens: result.inputTokens + (event.inputTokens ?? 0),
              outputTokens: result.outputTokens + (event.outputTokens ?? 0),
              costUsdEstimate:
                event.costUsdEstimate === undefined ? result.costUsdEstimate : (result.costUsdEstimate ?? 0) + event.costUsdEstimate,
            };
            if (event.ok && event.finalText) lastText = event.finalText;
            if (!event.ok && event.finalText) lastError = event.finalText;
            if (!event.ok && !active.interrupted && event.finalText && !errorShown) {
              add({ author: 'system', kind: 'error', text: event.finalText, meta: null });
            }
            break;
        }
      }
    } catch (err) {
      result.ok = false;
      lastError = (err as Error).message;
      add({ author: 'system', kind: 'error', text: lastError, meta: null });
    } finally {
      this.finishRun(threadId, runId, active.token, result, active.interrupted, result.ok ? lastText : lastError || lastText);
    }
  }

  private finishRun(
    threadId: string,
    runId: number,
    token: string,
    result: { ok: boolean; inputTokens: number; outputTokens: number; costUsdEstimate?: number },
    interrupted: boolean,
    finalText: string,
  ): void {
    this.active.delete(threadId);
    this.runTokens.delete(token);
    this.approvals.cancelRun(runId);
    const run = this.store.endRun(runId, result);
    const outcome = interrupted ? 'stopped' : result.ok ? 'done' : 'failed';
    this.addMessage({
      threadId,
      runId,
      author: 'system',
      kind: 'run_ended',
      text: interrupted ? 'Stopped' : result.ok ? 'Done' : 'Failed',
      meta: { mode: run.mode, ok: result.ok, interrupted, costUsdEstimate: run.costUsdEstimate },
    });
    const queued = this.store.hasQueuedInput(threadId);
    const status: ThreadStatus = queued ? 'queued' : interrupted ? 'interrupted' : result.ok ? 'idle' : 'failed';
    this.setStatus(threadId, status);

    const thread = this.getThread(threadId);
    if (thread.origin === 'coordinator') this.notifyCoordinator(thread, outcome, finalText);
    void this.pump();
  }

  /** Lifecycle step 5: tell the coordinator a thread it started finished a run, with its final text trimmed. */
  private notifyCoordinator(thread: Thread, outcome: 'done' | 'stopped' | 'failed', finalText: string): void {
    const coordinatorId = this.store.getProject(thread.projectId)?.coordinatorThreadId;
    if (!coordinatorId) return;
    const said = { done: 'finished', stopped: 'was stopped by the user', failed: 'failed' }[outcome];
    this.addMessage({
      threadId: coordinatorId,
      runId: null,
      author: 'system',
      kind: 'thread_notice',
      text: `${thread.title} ${said}`,
      meta: { threadId: thread.id, outcome },
    });
    const body = trimText(finalText.trim(), NOTICE_TEXT_LIMIT) || '(no final message)';
    this.deliver(coordinatorId, `[Thread update] "${thread.title}" (thread_id: ${thread.id}) ${said}.\n\nFinal message:\n${body}`);
  }

  private async askPermission(threadId: string, runId: number, req: PermissionRequest): Promise<PermissionDecision> {
    this.setStatus(threadId, 'awaiting_permission');
    const decision = await this.approvals.request(threadId, runId, req);
    const thread = this.store.getThread(threadId);
    if (
      thread?.status === 'awaiting_permission' &&
      this.active.get(threadId)?.runId === runId &&
      this.approvals.forThread(threadId).length === 0
    ) {
      this.setStatus(threadId, 'running');
    }
    return decision;
  }

  private recordSessionId(threadId: string, sessionId: string, source: string): void {
    const thread = this.store.getThread(threadId);
    if (!thread || thread.claudeSessionId === sessionId) return;
    this.opts.log.info(`Thread ${threadId}: session ${sessionId} (from ${source})`);
    this.publishThread(this.store.updateThread(threadId, { claudeSessionId: sessionId }));
  }

  private requireCoordinator(ctx: RunContext): void {
    if (ctx.kind !== 'coordinator') throw new HttpError(403, 'Only the project coordinator can use this tool.');
  }

  /** A thread (not the coordinator) in the caller's project. */
  private projectThread(ctx: RunContext, threadId: string): Thread {
    const thread = this.store.getThread(threadId);
    if (!thread || thread.projectId !== ctx.projectId || thread.kind !== 'thread') {
      throw new HttpError(404, `No thread ${threadId} in this project. Use list_threads to see the ids.`);
    }
    return thread;
  }

  private setStatus(threadId: string, status: ThreadStatus, extra: Partial<Pick<Thread, 'lastMode'>> = {}): void {
    const thread = this.getThread(threadId);
    assertTransition(thread.status, status);
    this.publishThread(this.store.updateThread(threadId, { status, ...extra }));
  }

  private getThread(threadId: string): Thread {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new HttpError(404, 'No such thread.');
    return thread;
  }

  private addMessage(m: Omit<Message, 'id' | 'createdAt'>): Message {
    const message = this.store.addMessage(m);
    this.bus.publish({ type: 'message', message });
    return message;
  }

  private publishThread(thread: Thread): void {
    this.bus.publish({ type: 'thread', thread });
  }
}

export function isThreadBusy(thread: Thread): boolean {
  return isBusy(thread.status);
}

/** The role prompt for a session, read on each run so edits to prompts/*.md apply without a restart. */
function rolePrompt(kind: Thread['kind']): string {
  return fs.readFileSync(new URL(`../prompts/${kind}.md`, import.meta.url), 'utf8');
}

function titleFrom(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function trimText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
