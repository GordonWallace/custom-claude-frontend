import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const migrations: string[] = [
  `CREATE TABLE settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE projects (
     id             TEXT PRIMARY KEY,
     name           TEXT NOT NULL,
     workspace_path TEXT NOT NULL,
     created_at     TEXT NOT NULL
   );
   CREATE TABLE threads (
     id                TEXT PRIMARY KEY,
     project_id        TEXT NOT NULL REFERENCES projects(id),
     kind              TEXT NOT NULL CHECK (kind IN ('coordinator', 'thread')),
     title             TEXT NOT NULL,
     status            TEXT NOT NULL,
     claude_session_id TEXT,
     last_mode         TEXT,
     context_tokens    INTEGER,
     created_at        TEXT NOT NULL,
     updated_at        TEXT NOT NULL
   );
   CREATE TABLE runs (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     thread_id         TEXT NOT NULL REFERENCES threads(id),
     mode              TEXT NOT NULL,
     started_at        TEXT NOT NULL,
     ended_at          TEXT,
     ok                INTEGER,
     input_tokens      INTEGER NOT NULL DEFAULT 0,
     output_tokens     INTEGER NOT NULL DEFAULT 0,
     cost_usd_estimate REAL
   );
   CREATE TABLE messages (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     thread_id  TEXT NOT NULL REFERENCES threads(id),
     run_id     INTEGER REFERENCES runs(id),
     author     TEXT NOT NULL CHECK (author IN ('user', 'assistant', 'system')),
     kind       TEXT NOT NULL,
     text       TEXT NOT NULL,
     meta_json  TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX messages_thread ON messages (thread_id, id);
   CREATE TABLE run_events (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id       INTEGER NOT NULL REFERENCES runs(id),
     seq          INTEGER NOT NULL,
     type         TEXT NOT NULL,
     payload_json TEXT NOT NULL
   );
   CREATE INDEX run_events_run ON run_events (run_id, seq);`,
];

/** Opens the SQLite file (or ':memory:') and applies any migrations it hasn't seen. */
export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const { user_version: applied } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = applied; i < migrations.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

export class Settings {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
}
