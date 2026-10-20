import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ApprovalDecision,
  Message,
  NodeUpdate,
  NodeView,
  PostMessageBody,
  Project,
  ProjectUsage,
  RunnerMode,
  Thread,
  ThreadDetail,
  ThreadStatus,
} from '@ccf/shared';
import type { ApprovalStore } from './approvals.js';
import { autoApproval } from './autoApprove.js';
import { HttpError } from './errors.js';
import type { EventBus } from './events.js';
import { APP_MCP_SERVER, toolsFor } from './mcpTools.js';
import { readMemory, writeMemory } from './memory.js';
import { CALIBRATION_MS, projectUsage } from './planUsage.js';
import { gitCredentialEnv } from './nodes/git.js';
import type { NodeHub } from './nodes/hub.js';
import { OFFLINE_AFTER_MS, type NodeInfoReport, type WireRunConfig, type Workspace } from './nodes/protocol.js';
import type { PermissionDecision, PermissionRequest, RunHandle } from './runners/types.js';
import { modeLabel, type RuntimeLogger, type RuntimeService } from './runtime.js';
import type { SecretStore } from './secrets.js';
import type { NodeRow, Store } from './store.js';
import { assertTransition, isBusy } from './threadState.js';

const NEW_THREAD_TITLE = 'New chat';
const PROJECT_CHAT_TITLE = 'Project chat';
/**
 * Backstop on a completion notice's final message. Threads are told to keep it to a 2,000-character
 * summary; this only catches a summary that runs long, and says where the rest is.
 */
const NOTICE_TEXT_LIMIT = 4000;
/** Per user message, in the background the coordinator gets about direct thread conversations. */
const DIRECT_USER_LIMIT = 1000;
/** Direct conversations kept for the coordinator's next turn; older ones are dropped. */
const DIRECT_CONTEXT_ENTRIES = 10;
/** How much of MEMORY.md goes into each session's system prompt; read_memory has the rest. */
const MEMORY_PROMPT_LIMIT = 16_000;

interface ActiveRun {
  runId: number;
  mode: RunnerMode;
  kind: Thread['kind'];
  handle: RunHandle;
  /** Identifies the run to the SessionStart hook and the app's MCP server. */
  token: string;
  interrupted: boolean;
  nodeId: string;
  /** Its node dropped mid-run: the thread resumes elsewhere instead of failing. */
  lost: boolean;
  /** Its node is being drained (hand off after this run) or stopped (interrupted; hand off and continue). */
  moveAfter: 'drain' | 'stop' | null;
  /** Input whose turn hasn't finished yet: if the node is lost, the transcript won't have it, so it is sent again. */
  unfinished: string[];
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
  maxTurns?: number;
  log: RuntimeLogger;
  nodes: NodeHub;
  secrets: SecretStore;
  /** The server's environment, for an API key to hand to other nodes when none is stored. */
  env?: NodeJS.ProcessEnv;
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
  private nodesQueued = false;

  constructor(
    private readonly store: Store,
    private readonly runtime: RuntimeService,
    private readonly approvals: ApprovalStore,
    private readonly bus: EventBus,
    private readonly opts: ThreadServiceOptions,
  ) {
    opts.nodes.handlers = {
      nodeLost: (nodeId) => this.nodeLost(nodeId),
      sendRejected: (threadId, text) => this.requeue(threadId, text),
      workspace: (threadId, cwd) => {
        if (this.store.getThread(threadId)) this.publishThread(this.store.updateThread(threadId, { worktreePath: cwd }));
      },
      pushed: (threadId, branch, commit, wip) =>
        this.store.getThread(threadId) &&
        this.addMessage({
          threadId,
          runId: null,
          author: 'system',
          kind: 'git_push',
          text: `Pushed ${branch} at ${commit.slice(0, 7)}${wip ? ' with a WIP commit of unfinished work' : ''}`,
          meta: { branch, commit, wip },
        }),
      gitError: (threadId, message) =>
        this.store.getThread(threadId) && this.addMessage({ threadId, runId: null, author: 'system', kind: 'error', text: message, meta: null }),
      changed: () => {
        this.publishNodes();
        // A node coming back or freeing up may let waiting threads start.
        if (this.store.threadsWithQueuedInput().length > 0) void this.pump();
      },
    };
  }

  private get nodes(): NodeHub {
    return this.opts.nodes;
  }

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

