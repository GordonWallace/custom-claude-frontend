import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NodeResources, NodeView, PairingCode, RunnerMode } from '@ccf/shared';
import { HttpError } from '../errors.js';
import type { PermissionDecision, PermissionRequest, RunEvent, RunHandle } from '../runners/types.js';
import type { NodeRow, Store } from '../store.js';
import type { NodeAgent } from './agent.js';
import {
  type FromNode,
  type Link,
  memoryLinkPair,
  type NodeHello,
  type NodeInfoReport,
  OFFLINE_AFTER_MS,
  type ToNode,
  type WireRunConfig,
  type Workspace,
} from './protocol.js';
import type { TranscriptStore } from './transcripts.js';

const PAIRING_MS = 15 * 60_000;
export const DEFAULT_THREAD_LIMIT = 2;

export interface RunSpec {
  runId: number;
  threadId: string;
  mode: RunnerMode;
  cfg: WireRunConfig;
  onPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  message: string;
  resumeSessionId: string | null;
  workspace: Workspace;
  env: Record<string, string>;
}

/** What the hub tells the thread service about. */
export interface HubHandlers {
  /** A node's connection dropped or went silent; its runs are ending with an error. */
  nodeLost(nodeId: string): void;
  sendRejected(threadId: string, text: string): void;
  workspace(threadId: string, cwd: string): void;
  pushed(threadId: string, branch: string, commit: string, wip: boolean): void;
  gitError(threadId: string, message: string): void;
  /** Node list, state or resources changed. */
  changed(): void;
}

interface RemoteRun {
  threadId: string;
  queue: EventQueue;
  ended: boolean;
  onPermission: RunSpec['onPermission'];
  permissions: Map<string, AbortController>;
}

interface Connection {
  nodeId: string;
  link: Link<FromNode, ToNode>;
  lastHeartbeat: number;
  info: NodeInfoReport | null;
  projects: Set<string>;
  runs: Map<number, RemoteRun>;
  handoffs: Map<string, (r: HandoffResult) => void>;
}

export interface HandoffResult {
  ok: boolean;
  error?: string;
  commit?: string;
  wip?: boolean;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The orchestrator's side of every node connection: which nodes exist and are online, pairing,
 * starting runs on a node (as a RunHandle the thread service consumes like any other), handoffs,
 * and transcripts. Placement and handoff policy live in the thread service.
 */
export class NodeHub {
  private readonly conns = new Map<string, Connection>();
  private readonly pairing = new Map<string, number>();
  private readonly offlineSince = new Map<string, number>();
  private readonly startedAt = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private localId = '';
  handlers: HubHandlers = { nodeLost() {}, sendRejected() {}, workspace() {}, pushed() {}, gitError() {}, changed() {} };

  constructor(
    private readonly store: Store,
    private readonly transcripts: TranscriptStore,
    private readonly log: { info(msg: string): void; warn(msg: string): void },
  ) {}

  get localNodeId(): string {
    return this.localId;
  }

  /** The orchestrator's own machine as a node, running `agent` in-process over a memory link. */
  attachLocal(agent: NodeAgent, info: NodeInfoReport, name: string, threadLimit: number): void {
    let row = this.store.listNodes().find((n) => n.is_local === 1);
    if (!row) row = this.store.createNode({ name, local: true, tokenHash: null, threadLimit });
    this.localId = row.id;
    const pair = memoryLinkPair();
    agent.attach(pair.node);
    const conn = this.register(row.id, pair.orchestrator, info, new Set());
    this.store.updateNode(row.id, { info_json: JSON.stringify(info), last_seen_at: new Date().toISOString(), resources_json: JSON.stringify(agent.resources()) });
    // Checks remote heartbeats often, so a silent node shows offline soon after 30 seconds. The local
    // node never misses one; its resources refresh on a remote node's heartbeat cadence.
    let tick = 0;
    this.timer = setInterval(() => {
      conn.lastHeartbeat = Date.now();
      if (tick++ % 5 === 0) {
        this.store.updateNode(row.id, { last_seen_at: new Date().toISOString(), resources_json: JSON.stringify(agent.resources()) });
      }
      this.checkHeartbeats();
    }, 2_000);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
    for (const conn of this.conns.values()) conn.link.close();
  }

