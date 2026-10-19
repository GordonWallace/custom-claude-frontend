import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const migrations: string[] = [
  `CREATE TABLE settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

/** Opens the SQLite file (or ':memory:') and applies any migrations it hasn't seen. */
export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
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