  /**
   * A local-folder project works in `workspacePath` on this machine. A repo project (M5) has its
   * threads clone `repoUrl` on any node; its workspace here only holds the coordinator and MEMORY.md.
   */
  createProject(name: string, workspacePath: string, repo: { repoUrl?: string; baseBranch?: string } = {}): Project {
    if (!name.trim()) throw new HttpError(400, 'A project needs a name.');
    const repoUrl = repo.repoUrl?.trim() || null;
    if (repoUrl && !/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(repoUrl)) {
      throw new HttpError(400, 'The repo URL should look like https://github.com/you/repo.git.');
    }
    if (repoUrl && !workspacePath) {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
      workspacePath = path.join(this.opts.workspacesDir, `${slug}-${randomUUID().slice(0, 6)}`);
    }
    if (!path.isAbsolute(workspacePath)) throw new HttpError(400, 'The workspace path must be absolute.');
    fs.mkdirSync(workspacePath, { recursive: true });
    return this.store.createProject(name.trim(), workspacePath, PROJECT_CHAT_TITLE, {
      repoUrl,
      baseBranch: repoUrl ? repo.baseBranch?.trim() || null : null,
    });
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
        ? `cd ${shellQuote(thread.worktreePath ?? project.workspacePath)} && claude --resume ${thread.claudeSessionId}`
        : null,
      resumeNode: thread.nodeId && thread.nodeId !== this.nodes.localNodeId ? (this.store.getNode(thread.nodeId)?.name ?? null) : null,
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

  getMemory(projectId: string): string {
    return readMemory(this.getProject(projectId));
  }

  setMemory(projectId: string, text: string): void {
    if (typeof text !== 'string') throw new HttpError(400, 'Send { "text": "..." }.');
    writeMemory(this.getProject(projectId), text);
  }

  /** Estimated plan usage per thread and for the project in the current 5-hour and weekly windows. */
  usage(projectId: string): ProjectUsage {
    this.getProject(projectId);
    const since = new Date(Date.now() - CALIBRATION_MS).toISOString();
    return projectUsage(this.store.planReadingsSince(since), this.store.subscriptionRunsSince(since), projectId);
  }

  /**
   * Retires the coordinator's session: its next message starts a fresh one, seeded with the project's
   * threads (memory is in every session's prompt anyway). For when the project chat has grown too big.
   */
  resetCoordinator(projectId: string): Thread {
    const project = this.getProject(projectId);
    const coordinator = this.getThread(project.coordinatorThreadId);
    if (this.active.has(coordinator.id) || coordinator.status === 'queued') {
      throw new HttpError(409, 'The coordinator is busy. Wait for it to finish or stop it first.');
    }
    const thread = this.store.updateThread(coordinator.id, { claudeSessionId: null, contextTokens: null, contextWindow: null, autoCompactAt: null });
    this.publishThread(thread);
    this.addMessage({ threadId: thread.id, runId: null, author: 'system', kind: 'session_reset', text: 'Fresh coordinator session', meta: null });
    return thread;
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

  /** read_thread: the thread's latest conversation messages and errors, in full. */
  readThreadFor(ctx: RunContext, threadId: string, lastN: number): Message[] {
    this.requireCoordinator(ctx);
    const thread = this.projectThread(ctx, threadId);
    return this.store.recentMessages(thread.id, ['text', 'error'], lastN);
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
    if (active?.handle.send(text)) {
      active.unfinished.push(text);
      return 'sent';
    }
    this.requeue(threadId, text);
    return 'queued';
  }

  /** Queues input for the thread's next run (also where a follow-up lands that a run refused). */
  private requeue(threadId: string, text: string): void {
    if (!this.store.getThread(threadId)) return;
    this.store.enqueueInput(threadId, text);
    // A run that refused the input is ending; finishRun moves its thread to queued.
    if (!this.active.has(threadId) && this.getThread(threadId).status !== 'queued') this.setStatus(threadId, 'queued');
    void this.pump();
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

    const mode = this.runtime.mode;
    // The orchestrator's own runner, checked once per pass and only if something is placed here.
    let localCheck: Promise<Error | null> | undefined;
    const localReady = () => (localCheck ??= this.runtime.activeRunner().then(() => null, (err: Error) => err));

    for (const id of waiting) {
      const thread = this.store.getThread(id);
      if (!thread || this.active.has(id)) continue;
      if (!mode) {
        this.failQueued(id, 'Choose a runner mode first.');
        continue;
      }
      // The cap is on parallel threads; the coordinator always gets to run so it can hear back.
      if (thread.kind === 'thread' && this.runningThreads() >= this.runtime.concurrency) continue;
      const project = this.store.getProject(thread.projectId)!;
      const nodeId = this.place(thread, project, mode);
      if (!nodeId) continue;
      if (nodeId === this.nodes.localNodeId) {
        const err = await localReady();
        if (err) {
          this.failQueued(id, `Couldn't start: ${err.message}`, (err as HttpError).body?.reason as string | undefined);
          continue;
        }
      }
      const inputs = this.store.takeQueuedInputs(id);
      if (inputs.length > 0) this.startRun(this.getThread(id), project, nodeId, mode, inputs.join('\n\n'));
    }
  }

  private failQueued(threadId: string, message: string, reason?: string): void {
    this.store.takeQueuedInputs(threadId);
    this.addMessage({ threadId, runId: null, author: 'system', kind: 'error', text: [message, reason].filter(Boolean).join(' '), meta: null });
    this.setStatus(threadId, 'failed');
  }

  private runningThreads(nodeId?: string): number {
    let n = 0;
    for (const run of this.active.values()) if (run.kind === 'thread' && (!nodeId || run.nodeId === nodeId)) n++;
    return n;
  }

  /**
   * Which node a thread runs on, or null to keep waiting. The coordinator and local-folder projects
   * run on this machine. A repo thread stays on its node between runs; it moves only when that node
   * is drained, stopped, removed or offline for longer than OFFLINE_AFTER_MS, and then goes to the
   * enabled, ready node with room, preferring one that already has the project cloned.
   */
  private place(thread: Thread, project: Project, mode: RunnerMode): string | null {
    const local = this.nodes.localNodeId;
    if (thread.kind === 'coordinator') return local;
    const room = (row: NodeRow) => this.runningThreads(row.id) < row.thread_limit;
    if (!project.repoUrl) {
      const row = this.store.getNode(local);
      return row && room(row) ? local : null;
    }

    if (thread.nodeId) {
      const row = this.store.getNode(thread.nodeId);
      if (row && this.nodes.isOnline(row.id)) {
        // Draining or stopped: its handoff will release the thread.
        return row.state === 'enabled' && room(row) ? row.id : null;
      }
      if (row && this.nodes.offlineFor(row.id) < OFFLINE_AFTER_MS) return null;
      this.release(thread.id, thread.nodeId, `node ${row?.name ?? 'that was removed'} went offline; anything it hadn't committed and pushed may be lost`);
    }

    const candidates = this.store
      .listNodes()
      .filter((row) => row.state === 'enabled' && this.nodes.isOnline(row.id) && room(row))
      .filter((row) => row.id === local || this.readiness(row, this.nodes.info(row.id))[mode].ok)
      .sort(
        (a, b) =>
          Number(this.nodes.hasProject(b.id, project.id)) - Number(this.nodes.hasProject(a.id, project.id)) ||
          this.runningThreads(a.id) / a.thread_limit - this.runningThreads(b.id) / b.thread_limit,
      );
    return candidates[0]?.id ?? null;
  }

  /** Whether each mode can run on a node: credentials stored here, or the node's own claude login. */
  private readiness(row: NodeRow, info: NodeInfoReport | null): NodeView['ready'] {
    if (row.is_local) {
      const of = (mode: RunnerMode) => {
        const h = this.runtime.cachedHealth(mode);
        return h ? { ok: h.ok, reason: h.reason } : { ok: true };
      };
      return { subscription: of('subscription'), api: of('api') };
    }
    const token = Boolean(this.opts.secrets.get('claude_oauth_token'));
    const key = Boolean(this.opts.secrets.get('anthropic_api_key') || this.opts.env?.ANTHROPIC_API_KEY?.trim());
    return {
      subscription:
        token || info?.claudeLoggedIn
          ? { ok: true }
          : { ok: false, reason: 'No Claude token stored (Settings › Credentials) and the node\'s own claude isn\'t signed in.' },
      api: key ? { ok: true } : { ok: false, reason: 'No API key stored (Settings › Credentials).' },
    };
  }

  /** Credentials for one run, as environment. Other machines get the stored Claude credential; this one keeps using its own login. */
  private runEnv(mode: RunnerMode, nodeId: string, workspace: Workspace): Record<string, string> {
    const env: Record<string, string> = workspace.kind === 'repo' ? gitCredentialEnv(this.opts.secrets.get('github_token')) : {};
    if (nodeId === this.nodes.localNodeId) return env;
    if (mode === 'subscription') {
      const token = this.opts.secrets.get('claude_oauth_token');
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    } else {
      const key = this.opts.secrets.get('anthropic_api_key') || this.opts.env?.ANTHROPIC_API_KEY?.trim();
      if (key) env.ANTHROPIC_API_KEY = key;
    }
    return env;
  }

  private workspaceFor(thread: Thread, project: Project, fresh: boolean): Workspace {
    if (thread.kind === 'coordinator' || !project.repoUrl) return { kind: 'folder', path: project.workspacePath };
    return {
      kind: 'repo',
      projectId: project.id,
      repoUrl: project.repoUrl,
      baseBranch: project.baseBranch,
      threadId: thread.id,
      branch: `thread/${thread.id.slice(0, 8)}`,
      fresh,
    };
  }

  // ---- Runs ----

  private startRun(thread: Thread, project: Project, nodeId: string, mode: RunnerMode, input: string): void {
    let text = this.needsSeed(thread) ? `${this.coordinatorSeed(thread)}\n\n${input}` : input;
    if (thread.kind === 'coordinator') {
      const background = this.directConversations(thread.projectId);
      if (background) text = `${background}\n\n${text}`;
    }
    const run = this.store.startRun(thread.id, mode);
    const token = randomUUID();
    this.runTokens.set(token, thread.id);

    const fresh = thread.nodeId !== nodeId;
    if (fresh) {
      const handoff = this.store.handoffOf(thread.id);
      const to = this.store.getNode(nodeId)?.name ?? 'another node';
      if (handoff.from && handoff.from !== nodeId) {
        const from = this.store.getNode(handoff.from)?.name ?? 'a removed node';
        this.addMessage({ threadId: thread.id, runId: run.id, author: 'system', kind: 'node_moved', text: `Moved from ${from} to ${to}`, meta: { from: handoff.from, to: nodeId } });
        text = `[Moved] This thread moved from node ${from} to node ${to}, so its working directory is new${handoff.note ? `: ${handoff.note}` : ''}. Its branch has everything that was pushed.\n\n${text}`;
      }
      this.store.updateThread(thread.id, { nodeId, worktreePath: null, handoffFrom: null, handoffNote: null });
    }

    this.setStatus(thread.id, 'running', { lastMode: mode });
    this.addMessage({
      threadId: thread.id,
      runId: run.id,
      author: 'system',
      kind: 'run_started',
      text: modeLabel(mode),
      meta: { mode, resumed: Boolean(thread.claudeSessionId), nodeId },
    });

    const cfg: WireRunConfig = {
      mcpServers: [{ name: APP_MCP_SERVER, type: 'http', url: '/mcp', headers: { Authorization: `Bearer ${token}` } }],
      allowedTools: toolsFor(thread.kind).map((name) => `mcp__${APP_MCP_SERVER}__${name}`),
      // The coordinator delegates through threads the user can see, not hidden subagents.
      disallowedTools: thread.kind === 'coordinator' ? ['Task', 'Agent'] : undefined,
      appendSystemPrompt: rolePrompt(thread.kind) + memoryPrompt(project),
      permissionMode: 'default',
      maxTurns: this.opts.maxTurns,
      sessionHookPath: `/api/hooks/session-start/${token}`,
    };
    const workspace = this.workspaceFor(thread, project, fresh);

    const untrack = this.runtime.trackRun();
    let handle: RunHandle;
    try {
      handle = this.nodes.startRun(nodeId, {
        runId: run.id,
        threadId: thread.id,
        mode,
        cfg,
        onPermission: (req) => this.askPermission(thread.id, run.id, req),
        message: text,
        resumeSessionId: thread.claudeSessionId,
        workspace,
        env: this.runEnv(mode, nodeId, workspace),
      });
    } catch (err) {
      const message = (err as Error).message;
      this.addMessage({ threadId: thread.id, runId: run.id, author: 'system', kind: 'error', text: message, meta: null });
      this.finishRun(thread.id, run.id, token, { ok: false, inputTokens: 0, outputTokens: 0 }, false, message);
      untrack();
      return;
    }
    const active: ActiveRun = {
      runId: run.id,
      mode,
      kind: thread.kind,
      handle,
      token,
      interrupted: false,
      nodeId,
      lost: false,
      moveAfter: null,
      unfinished: [input],
    };
    this.active.set(thread.id, active);
    this.publishNodes();
    void this.consume(thread.id, active).finally(untrack);
  }

  private async consume(threadId: string, active: ActiveRun): Promise<void> {
    const { runId, mode } = active;
    let seq = 0;
    let errorShown = false;
    let lastText = '';
    let lastError = '';
    let result = {
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      costUsdEstimate: undefined as number | undefined,
      notionalCostUsd: undefined as number | undefined,
    };
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
          case 'context':
            this.publishThread(
              this.store.updateThread(threadId, {
                contextTokens: event.usedTokens,
                contextWindow: event.maxTokens,
                autoCompactAt: event.autoCompactAt ?? null,
              }),
            );
            break;
          case 'plan_usage':
            // The plan meter only means something for runs billed to the plan.
            if (mode === 'subscription') {
              this.runtime.recordPlanUsage({ status: event.status, fiveHour: event.fiveHour, sevenDay: event.sevenDay });
              this.store.addPlanReading(runId, event);
            }
            break;
          case 'compacted':
            add({
              author: 'system',
              kind: 'compacted',
              text: compactionText(event),
              meta: { trigger: event.trigger ?? null, preTokens: event.preTokens ?? null, postTokens: event.postTokens ?? null },
            });
            break;
          case 'error':
            errorShown = true;
            lastError = event.message;
            add({ author: 'system', kind: 'error', text: event.message, meta: null });
            break;
          case 'result':
            // A lost node's runs end with a made-up result; that turn didn't finish.
            if (!active.lost) active.unfinished.shift();
            result = {
              ok: event.ok,
              inputTokens: result.inputTokens + (event.inputTokens ?? 0),
              outputTokens: result.outputTokens + (event.outputTokens ?? 0),
              costUsdEstimate:
                event.costUsdEstimate === undefined ? result.costUsdEstimate : (result.costUsdEstimate ?? 0) + event.costUsdEstimate,
              notionalCostUsd:
                event.notionalCostUsd === undefined ? result.notionalCostUsd : (result.notionalCostUsd ?? 0) + event.notionalCostUsd,
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
    result: { ok: boolean; inputTokens: number; outputTokens: number; costUsdEstimate?: number; notionalCostUsd?: number },
    interrupted: boolean,
    finalText: string,
  ): void {
    const active = this.active.get(threadId);
    // A run cut off by its node going away, or by Stop now, carries on elsewhere rather than ending the work.
    const moving = active?.lost ? 'lost' : (active?.moveAfter ?? null);
    const cutOff = moving === 'lost' || (moving === 'stop' && !result.ok);
    this.active.delete(threadId);
    this.runTokens.delete(token);
    this.approvals.cancelRun(runId);
    const run = this.store.endRun(runId, result);
    if (moving === 'lost' && active!.unfinished.length > 0) {
      // Only finished turns reached the orchestrator's transcript, so ask again for what was in progress.
      this.store.enqueueInput(
        threadId,
        `Your last turn was cut off before it finished, and anything you did in it may be lost. This was the request:\n\n${active!.unfinished.join('\n\n')}`,
      );
    } else if (cutOff) {
      this.store.enqueueInput(threadId, 'Continue where you left off.');
    }
    const outcome = interrupted ? 'stopped' : result.ok ? 'done' : 'failed';
    const nodeName = active ? (this.store.getNode(active.nodeId)?.name ?? 'its node') : '';
    this.addMessage({
      threadId,
      runId,
      author: 'system',
      kind: 'run_ended',
      text:
        moving === 'lost'
          ? `Cut off: ${nodeName} went offline`
          : cutOff
            ? `Stopped to move off ${nodeName}`
            : interrupted
              ? 'Stopped'
              : result.ok
                ? 'Done'
                : 'Failed',
      meta: { mode: run.mode, ok: result.ok, interrupted, costUsdEstimate: run.costUsdEstimate, ...(moving && { moving }) },
    });
    const queued = this.store.hasQueuedInput(threadId);
    const status: ThreadStatus = queued ? 'queued' : interrupted ? 'interrupted' : result.ok ? 'idle' : 'failed';
    this.setStatus(threadId, status);

    const thread = this.getThread(threadId);
    if (thread.kind === 'thread' && !cutOff) {
      // A run the coordinator asked for gets reported back so it can answer the user. A run only
      // the user asked for, in the thread itself, is saved as background for the coordinator's next turn.
      const asked = this.whoAsked(threadId, runId);
      if (asked.coordinator || (asked.user.length === 0 && thread.origin === 'coordinator')) {
        this.notifyCoordinator(thread, outcome, finalText);
      } else if (asked.user.length > 0) {
        this.saveDirectConversation(thread, outcome, asked.user, finalText);
      }
    }
    if (active && moving === 'lost') {
      this.release(threadId, active.nodeId, `${nodeName} went offline mid-turn, so anything it hadn't committed and pushed may be lost`);
    } else if (active && (moving === 'drain' || moving === 'stop')) {
      void this.handoffThread(threadId, active.nodeId, moving);
    }
    this.publishNodes();
    void this.pump();
  }

  // ---- Nodes (M5, M6) ----

  nodesView(): NodeView[] {
    return this.nodes.views({
      ready: (row, info) => this.readiness(row, info),
      threads: (nodeId) =>
        this.store.threadsOnNode(nodeId).map((t) => ({
          id: t.id,
          projectId: t.projectId,
          title: t.kind === 'coordinator' ? `${this.store.getProject(t.projectId)?.name ?? 'Project'} · project chat` : t.title,
          status: t.status,
          running: this.active.get(t.id)?.nodeId === nodeId,
        })),
    });
  }

  /** Enable, drain or stop a node, or change its name or thread limit. */
  async updateNode(nodeId: string, update: NodeUpdate): Promise<NodeView> {
    const row = this.store.getNode(nodeId);
    if (!row) throw new HttpError(404, 'No such node.');
    if (update.name !== undefined) {
      const name = String(update.name).trim();
      if (!name || name.length > 60) throw new HttpError(400, 'A node name is 1 to 60 characters.');
      this.store.updateNode(nodeId, { name });
    }
    if (update.threadLimit !== undefined) {
      const limit = Number(update.threadLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new HttpError(400, 'The thread limit is a whole number from 1 to 32.');
      this.store.updateNode(nodeId, { thread_limit: limit });
    }
    if (update.action === 'enable') {
      this.store.updateNode(nodeId, { state: 'enabled' });
    } else if (update.action === 'drain' || update.action === 'stop') {
      const stop = update.action === 'stop';
      this.store.updateNode(nodeId, { state: stop ? 'disabled' : 'draining' });
      this.opts.log.info(`Node ${row.name}: ${stop ? 'stop now' : 'drain'}`);
      for (const thread of this.movableThreads(nodeId)) {
        const active = this.active.get(thread.id);
        if (active?.nodeId === nodeId) {
          if (active.moveAfter !== 'stop') active.moveAfter = update.action;
          if (stop) await active.handle.interrupt();
        } else if (this.nodes.isOnline(nodeId)) {
          void this.handoffThread(thread.id, nodeId, update.action);
        } else {
          this.release(thread.id, nodeId, `${row.name} was offline when it was ${stop ? 'stopped' : 'drained'}, so anything it hadn't committed and pushed may be lost`);
        }
      }
    } else if (update.action !== undefined) {
      throw new HttpError(400, 'action is one of enable, drain or stop.');
    }
    this.checkDrained(nodeId);
    this.publishNodes();
    void this.pump();
    return this.nodesView().find((n) => n.id === nodeId)!;
  }

  /** Removing a node revokes its token. One that's online has to be drained first so its threads keep their work. */
  removeNode(nodeId: string): void {
    const row = this.store.getNode(nodeId);
    if (!row) throw new HttpError(404, 'No such node.');
    if (row.is_local) throw new HttpError(400, "This machine's own node can't be removed. Disable it instead.");
    const left = this.movableThreads(nodeId);
    if (this.nodes.isOnline(nodeId) && (left.length > 0 || this.runningThreads(nodeId) > 0)) {
      throw new HttpError(409, `Drain this node first: ${left.length} thread${left.length === 1 ? ' is' : 's are'} still on it.`);
    }
    for (const thread of left) this.release(thread.id, nodeId, `${row.name} was removed while offline, so anything it hadn't committed and pushed may be lost`);
    this.nodes.remove(nodeId);
    this.publishNodes();
    void this.pump();
  }

  /** Threads that can move between nodes: repo threads (the coordinator and local-folder projects stay on this machine). */
  private movableThreads(nodeId: string): Thread[] {
    return this.store.threadsOnNode(nodeId).filter((t) => t.kind === 'thread' && Boolean(this.store.getProject(t.projectId)?.repoUrl));
  }

  /** Runs on a node that dropped are lost; the hub ends them, and finishRun queues them to continue elsewhere. */
  private nodeLost(nodeId: string): void {
    for (const run of this.active.values()) if (run.nodeId === nodeId) run.lost = true;
  }

  /** Handoff steps 2 to 4: the node commits and pushes unfinished work, uploads the transcript, and lets the thread go. */
  private async handoffThread(threadId: string, nodeId: string, why: 'drain' | 'stop'): Promise<void> {
    const thread = this.store.getThread(threadId);
    const project = thread && this.store.getProject(thread.projectId);
    if (!thread || !project || thread.nodeId !== nodeId) return;
    const name = this.store.getNode(nodeId)?.name ?? 'the node';
    const workspace = this.workspaceFor(thread, project, false);
    const result = await this.nodes.handoff(nodeId, {
      threadId,
      workspace,
      sessionId: thread.claudeSessionId,
      reason: `handing off from ${name}`,
      env: this.runEnv(thread.lastMode ?? 'subscription', nodeId, workspace),
    });
    const verb = why === 'drain' ? 'drained' : 'stopped';
    if (!result.ok) {
      this.addMessage({ threadId, runId: null, author: 'system', kind: 'error', text: `${name} couldn't hand this thread off: ${result.error}`, meta: null });
    }
    this.release(
      threadId,
      nodeId,
      !result.ok
        ? `${name} was ${verb} but couldn't hand off (${result.error}), so anything it hadn't committed and pushed is still there or lost`
        : result.wip
          ? `${name} was ${verb}, and its uncommitted work was saved as a WIP commit (${result.commit?.slice(0, 7)}) on the branch`
          : `${name} was ${verb}`,
    );
    void this.pump();
  }

  /** Lets a thread go from its node; its next run starts on another node and is told why. */
  private release(threadId: string, nodeId: string, note: string): void {
    if (!this.store.getThread(threadId)) return;
    this.publishThread(this.store.updateThread(threadId, { nodeId: null, worktreePath: null, handoffFrom: nodeId, handoffNote: note }));
    this.checkDrained(nodeId);
    this.publishNodes();
  }

  /** A draining node with nothing left on it is disabled. */
  private checkDrained(nodeId: string): void {
    const row = this.store.getNode(nodeId);
    if (row?.state !== 'draining') return;
    if (this.movableThreads(nodeId).length > 0) return;
    this.store.updateNode(nodeId, { state: 'disabled' });
    this.opts.log.info(`Node ${row.name} drained`);
  }

  private publishNodes(): void {
    if (this.nodesQueued) return;
    this.nodesQueued = true;
    setTimeout(() => {
      this.nodesQueued = false;
      this.bus.publish({ type: 'nodes', nodes: this.nodesView() });
    }, 50).unref();
  }

  /**
   * Who wrote the inputs of a run: every user-authored message since the previous run that finished
   * normally (a run cut off by a node going away is carried on by the next, so its inputs count too).
   */
  private whoAsked(threadId: string, runId: number): { coordinator: boolean; user: string[] } {
    const messages = this.store.listMessages(threadId);
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.kind === 'run_ended' && m.runId !== runId && !m.meta?.moving) {
        start = i + 1;
        break;
      }
    }
    const asked = { coordinator: false, user: [] as string[] };
    for (const m of messages.slice(start)) {
      if (m.kind !== 'text' || m.author !== 'user') continue;
      if (m.meta?.from === 'coordinator') asked.coordinator = true;
      else asked.user.push(m.text);
    }
    return asked;
  }

  /** The user talked to a thread directly: keep what was asked and answered for the coordinator, without a turn. */
  private saveDirectConversation(thread: Thread, outcome: 'done' | 'stopped' | 'failed', userTexts: string[], finalText: string): void {
    const trim = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
    const said = { done: 'answered', stopped: 'was stopped by the user', failed: 'failed' }[outcome];
    const answer = finalText.trim();
    this.store.addCoordinatorContext(
      thread.projectId,
      [
        `- "${thread.title}" (thread_id: ${thread.id}) ${said}.`,
        `  The user wrote: ${userTexts.map((t) => trim(t.trim(), DIRECT_USER_LIMIT)).join(' / ')}`,
        `  The thread's final message: ${answer ? trim(answer, NOTICE_TEXT_LIMIT) : '(none)'}`,
      ].join('\n'),
    );
  }

  /** Background the coordinator gets at the start of its next turn; empty when there is none. */
  private directConversations(projectId: string): string {
    const entries = this.store.takeCoordinatorContext(projectId, DIRECT_CONTEXT_ENTRIES);
    if (entries.length === 0) return '';
    return [
      '[Background, no reply needed] Since your last turn, the user talked directly with these threads in their own chats. This is so you know what was discussed and decided. Do not answer or restate it; use it only if it bears on what the user asks you.',
      ...entries,
    ].join('\n');
  }

  /** Lifecycle step 5: tell the coordinator a thread it started finished a run, with its final text trimmed. */
  private notifyCoordinator(thread: Thread, outcome: 'done' | 'stopped' | 'failed', finalText: string): void {
    const coordinatorId = this.store.getProject(thread.projectId)?.coordinatorThreadId;
    if (!coordinatorId) return;
    const said = { done: 'finished', stopped: 'was stopped by the user', failed: 'failed' }[outcome];
    const text = finalText.trim();
    const body = !text
      ? '(no final message)'
      : text.length > NOTICE_TEXT_LIMIT
        ? `${text.slice(0, NOTICE_TEXT_LIMIT)}…\n\n[Cut at ${NOTICE_TEXT_LIMIT.toLocaleString('en-US')} characters. Use read_thread for the full message.]`
        : text;
    // The project chat shows the notice collapsed; finalText is what the coordinator was told, for click-to-view.
    this.addMessage({
      threadId: coordinatorId,
      runId: null,
      author: 'system',
      kind: 'thread_notice',
      text: `${thread.title} ${said}`,
      meta: { threadId: thread.id, outcome, finalText: body },
    });
    this.deliver(coordinatorId, `[Thread update] "${thread.title}" (thread_id: ${thread.id}) ${said}.\n\nFinal message:\n${body}`);
  }

  private async askPermission(threadId: string, runId: number, req: PermissionRequest): Promise<PermissionDecision> {
    const auto = autoApproval(this.runtime.approvals, req);
    if (auto.allow) return { behavior: 'allow' };
    if (auto.reason) req = { ...req, decisionReason: [auto.reason, req.decisionReason].filter(Boolean).join(' ') };
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

  /** A coordinator starting a new session after it has run before (it was reset, or its session was lost). */
  private needsSeed(thread: Thread): boolean {
    return thread.kind === 'coordinator' && !thread.claudeSessionId && this.store.listRuns(thread.id).length > 0;
  }

  private coordinatorSeed(thread: Thread): string {
    const ctx: RunContext = { threadId: thread.id, projectId: thread.projectId, kind: 'coordinator' };
    const threads = this.summarizeThreads(ctx)
      .map((t) => `- ${t.title} (thread_id: ${t.id}) · ${t.status}${t.lastResult ? ` · last reply: ${t.lastResult}` : ''}`)
      .join('\n');
    return [
      "[Fresh coordinator session] The user started a new coordinator session for this project chat, so you don't have the earlier conversation.",
      'The project memory is in your system prompt. These are the project\'s threads; use read_thread for detail:',
      threads || '(none yet)',
      '',
      "The user's message:",
    ].join('\n');
  }

  private getProject(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new HttpError(404, 'No such project.');
    return project;
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

/** MEMORY.md for the system prompt, with how to keep it. */
function memoryPrompt(project: Project): string {
  const text = readMemory(project).trim();
  const body = !text
    ? '(empty)'
    : text.length > MEMORY_PROMPT_LIMIT
      ? `${text.slice(0, MEMORY_PROMPT_LIMIT)}\n…(cut here; read_memory has the rest)`
      : text;
  return [
    '',
    '',
    '# Project memory',
    '',
    'This is MEMORY.md from the project workspace, shared by every session in the project. When you learn a durable fact or the user makes a decision that other sessions should know, record it with write_memory: read the file first and keep what is still true, because write_memory replaces the whole file. Leave out progress notes and anything only your current task needs.',
    '',
    '<project-memory>',
    body,
    '</project-memory>',
  ].join('\n');
}

function compactionText(event: { trigger?: 'manual' | 'auto'; preTokens?: number; postTokens?: number }): string {
  const how = event.trigger === 'auto' ? 'automatically' : event.trigger === 'manual' ? 'on request' : '';
  const sizes =
    event.preTokens !== undefined
      ? ` · ${formatTokens(event.preTokens)}${event.postTokens !== undefined ? ` → ${formatTokens(event.postTokens)}` : ''} tokens`
      : '';
  return `Context compacted${how ? ` ${how}` : ''}${sizes}`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
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
