import { randomUUID } from 'node:crypto';
import type { Message, MessageKind, NodeState, Project, Run, RunnerMode, Thread, ThreadStatus, UsageWindow } from '@ccf/shared';
import type { Db } from './db.js';
import type { PlanReading, RunWeight } from './planUsage.js';

interface ThreadRow {
  id: string;
  project_id: string;
  kind: Thread['kind'];
  origin: Thread['origin'];
  title: string;
  status: ThreadStatus;
  claude_session_id: string | null;
  last_mode: RunnerMode | null;
  context_tokens: number | null;
  context_window: number | null;
  auto_compact_at: number | null;
  node_id: string | null;
  worktree_path: string | null;
  handoff_from: string | null;
  handoff_note: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  thread_id: string;
  run_id: number | null;
  author: Message['author'];
  kind: MessageKind;
  text: string;
  meta_json: string | null;
  created_at: string;
}

interface RunRow {
  id: number;
  thread_id: string;
  mode: RunnerMode;
  started_at: string;
  ended_at: string | null;
  ok: number | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd_estimate: number | null;
}

const now = () => new Date().toISOString();

const toThread = (r: ThreadRow): Thread => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  origin: r.origin,
  title: r.title,
  status: r.status,
  claudeSessionId: r.claude_session_id,
  lastMode: r.last_mode,
  contextTokens: r.context_tokens,
  contextWindow: r.context_window,
  autoCompactAt: r.auto_compact_at,
  nodeId: r.node_id,
  worktreePath: r.worktree_path,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  threadId: r.thread_id,
  runId: r.run_id,
  author: r.author,
  kind: r.kind,
  text: r.text,
  meta: r.meta_json ? (JSON.parse(r.meta_json) as Record<string, unknown>) : null,
  createdAt: r.created_at,
});

const toRun = (r: RunRow): Run => ({
  id: r.id,
  threadId: r.thread_id,
  mode: r.mode,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  ok: r.ok === null ? null : r.ok === 1,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  costUsdEstimate: r.cost_usd_estimate,
});

/** SQL for projects, threads, messages, runs and run events. No business rules live here. */
export class Store {
  constructor(private readonly db: Db) {}

  /** Inserts the project and the coordinator thread that backs its project chat. */
  createProject(
    name: string,
    workspacePath: string,
    coordinatorTitle: string,
    repo: { repoUrl: string | null; baseBranch: string | null } = { repoUrl: null, baseBranch: null },
  ): Project {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO projects (id, name, workspace_path, repo_url, base_branch, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, workspacePath, repo.repoUrl, repo.baseBranch, now());
    this.createThread(id, 'coordinator', coordinatorTitle);
    return this.getProject(id)!;
  }

