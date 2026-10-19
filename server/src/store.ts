import { randomUUID } from 'node:crypto';
import type { Message, MessageKind, Project, Run, RunnerMode, Thread, ThreadStatus } from '@ccf/shared';
import type { Db } from './db.js';

interface ThreadRow {
  id: string;
  project_id: string;
  kind: Thread['kind'];
  title: string;
  status: ThreadStatus;
  claude_session_id: string | null;
  last_mode: RunnerMode | null;
  context_tokens: number | null;
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
  title: r.title,
  status: r.status,
  claudeSessionId: r.claude_session_id,
  lastMode: r.last_mode,
  contextTokens: r.context_tokens,
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

  createProject(name: string, workspacePath: string): Project {
    const project = { id: randomUUID(), name, workspacePath, createdAt: now() };
    this.db
      .prepare('INSERT INTO projects (id, name, workspace_path, created_at) VALUES (?, ?, ?, ?)')
      .run(project.id, name, workspacePath, project.createdAt);
    return project;
  }

  listProjects(): Project[] {
    return (
      this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as {
        id: string;
        name: string;
        workspace_path: string;
        created_at: string;
      }[]
    ).map((r) => ({ id: r.id, name: r.name, workspacePath: r.workspace_path, createdAt: r.created_at }));
  }

  getProject(id: string): Project | undefined {
    return this.listProjects().find((p) => p.id === id);
  }

  createThread(projectId: string, kind: Thread['kind'], title: string): Thread {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO threads (id, project_id, kind, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'idle', ?, ?)`,
      )
      .run(id, projectId, kind, title, ts, ts);
    return this.getThread(id)!;
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as unknown as ThreadRow | undefined;
    return row && toThread(row);
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
    patch: Partial<Pick<Thread, 'status' | 'claudeSessionId' | 'lastMode' | 'contextTokens' | 'title'>>,
  ): Thread {
    const columns: Record<string, string> = {
      status: 'status',
      claudeSessionId: 'claude_session_id',
      lastMode: 'last_mode',
      contextTokens: 'context_tokens',
      title: 'title',
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    const sets = entries.map(([k]) => `${columns[k]} = ?`);
    this.db
      .prepare(`UPDATE threads SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`)
      .run(...(entries.map(([, v]) => v) as (string | number | null)[]), now(), id);
    return this.getThread(id)!;
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

  endRun(id: number, result: { ok: boolean; inputTokens: number; outputTokens: number; costUsdEstimate?: number }): Run {
    this.db
      .prepare(
        'UPDATE runs SET ended_at = ?, ok = ?, input_tokens = ?, output_tokens = ?, cost_usd_estimate = ? WHERE id = ?',
      )
      .run(now(), result.ok ? 1 : 0, result.inputTokens, result.outputTokens, result.costUsdEstimate ?? null, id);
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

  apiSpendUsd(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd_estimate), 0) AS total FROM runs WHERE mode = 'api'")
      .get() as { total: number };
    return row.total;
  }
}
