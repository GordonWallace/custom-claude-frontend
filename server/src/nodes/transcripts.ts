import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where Claude Code keeps a session's transcript: <config dir>/projects/<cwd with every character
 * that isn't a letter or digit replaced by "-">/<session id>.jsonl. Resuming a session in another
 * folder or on another machine works once the transcript is at that folder's path.
 */
export function transcriptPath(cwd: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Bytes from `offset` up to the last complete line, so an upload never splits a line (or a character). */
export function readFrom(file: string, offset: number): string {
  const size = fileSize(file);
  if (size <= offset) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const end = buf.lastIndexOf(0x0a);
    return end < 0 ? '' : buf.subarray(0, end + 1).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** The orchestrator's copy of each thread's transcripts: <dir>/<thread id>/<session id>.jsonl. */
export class TranscriptStore {
  constructor(private readonly dir: string) {}

  private file(threadId: string, sessionId: string): string {
    if (!/^[\w-]+$/.test(threadId) || !/^[\w-]+$/.test(sessionId)) throw new Error('Bad transcript id.');
    return path.join(this.dir, threadId, `${sessionId}.jsonl`);
  }

  size(threadId: string, sessionId: string | null): number {
    return sessionId ? fileSize(this.file(threadId, sessionId)) : 0;
  }

  read(threadId: string, sessionId: string): string | null {
    try {
      return fs.readFileSync(this.file(threadId, sessionId), 'utf8');
    } catch {
      return null;
    }
  }

  /** Writes an upload at its offset. Returns the size the orchestrator holds when the offset leaves a gap, so the node can resend. */
  write(threadId: string, sessionId: string, offset: number, data: string): { ok: true } | { ok: false; size: number } {
    const file = this.file(threadId, sessionId);
    const size = fileSize(file);
    if (offset > size) return { ok: false, size };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (offset < size) fs.truncateSync(file, offset);
    fs.appendFileSync(file, data);
    return { ok: true };
  }
}