  listProjects(): Project[] {
    return (
      this.db
        .prepare(
          `SELECT p.*, (SELECT t.id FROM threads t WHERE t.project_id = p.id AND t.kind = 'coordinator' LIMIT 1) AS coordinator_thread_id
           FROM projects p ORDER BY p.created_at`,
        )
        .all() as {
        id: string;
        name: string;
        workspace_path: string;
        repo_url: string | null;
        base_branch: string | null;
        coordinator_thread_id: string | null;
        created_at: string;
      }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      workspacePath: r.workspace_path,
      repoUrl: r.repo_url,
      baseBranch: r.base_branch,
      coordinatorThreadId: r.coordinator_thread_id ?? '',
      createdAt: r.created_at,
    }));
  }

  getProject(id: string): Project | undefined {
    return this.listProjects().find((p) => p.id === id);
  }

  createThread(projectId: string, kind: Thread['kind'], title: string, origin: Thread['origin'] = 'user'): Thread {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO threads (id, project_id, kind, origin, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`,
      )
      .run(id, projectId, kind, origin, title, ts, ts);
    return this.getThread(id)!;
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as unknown as ThreadRow | undefined;
    return row && toThread(row);
  }

  /** Projects created before project chats existed have no coordinator row yet. */
  projectsWithoutCoordinator(): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM projects p WHERE NOT EXISTS (SELECT 1 FROM threads t WHERE t.project_id = p.id AND t.kind = 'coordinator')`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
  }

  listThreads(projectId: string): Thread[] {
    return (
      this.db.prepare('SELECT * FROM threads WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as ThreadRow[]
    ).map(toThread);
  }

  threadsWithStatus(statuses: ThreadStatus[]): Thread[] {
    const marks = statuses.map(() => '?').join(', ');
    return (this.db.prepare(`SELECT * FROM threads WHERE status IN (${marks})`).all(...statuses) as unknown as ThreadRow[]).map(
      toThread,
    );
  }

  updateThread(
    id: string,
    patch: Partial<
      Pick<
        Thread,
        'status' | 'claudeSessionId' | 'lastMode' | 'contextTokens' | 'contextWindow' | 'autoCompactAt' | 'title' | 'nodeId' | 'worktreePath'
      > & { handoffFrom: string | null; handoffNote: string | null }
    >,
  ): Thread {
    const columns: Record<string, string> = {
      status: 'status',
      claudeSessionId: 'claude_session_id',
      lastMode: 'last_mode',
      contextTokens: 'context_tokens',
      contextWindow: 'context_window',
      autoCompactAt: 'auto_compact_at',
      title: 'title',
      nodeId: 'node_id',
      worktreePath: 'worktree_path',
      handoffFrom: 'handoff_from',
      handoffNote: 'handoff_note',
    };
    // undefined leaves a column alone; null clears it.
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    const sets = entries.map(([k]) => `${columns[k]} = ?`);
    this.db
      .prepare(`UPDATE threads SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`)
      .run(...(entries.map(([, v]) => v) as (string | number | null)[]), now(), id);
    return this.getThread(id)!;
  }

  /** Where a thread was handed off from, and what its next run should be told, until a run starts elsewhere. */
  handoffOf(threadId: string): { from: string | null; note: string | null } {
    const row = this.db.prepare('SELECT handoff_from, handoff_note FROM threads WHERE id = ?').get(threadId) as
      | { handoff_from: string | null; handoff_note: string | null }
      | undefined;
    return { from: row?.handoff_from ?? null, note: row?.handoff_note ?? null };
  }

  threadsOnNode(nodeId: string): Thread[] {
    return (this.db.prepare('SELECT * FROM threads WHERE node_id = ? ORDER BY created_at').all(nodeId) as unknown as ThreadRow[]).map(
      toThread,
    );
  }

  addMessage(m: Omit<Message, 'id' | 'createdAt'>): Message {
    const createdAt = now();
    const { lastInsertRowid } = this.db
      .prepare(
        'INSERT INTO messages (thread_id, run_id, author, kind, text, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(m.threadId, m.runId, m.author, m.kind, m.text, m.meta ? JSON.stringify(m.meta) : null, createdAt);
    return { ...m, id: Number(lastInsertRowid), createdAt };
  }

  listMessages(threadId: string): Message[] {
    return (
      this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id').all(threadId) as unknown as MessageRow[]
    ).map(toMessage);
  }

  startRun(threadId: string, mode: RunnerMode): Run {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO runs (thread_id, mode, started_at) VALUES (?, ?, ?)')
      .run(threadId, mode, now());
    return this.getRun(Number(lastInsertRowid))!;
  }

  getRun(id: number): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
    return row && toRun(row);
  }

  listRuns(threadId: string): Run[] {
    return (this.db.prepare('SELECT * FROM runs WHERE thread_id = ? ORDER BY id').all(threadId) as unknown as RunRow[]).map(toRun);
  }

  endRun(
    id: number,
    result: { ok: boolean; inputTokens: number; outputTokens: number; costUsdEstimate?: number; notionalCostUsd?: number },
  ): Run {
    this.db
      .prepare(
        `UPDATE runs SET ended_at = ?, ok = ?, input_tokens = ?, output_tokens = ?, cost_usd_estimate = ?, notional_cost_usd = ?
         WHERE id = ?`,
      )
      .run(
        now(),
        result.ok ? 1 : 0,
        result.inputTokens,
        result.outputTokens,
        result.costUsdEstimate ?? null,
        result.notionalCostUsd ?? null,
        id,
      );
    return this.getRun(id)!;
  }

  /** Runs a crash or restart left open. */
  closeOpenRuns(): void {
    this.db.prepare('UPDATE runs SET ended_at = ?, ok = 0 WHERE ended_at IS NULL').run(now());
  }

  addRunEvent(runId: number, seq: number, type: string, payload: unknown): void {
    this.db
      .prepare('INSERT INTO run_events (run_id, seq, type, payload_json) VALUES (?, ?, ?, ?)')
      .run(runId, seq, type, JSON.stringify(payload));
  }

  listRunEvents(runId: number): { seq: number; type: string; payload: unknown }[] {
    return (
      this.db.prepare('SELECT seq, type, payload_json FROM run_events WHERE run_id = ? ORDER BY seq').all(runId) as {
        seq: number;
        type: string;
        payload_json: string;
      }[]
    ).map((r) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload_json) }));
  }

  enqueueInput(threadId: string, text: string): void {
    this.db.prepare('INSERT INTO queued_inputs (thread_id, text, created_at) VALUES (?, ?, ?)').run(threadId, text, now());
  }

  /** Removes and returns a thread's queued inputs, oldest first. */
  takeQueuedInputs(threadId: string): string[] {
    const rows = this.db.prepare('SELECT text FROM queued_inputs WHERE thread_id = ? ORDER BY id').all(threadId) as { text: string }[];
    this.db.prepare('DELETE FROM queued_inputs WHERE thread_id = ?').run(threadId);
    return rows.map((r) => r.text);
  }

  hasQueuedInput(threadId: string): boolean {
    return this.db.prepare('SELECT 1 FROM queued_inputs WHERE thread_id = ? LIMIT 1').get(threadId) !== undefined;
  }

  /** The newest messages of the given kinds, oldest first. */
  recentMessages(threadId: string, kinds: MessageKind[], limit: number): Message[] {
    const marks = kinds.map(() => '?').join(', ');
    return (
      this.db
        .prepare(`SELECT * FROM messages WHERE thread_id = ? AND kind IN (${marks}) ORDER BY id DESC LIMIT ?`)
        .all(threadId, ...kinds, limit) as unknown as MessageRow[]
    )
      .map(toMessage)
      .reverse();
  }

  /** Threads with queued input, in the order their oldest input arrived. */
  threadsWithQueuedInput(): string[] {
    return (
      this.db.prepare('SELECT thread_id FROM queued_inputs GROUP BY thread_id ORDER BY MIN(id)').all() as { thread_id: string }[]
    ).map((r) => r.thread_id);
  }

  addPlanReading(runId: number | null, usage: { fiveHour?: UsageWindow; sevenDay?: UsageWindow }, observedAt = now()): void {
    this.db
      .prepare(
        `INSERT INTO plan_readings (observed_at, run_id, five_hour, five_hour_resets, seven_day, seven_day_resets)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        observedAt,
        runId,
        usage.fiveHour?.utilization ?? null,
        usage.fiveHour?.resetsAt ?? null,
        usage.sevenDay?.utilization ?? null,
        usage.sevenDay?.resetsAt ?? null,
      );
  }

  planReadingsSince(since: string): PlanReading[] {
    return (
      this.db.prepare('SELECT * FROM plan_readings WHERE observed_at >= ? ORDER BY observed_at, id').all(since) as {
        observed_at: string;
        five_hour: number | null;
        five_hour_resets: string | null;
        seven_day: number | null;
        seven_day_resets: string | null;
      }[]
    ).map((r) => ({
      at: r.observed_at,
      fiveHour: r.five_hour === null ? undefined : { utilization: r.five_hour, resetsAt: r.five_hour_resets ?? undefined },
      sevenDay: r.seven_day === null ? undefined : { utilization: r.seven_day, resetsAt: r.seven_day_resets ?? undefined },
    }));
  }

  /** Finished Subscription runs since a time, with what they'd have cost at API prices. */
  subscriptionRunsSince(since: string): RunWeight[] {
    return (
      this.db
        .prepare(
          `SELECT r.id, r.thread_id, t.project_id, r.ended_at, r.notional_cost_usd FROM runs r JOIN threads t ON t.id = r.thread_id
           WHERE r.mode = 'subscription' AND r.ended_at >= ? AND r.notional_cost_usd IS NOT NULL ORDER BY r.ended_at`,
        )
        .all(since) as { id: number; thread_id: string; project_id: string; ended_at: string; notional_cost_usd: number }[]
    ).map((r) => ({ runId: r.id, threadId: r.thread_id, projectId: r.project_id, endedAt: r.ended_at, usd: r.notional_cost_usd }));
  }

  apiSpendUsd(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd_estimate), 0) AS total FROM runs WHERE mode = 'api'")
      .get() as { total: number };
    return row.total;
  }

  // ---- Nodes (M5) ----

  listNodes(): NodeRow[] {
    return this.db.prepare('SELECT * FROM nodes ORDER BY is_local DESC, created_at').all() as unknown as NodeRow[];
  }

  getNode(id: string): NodeRow | undefined {
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as unknown as NodeRow | undefined;
  }

  nodeByTokenHash(hash: string): NodeRow | undefined {
    return this.db.prepare('SELECT * FROM nodes WHERE token_hash = ?').get(hash) as unknown as NodeRow | undefined;
  }

  createNode(n: { name: string; local: boolean; tokenHash: string | null; threadLimit: number }): NodeRow {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO nodes (id, name, is_local, token_hash, thread_limit, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, n.name, n.local ? 1 : 0, n.tokenHash, n.threadLimit, now());
    return this.getNode(id)!;
  }

  updateNode(
    id: string,
    patch: Partial<{ name: string; state: string; thread_limit: number; last_seen_at: string; resources_json: string; info_json: string }>,
  ): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    this.db
      .prepare(`UPDATE nodes SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...(entries.map(([, v]) => v) as (string | number)[]), id);
  }

  deleteNode(id: string): void {
    this.db.prepare('UPDATE threads SET node_id = NULL WHERE node_id = ?').run(id);
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  }

  // ---- Secrets (M5): ciphertext only; see secrets.ts ----

  getSecretRow(name: string): SecretRow | undefined {
    return this.db.prepare('SELECT * FROM secrets WHERE name = ?').get(name) as unknown as SecretRow | undefined;
  }

  listSecretRows(): SecretRow[] {
    return this.db.prepare('SELECT * FROM secrets').all() as unknown as SecretRow[];
  }

  putSecretRow(row: Omit<SecretRow, 'updated_at'>): void {
    this.db
      .prepare(
        `INSERT INTO secrets (name, iv, tag, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      )
      .run(row.name, row.iv, row.tag, row.ciphertext, now());
  }

  deleteSecretRow(name: string): void {
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }

  // ---- Login sessions for remote access (M5) ----

  addAuthSession(tokenHash: string, expiresAt: string): void {
    this.db.prepare('INSERT INTO auth_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(tokenHash, now(), expiresAt);
  }

  authSessionValid(tokenHash: string): boolean {
    return this.db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, now()) !== undefined;
  }

  deleteAuthSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteAllAuthSessions(): void {
    this.db.prepare('DELETE FROM auth_sessions').run();
  }
}

export interface NodeRow {
  id: string;
  name: string;
  is_local: number;
  token_hash: string | null;
  state: NodeState;
  thread_limit: number;
  last_seen_at: string | null;
  resources_json: string | null;
  info_json: string | null;
  created_at: string;
}

export interface SecretRow {
  name: string;
  iv: string;
  tag: string;
  ciphertext: string;
  updated_at: string;
}
