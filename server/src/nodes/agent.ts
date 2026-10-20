import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RunnerMode } from '@ccf/shared';
import type { PermissionDecision, RunConfig, RunEvent, RunHandle, SessionRunner } from '../runners/types.js';
import { clonedProjects, commitWip, ensureWorktree, git, pushIfAhead, removeWorktree, worktreeDir } from './git.js';
import type { FromNode, Handoff, Link, NodeInfoReport, RunStart, ToNode, Workspace } from './protocol.js';
import { readResources } from './resources.js';
import { fileSize, readFrom, transcriptPath } from './transcripts.js';

export interface AgentOptions {
  /** Clones, worktrees and package caches live here. */
  workDir: string;
  /** The orchestrator's base URL as this node reaches it; sessions call its MCP server and hooks there. */
  baseUrl: () => string;
  runners: Record<RunnerMode, SessionRunner>;
  /** Environment for git and for finding Claude Code's transcripts. */
  env?: NodeJS.ProcessEnv;
  log?: { info(msg: string): void; warn(msg: string): void };
}

interface AgentRun {
  start: RunStart;
  cwd: string | null;
  handle: RunHandle | null;
  sessionId: string | null;
  interrupted: boolean;
  /** Follow-ups that arrived while the workspace was being prepared. */
  pending: string[];
  permissions: Map<string, (d: PermissionDecision) => void>;
  /** After-turn work (transcript upload, push), one at a time. */
  chain: Promise<void>;
}

/**
 * The node side of the protocol: prepares each run's workspace, runs it with the local runner,
 * streams its events back, and after every turn uploads the transcript and pushes new commits.
 * The orchestrator's own machine runs one of these in-process; other machines run it in the worker.
 */
export class NodeAgent {
  private link: Link<ToNode, FromNode> | null = null;
  private readonly runs = new Map<number, AgentRun>();
  private readonly fetches = new Map<string, (data: string | null) => void>();
  /** How much of each transcript the orchestrator holds, keyed by thread and session. */
  private readonly uploaded = new Map<string, number>();
  private gitIdentity: Record<string, string> | null = null;

  constructor(private readonly opts: AgentOptions) {}

  private get env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  attach(link: Link<ToNode, FromNode>): void {
    this.link = link;
    link.onMessage((m) => void this.handle(m));
    link.onClose(() => {
      if (this.link !== link) return;
      this.link = null;
      // Nobody can hear these runs any more; the orchestrator resumes their threads elsewhere.
      for (const run of this.runs.values()) {
        run.interrupted = true;
        void run.handle?.interrupt();
      }
    });
  }

  hello(token: string, version: string, info: NodeInfoReport): FromNode {
    return { t: 'hello', token, version, info, resources: this.resources(), projects: clonedProjects(this.opts.workDir) };
  }

  resources() {
    return readResources(this.opts.workDir);
  }

  activeRuns(): number {
    return this.runs.size;
  }

  private send(m: FromNode): void {
    this.link?.send(m);
  }

  private async handle(m: ToNode): Promise<void> {
    switch (m.t) {
      case 'run_start':
        return this.startRun(m);
      case 'run_send': {
        const run = this.runs.get(m.runId);
        if (!run) return this.send({ t: 'send_rejected', runId: m.runId, text: m.text });
        if (!run.handle) {
          run.pending.push(m.text);
          return;
        }
        if (!run.handle.send(m.text)) this.send({ t: 'send_rejected', runId: m.runId, text: m.text });
        return;
      }
      case 'run_interrupt': {
        const run = this.runs.get(m.runId);
        if (!run) return;
        run.interrupted = true;
        await run.handle?.interrupt();
        return;
      }
      case 'permission_result': {
        const resolve = this.runs.get(m.runId)?.permissions.get(m.reqId);
        if (!resolve) return;
        this.runs.get(m.runId)!.permissions.delete(m.reqId);
        resolve(
          m.behavior === 'allow'
            ? { behavior: 'allow', updatedPermissions: m.updatedPermissions }
            : { behavior: 'deny', message: m.message ?? 'Denied.' },
        );
        return;
      }
      case 'transcript_data': {
        this.fetches.get(m.reqId)?.(m.data);
        this.fetches.delete(m.reqId);
        return;
      }
      case 'transcript_resync': {
        this.uploaded.set(`${m.threadId}:${m.sessionId}`, m.size);
        return;
      }
      case 'handoff':
        return this.handoff(m);
      default:
        return;
    }
  }