  // ---- Pairing ----

  createPairingCode(url: string, guidance: Pick<PairingCode, 'setup' | 'note'> = {}): PairingCode {
    const code = randomBytes(5).toString('hex').toUpperCase();
    const expiresAt = Date.now() + PAIRING_MS;
    this.pairing.set(code, expiresAt);
    const quoted = `'${url.replace(/'/g, `'\\''`)}'`;
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      url,
      command: `curl -fsSL ${quoted}/api/nodes/install.sh | sh -s -- ${quoted} ${code}`,
      ...guidance,
    };
  }

  /** Trades a one-time pairing code for a node and its token. The token is shown once and stored only as a hash. */
  pair(code: string, name: string): { nodeId: string; name: string; token: string } {
    const expires = this.pairing.get(String(code).toUpperCase());
    if (!expires || expires < Date.now()) throw new HttpError(403, 'That pairing code is unknown or expired. Click Add node again for a new one.');
    this.pairing.delete(String(code).toUpperCase());
    const token = randomBytes(32).toString('base64url');
    const taken = new Set(this.store.listNodes().map((n) => n.name));
    let unique = name.trim().slice(0, 60) || 'node';
    for (let i = 2; taken.has(unique); i++) unique = `${name.trim().slice(0, 56)}-${i}`;
    const row = this.store.createNode({ name: unique, local: false, tokenHash: hashToken(token), threadLimit: DEFAULT_THREAD_LIMIT });
    this.log.info(`Paired node ${row.name} (${row.id})`);
    this.handlers.changed();
    return { nodeId: row.id, name: row.name, token };
  }

  /** Removing a node revokes its token and drops its connection. */
  remove(nodeId: string): void {
    this.conns.get(nodeId)?.link.close();
    this.store.deleteNode(nodeId);
    this.offlineSince.delete(nodeId);
    this.handlers.changed();
  }

  // ---- Connections ----

  /** A remote node's WebSocket: the first message must be its hello with a valid token. */
  acceptRemote(link: Link<FromNode, ToNode>): void {
    let conn: Connection | null = null;
    const greet = setTimeout(() => !conn && link.close(), 10_000);
    link.onMessage((m) => {
      if (conn) return this.onMessage(conn, m);
      if (m.t !== 'hello') return link.close();
      clearTimeout(greet);
      const row = this.store.nodeByTokenHash(hashToken(m.token));
      if (!row) {
        link.send({ t: 'refused', reason: 'Unknown node token. The node may have been removed; pair it again.' });
        return link.close();
      }
      conn = this.register(row.id, link, m.info, new Set(m.projects));
      this.store.updateNode(row.id, { info_json: JSON.stringify(m.info), resources_json: JSON.stringify(m.resources), last_seen_at: new Date().toISOString() });
      link.send({ t: 'welcome', nodeId: row.id, name: row.name });
      this.log.info(`Node ${row.name} connected (${m.info.hostname}, ${m.info.platform}/${m.info.arch}, worker ${(m as NodeHello).version})`);
      this.handlers.changed();
    });
    link.onClose(() => {
      clearTimeout(greet);
      if (conn && this.conns.get(conn.nodeId) === conn) this.disconnect(conn);
    });
  }

  private register(nodeId: string, link: Link<FromNode, ToNode>, info: NodeInfoReport | null, projects: Set<string>): Connection {
    const old = this.conns.get(nodeId);
    if (old) {
      this.conns.delete(nodeId);
      old.link.close();
      this.disconnect(old);
    }
    const conn: Connection = { nodeId, link, lastHeartbeat: Date.now(), info, projects, runs: new Map(), handoffs: new Map() };
    this.conns.set(nodeId, conn);
    this.offlineSince.delete(nodeId);
    if (nodeId === this.localId) link.onMessage((m) => this.onMessage(conn, m));
    return conn;
  }

  private disconnect(conn: Connection): void {
    if (this.conns.get(conn.nodeId) === conn) this.conns.delete(conn.nodeId);
    this.offlineSince.set(conn.nodeId, Date.now());
    const name = this.store.getNode(conn.nodeId)?.name ?? conn.nodeId;
    this.log.warn(`Node ${name} went offline`);
    this.handlers.nodeLost(conn.nodeId);
    for (const run of conn.runs.values()) {
      run.queue.push({ type: 'error', message: `Lost the connection to node ${name}.` });
      run.queue.push({ type: 'result', ok: false, finalText: `Lost the connection to node ${name}.` });
      run.queue.end();
      for (const c of run.permissions.values()) c.abort();
    }
    conn.runs.clear();
    for (const resolve of conn.handoffs.values()) resolve({ ok: false, error: `Node ${name} went offline.` });
    conn.handoffs.clear();
    this.handlers.changed();
  }

  /** Closes connections that have gone quiet; their close handler marks the node offline. */
  checkHeartbeats(): void {
    const now = Date.now();
    for (const conn of [...this.conns.values()]) {
      if (conn.nodeId !== this.localId && now - conn.lastHeartbeat > OFFLINE_AFTER_MS) {
        conn.link.close();
        if (this.conns.get(conn.nodeId) === conn) this.disconnect(conn);
      }
    }
  }

  isOnline(nodeId: string): boolean {
    return this.conns.has(nodeId);
  }

  /** How long a node has been offline (counting from the server's start for one not seen since). 0 when online. */
  offlineFor(nodeId: string): number {
    if (this.conns.has(nodeId)) return 0;
    return Date.now() - (this.offlineSince.get(nodeId) ?? this.startedAt);
  }

  info(nodeId: string): NodeInfoReport | null {
    return this.conns.get(nodeId)?.info ?? parse<NodeInfoReport>(this.store.getNode(nodeId)?.info_json ?? null);
  }

  hasProject(nodeId: string, projectId: string): boolean {
    return this.conns.get(nodeId)?.projects.has(projectId) ?? false;
  }

  private onMessage(conn: Connection, m: FromNode): void {
    conn.lastHeartbeat = Date.now();
    switch (m.t) {
      case 'heartbeat':
        this.store.updateNode(conn.nodeId, { resources_json: JSON.stringify(m.resources), last_seen_at: new Date().toISOString() });
        this.handlers.changed();
        return;
      case 'run_event':
        conn.runs.get(m.runId)?.queue.push(m.event);
        return;
      case 'run_end': {
        const run = conn.runs.get(m.runId);
        conn.runs.delete(m.runId);
        run?.queue.end();
        if (run) run.ended = true;
        return;
      }
      case 'run_workspace': {
        const run = conn.runs.get(m.runId);
        if (run) this.handlers.workspace(run.threadId, m.cwd);
        return;
      }
      case 'send_rejected': {
        const run = conn.runs.get(m.runId);
        if (run) run.ended = true;
        const threadId = run?.threadId ?? this.rejectedThread(m.runId);
        if (threadId) this.handlers.sendRejected(threadId, m.text);
        return;
      }
      case 'permission_request': {
        const run = conn.runs.get(m.runId);
        if (!run) return;
        const controller = new AbortController();
        run.permissions.set(m.reqId, controller);
        void run
          .onPermission({
            toolName: m.toolName,
            input: m.input,
            toolUseId: m.toolUseId,
            decisionReason: m.decisionReason,
            suggestions: m.suggestions,
            signal: controller.signal,
          })
          .then((d) => {
            run.permissions.delete(m.reqId);
            conn.link.send(
              d.behavior === 'allow'
                ? { t: 'permission_result', runId: m.runId, reqId: m.reqId, behavior: 'allow', updatedPermissions: d.updatedPermissions }
                : { t: 'permission_result', runId: m.runId, reqId: m.reqId, behavior: 'deny', message: d.message },
            );
          });
        return;
      }
      case 'permission_cancel':
        conn.runs.get(m.runId)?.permissions.get(m.reqId)?.abort();
        return;
      case 'transcript_fetch':
        conn.link.send({ t: 'transcript_data', reqId: m.reqId, data: this.transcripts.read(m.threadId, m.sessionId) });
        return;
      case 'transcript': {
        const result = this.transcripts.write(m.threadId, m.sessionId, m.offset, m.data);
        if (!result.ok) conn.link.send({ t: 'transcript_resync', threadId: m.threadId, sessionId: m.sessionId, size: result.size });
        return;
      }
      case 'pushed':
        this.handlers.pushed(m.threadId, m.branch, m.commit, m.wip);
        return;
      case 'git_error':
        this.handlers.gitError(m.threadId, m.message);
        return;
      case 'handoff_done': {
        const resolve = conn.handoffs.get(m.reqId);
        conn.handoffs.delete(m.reqId);
        resolve?.({ ok: m.ok, error: m.error, commit: m.commit, wip: m.wip });
        return;
      }
      default:
        return;
    }
  }

  /** Runs that already ended are forgotten, so a late rejection is matched by the run row instead. */
  private rejectedThread(runId: number): string | undefined {
    return this.store.getRun(runId)?.threadId;
  }

  // ---- Runs ----

  runningOn(nodeId: string): number {
    return this.conns.get(nodeId)?.runs.size ?? 0;
  }

  startRun(nodeId: string, spec: RunSpec): RunHandle {
    const conn = this.conns.get(nodeId);
    if (!conn) throw new Error('That node is offline.');
    const run: RemoteRun = { threadId: spec.threadId, queue: new EventQueue(), ended: false, onPermission: spec.onPermission, permissions: new Map() };
    conn.runs.set(spec.runId, run);
    if (spec.workspace.kind === 'repo') conn.projects.add(spec.workspace.projectId);
    conn.link.send({
      t: 'run_start',
      runId: spec.runId,
      threadId: spec.threadId,
      mode: spec.mode,
      cfg: spec.cfg,
      message: spec.message,
      resumeSessionId: spec.resumeSessionId,
      transcriptSize: this.transcripts.size(spec.threadId, spec.resumeSessionId),
      workspace: spec.workspace,
      env: spec.env,
    });
    return {
      events: run.queue,
      send: (text) => {
        if (run.ended || !this.conns.has(nodeId)) return false;
        conn.link.send({ t: 'run_send', runId: spec.runId, text });
        return true;
      },
      interrupt: async () => {
        conn.link.send({ t: 'run_interrupt', runId: spec.runId });
      },
    };
  }

  handoff(
    nodeId: string,
    req: { threadId: string; workspace: Workspace; sessionId: string | null; reason: string; env: Record<string, string> },
  ): Promise<HandoffResult> {
    const conn = this.conns.get(nodeId);
    if (!conn) return Promise.resolve({ ok: false, error: 'The node is offline.' });
    const reqId = randomUUID();
    return new Promise((resolve) => {
      conn.handoffs.set(reqId, resolve);
      conn.link.send({ t: 'handoff', reqId, ...req, transcriptSize: this.transcripts.size(req.threadId, req.sessionId) });
    });
  }

  // ---- Views ----

  views(deps: {
    ready: (row: NodeRow, info: NodeInfoReport | null) => NodeView['ready'];
    threads: (nodeId: string) => NodeView['threads'];
  }): NodeView[] {
    return this.store.listNodes().map((row) => {
      const info = this.info(row.id);
      return {
        id: row.id,
        name: row.name,
        local: row.is_local === 1,
        state: row.state,
        online: this.isOnline(row.id),
        threadLimit: row.thread_limit,
        lastSeenAt: row.last_seen_at,
        resources: parse<NodeResources>(row.resources_json),
        info,
        ready: deps.ready(row, info),
        threads: deps.threads(row.id),
        createdAt: row.created_at,
      };
    });
  }
}

function parse<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** A run's events as they arrive from its node, consumed as an async iterable. */
class EventQueue implements AsyncIterable<RunEvent> {
  private readonly items: RunEvent[] = [];
  private done = false;
  private wake?: () => void;

  push(e: RunEvent): void {
    if (this.done) return;
    this.items.push(e);
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<RunEvent> {
    while (true) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}
