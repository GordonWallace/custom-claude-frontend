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
import type { PermissionDecision, PermissionRequest, RunConfig, RunHandle, SessionRunner } from './runners/types.js';
import { modeLabel, type RuntimeLogger, type RuntimeService } from './runtime.js';
import type { Store } from './store.js';
import { assertTransition, isBusy } from './threadState.js';

const NEW_THREAD_TITLE = 'New chat';

interface ActiveRun {
  runId: number;
  mode: RunnerMode;
  handle: RunHandle;
  hookToken: string;
  interrupted: boolean;
}

export interface ThreadServiceOptions {
  workspacesDir: string;
  /** Base URL sessions use to call back into this server, e.g. http://127.0.0.1:4317. */
  serverUrl: () => string;
  maxTurns?: number;
  log: RuntimeLogger;
}

/** Projects, threads and their runs: starts and resumes sessions, records what they do, routes approvals. */
export class ThreadService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly hookTokens = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly runtime: RuntimeService,
    private readonly approvals: ApprovalStore,
    private readonly bus: EventBus,
    private readonly opts: ThreadServiceOptions,
  ) {}

  /** A first project and chat so a new install has somewhere to type. */
  ensureDefaultProject(): void {
    if (this.store.listProjects().length > 0) return;
    const project = this.createProject('My project', path.join(this.opts.workspacesDir, 'default'));
    this.createThread(project.id);
  }

  /** Runs can't survive a restart: mark what was in flight as interrupted. The next message resumes the session. */
  recoverAfterRestart(): void {
    this.store.closeOpenRuns();
    for (const thread of this.store.threadsWithStatus(['running', 'awaiting_permission'])) {
      this.store.updateThread(thread.id, { status: 'interrupted' });
    }
  }

  createProject(name: string, workspacePath: string): Project {
    if (!name.trim()) throw new HttpError(400, 'A project needs a name.');
    if (!path.isAbsolute(workspacePath)) throw new HttpError(400, 'The workspace path must be absolute.');
    fs.mkdirSync(workspacePath, { recursive: true });
    return this.store.createProject(name.trim(), workspacePath);
  }

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  createThread(projectId: string, title = NEW_THREAD_TITLE): Thread {
    if (!this.store.getProject(projectId)) throw new HttpError(404, 'No such project.');
    const thread = this.store.createThread(projectId, 'thread', title.trim() || NEW_THREAD_TITLE);
    this.bus.publish({ type: 'thread', thread });
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
   * Posts a user message. Mid-run it is queued as the run's next turn; otherwise it starts a run in
   * the active mode, resuming the thread's session if it has one. A thread whose last run used the
   * other mode needs `continueInMode` once, so the user sees the billing change before it happens.
   */
  async postMessage(threadId: string, body: PostMessageBody): Promise<Message> {
    const thread = this.getThread(threadId);
    const text = body.text?.trim();
    if (!text) throw new HttpError(400, 'Message text is empty.');

    const active = this.active.get(threadId);
    if (active) {
      const message = this.addMessage({ threadId, runId: null, author: 'user', kind: 'text', text, meta: { queued: true } });
      active.handle.send(text);
      return message;
    }

    const runner = await this.runtime.activeRunner();
    if (thread.lastMode && thread.lastMode !== runner.mode && body.continueInMode !== runner.mode) {
      throw new HttpError(409, 'mode_changed', { lastMode: thread.lastMode, mode: runner.mode });
    }

    if (thread.title === NEW_THREAD_TITLE) {
      this.publishThread(this.store.updateThread(threadId, { title: titleFrom(text) }));
    }
    const message = this.addMessage({ threadId, runId: null, author: 'user', kind: 'text', text, meta: null });
    this.startRun(thread, runner, text);
    return message;
  }

  async interrupt(threadId: string): Promise<void> {
    this.getThread(threadId);
    const active = this.active.get(threadId);
    if (!active) throw new HttpError(409, 'This thread has no run in progress.');
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
    const threadId = this.hookTokens.get(token);
    if (!threadId || !payload.session_id) return false;
    this.recordSessionId(threadId, payload.session_id, `SessionStart hook (${payload.source ?? 'unknown'})`);
    return true;
  }

  private startRun(thread: Thread, runner: SessionRunner, text: string): void {
    const project = this.store.getProject(thread.projectId)!;
    const run = this.store.startRun(thread.id, runner.mode);
    const hookToken = randomUUID();
    this.hookTokens.set(hookToken, thread.id);

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
      mcpServers: [],
      permissionMode: 'default',
      maxTurns: this.opts.maxTurns,
      onPermission: (req) => this.askPermission(thread.id, run.id, req),
      sessionHookUrl: `${this.opts.serverUrl()}/api/hooks/session-start/${hookToken}`,
    };

    const untrack = this.runtime.trackRun();
    let handle: RunHandle;
    try {
      handle = thread.claudeSessionId ? runner.resume(thread.claudeSessionId, cfg, text) : runner.start(cfg, text);
    } catch (err) {
      this.finishRun(thread.id, run.id, hookToken, { ok: false, inputTokens: 0, outputTokens: 0 }, false);
      this.addMessage({ threadId: thread.id, runId: run.id, author: 'system', kind: 'error', text: (err as Error).message, meta: null });
      untrack();
      return;
    }
    const active: ActiveRun = { runId: run.id, mode: runner.mode, handle, hookToken, interrupted: false };
    this.active.set(thread.id, active);
    void this.consume(thread.id, active).finally(untrack);
  }

  private async consume(threadId: string, active: ActiveRun): Promise<void> {
    const { runId, mode } = active;
    let seq = 0;
    let errorShown = false;
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
            if (!event.ok && !active.interrupted && event.finalText && !errorShown) {
              add({ author: 'system', kind: 'error', text: event.finalText, meta: null });
            }
            break;
        }
      }
    } catch (err) {
      result.ok = false;
      add({ author: 'system', kind: 'error', text: (err as Error).message, meta: null });
    } finally {
      this.finishRun(threadId, runId, active.hookToken, result, active.interrupted);
    }
  }

  private finishRun(
    threadId: string,
    runId: number,
    hookToken: string,
    result: { ok: boolean; inputTokens: number; outputTokens: number; costUsdEstimate?: number },
    interrupted: boolean,
  ): void {
    this.active.delete(threadId);
    this.hookTokens.delete(hookToken);
    this.approvals.cancelRun(runId);
    const run = this.store.endRun(runId, result);
    const status: ThreadStatus = interrupted ? 'interrupted' : result.ok ? 'idle' : 'failed';
    this.addMessage({
      threadId,
      runId,
      author: 'system',
      kind: 'run_ended',
      text: interrupted ? 'Stopped' : result.ok ? 'Done' : 'Failed',
      meta: { mode: run.mode, ok: result.ok, interrupted, costUsdEstimate: run.costUsdEstimate },
    });
    this.setStatus(threadId, status);
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

function titleFrom(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