  private async startRun(start: RunStart): Promise<void> {
    const run: AgentRun = {
      start,
      cwd: null,
      handle: null,
      sessionId: start.resumeSessionId,
      interrupted: false,
      pending: [],
      permissions: new Map(),
      chain: Promise.resolve(),
    };
    this.runs.set(start.runId, run);
    const emit = (event: RunEvent) => this.send({ t: 'run_event', runId: start.runId, event });

    try {
      const runEnv = { ...this.env, ...start.env, ...(await this.identityEnv()) };
      run.cwd = await this.prepare(start.workspace, runEnv);
      this.send({ t: 'run_workspace', runId: start.runId, cwd: run.cwd });
      if (start.resumeSessionId) {
        await this.ensureTranscript(start.threadId, start.resumeSessionId, run.cwd, start.transcriptSize);
      }
      if (run.interrupted) {
        emit({ type: 'result', ok: false, finalText: 'Stopped before it started.' });
        return;
      }

      const runner = this.opts.runners[start.mode];
      // Claude Code must keep transcripts where this agent looks for them.
      const configDir: Record<string, string> = this.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: this.env.CLAUDE_CONFIG_DIR } : {};
      const cfg = this.runConfig(run, run.cwd, { ...start.env, ...configDir, ...(await this.identityEnv()) });
      run.handle = start.resumeSessionId ? runner.resume(start.resumeSessionId, cfg, start.message) : runner.start(cfg, start.message);
      for (const text of run.pending.splice(0)) {
        if (!run.handle.send(text)) this.send({ t: 'send_rejected', runId: start.runId, text });
      }

      for await (const event of run.handle.events) {
        emit(event);
        if (event.type === 'init') run.sessionId = event.sessionId;
        if (event.type === 'result') run.chain = run.chain.then(() => this.afterTurn(run, runEnv));
      }
      await run.chain;
    } catch (err) {
      emit({ type: 'error', message: (err as Error).message });
      emit({ type: 'result', ok: false, finalText: (err as Error).message });
    } finally {
      for (const resolve of run.permissions.values()) resolve({ behavior: 'deny', message: 'Run ended.' });
      this.runs.delete(start.runId);
      this.send({ t: 'run_end', runId: start.runId });
    }
  }

  private async prepare(ws: Workspace, env: NodeJS.ProcessEnv): Promise<string> {
    if (ws.kind === 'folder') {
      fs.mkdirSync(ws.path, { recursive: true });
      return fs.realpathSync(ws.path);
    }
    return ensureWorktree({ workDir: this.opts.workDir, ...ws }, env);
  }

  private runConfig(run: AgentRun, cwd: string, env: Record<string, string>): RunConfig {
    const { cfg, runId } = run.start;
    const base = this.opts.baseUrl().replace(/\/$/, '');
    return {
      cwd,
      model: cfg.model,
      thinking: cfg.thinking,
      appendSystemPrompt: cfg.appendSystemPrompt,
      mcpServers: cfg.mcpServers.map((s) => ({ ...s, url: base + s.url })),
      allowedTools: cfg.allowedTools,
      disallowedTools: cfg.disallowedTools,
      permissionMode: cfg.permissionMode,
      maxTurns: cfg.maxTurns,
      sessionHookUrl: cfg.sessionHookPath ? base + cfg.sessionHookPath : undefined,
      env,
      onPermission: (req) =>
        new Promise<PermissionDecision>((resolve) => {
          const reqId = randomUUID();
          run.permissions.set(reqId, resolve);
          this.send({
            t: 'permission_request',
            runId,
            reqId,
            toolName: req.toolName,
            input: req.input,
            toolUseId: req.toolUseId,
            decisionReason: req.decisionReason,
            suggestions: req.suggestions,
          });
          req.signal.addEventListener(
            'abort',
            () => {
              if (!run.permissions.delete(reqId)) return;
              this.send({ t: 'permission_cancel', runId, reqId });
              resolve({ behavior: 'deny', message: 'Run stopped.' });
            },
            { once: true },
          );
        }),
    };
  }

  /** Commits made by Claude on a node with no git identity of its own would fail; give it one. */
  private async identityEnv(): Promise<Record<string, string>> {
    if (this.gitIdentity) return this.gitIdentity;
    let email = '';
    try {
      email = await git(this.opts.workDir, ['config', '--global', 'user.email'], this.env);
    } catch {
      // Not set.
    }
    this.gitIdentity = email
      ? {}
      : {
          GIT_AUTHOR_NAME: 'Custom Claude Frontend',
          GIT_AUTHOR_EMAIL: 'ccf-node@localhost',
          GIT_COMMITTER_NAME: 'Custom Claude Frontend',
          GIT_COMMITTER_EMAIL: 'ccf-node@localhost',
        };
    return this.gitIdentity;
  }

  /** Repo threads keep their transcript and branch on the orchestrator and GitHub, so another node can pick them up. */
  private async afterTurn(run: AgentRun, env: NodeJS.ProcessEnv): Promise<void> {
    const ws = run.start.workspace;
    if (ws.kind !== 'repo' || !run.cwd) return;
    if (run.sessionId) this.uploadTranscript(ws.threadId, run.sessionId, run.cwd);
    try {
      const commit = await pushIfAhead(run.cwd, ws.branch, env);
      if (commit) this.send({ t: 'pushed', threadId: ws.threadId, branch: ws.branch, commit, wip: false });
    } catch (err) {
      this.send({ t: 'git_error', threadId: ws.threadId, message: (err as Error).message });
    }
  }

  private uploadTranscript(threadId: string, sessionId: string, cwd: string): void {
    const key = `${threadId}:${sessionId}`;
    const file = transcriptPath(cwd, sessionId, this.env);
    let offset = this.uploaded.get(key) ?? 0;
    if (fileSize(file) < offset) offset = 0;
    const data = readFrom(file, offset);
    if (!data) return;
    this.send({ t: 'transcript', threadId, sessionId, offset, data });
    this.uploaded.set(key, offset + Buffer.byteLength(data));
  }

  /** Before resuming, make sure this node has at least what the orchestrator holds of the transcript. */
  private async ensureTranscript(threadId: string, sessionId: string, cwd: string, size: number): Promise<void> {
    const file = transcriptPath(cwd, sessionId, this.env);
    if (fileSize(file) < size) {
      const reqId = randomUUID();
      const data = await new Promise<string | null>((resolve) => {
        this.fetches.set(reqId, resolve);
        this.send({ t: 'transcript_fetch', reqId, threadId, sessionId });
      });
      if (data !== null) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data);
      }
    }
    this.uploaded.set(`${threadId}:${sessionId}`, size);
  }

  /** Lets a thread leave this node: commit what's uncommitted, push, upload the transcript, drop the worktree. */
  private async handoff(m: Handoff): Promise<void> {
    const ws = m.workspace;
    if (ws.kind !== 'repo') {
      this.send({ t: 'handoff_done', reqId: m.reqId, ok: true });
      return;
    }
    const tree = worktreeDir(this.opts.workDir, ws.projectId, ws.threadId);
    if (!fs.existsSync(tree)) {
      this.send({ t: 'handoff_done', reqId: m.reqId, ok: true });
      return;
    }
    const env = { ...this.env, ...m.env, ...(await this.identityEnv()) };
    try {
      const cwd = fs.realpathSync(tree);
      const wip = await commitWip(cwd, `WIP: ${m.reason}`, env);
      const commit = await pushIfAhead(cwd, ws.branch, env);
      if (commit) this.send({ t: 'pushed', threadId: ws.threadId, branch: ws.branch, commit, wip });
      if (m.sessionId) {
        if (!this.uploaded.has(`${ws.threadId}:${m.sessionId}`)) this.uploaded.set(`${ws.threadId}:${m.sessionId}`, m.transcriptSize);
        this.uploadTranscript(ws.threadId, m.sessionId, cwd);
      }
      await removeWorktree(this.opts.workDir, ws.projectId, tree, env);
      this.send({ t: 'handoff_done', reqId: m.reqId, ok: true, commit: commit ?? undefined, wip });
    } catch (err) {
      this.send({ t: 'handoff_done', reqId: m.reqId, ok: false, error: (err as Error).message });
    }
  }
}
