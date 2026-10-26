import path from 'node:path';
import type { ThreadProgress } from '@ccf/shared';

interface Step {
  id: string;
  title: string;
  /** What Claude Code shows while the step runs, e.g. "Running tests". */
  active?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface State {
  runStartedAt: string | null;
  activity: string | null;
  steps: Step[];
  /** Ids TaskCreate has handed out in this session, which number from 1. */
  nextTaskId: number;
  typicalMs: number | null;
}

/**
 * What each thread is doing, from signals Claude Code actually sends: its to-do list (TodoWrite,
 * or TaskCreate and TaskUpdate), the tool it is running and when its run started. Kept in memory;
 * a restart loses only the live part, which the next run rebuilds.
 */
export class ProgressTracker {
  private readonly threads = new Map<string, State>();

  private state(threadId: string): State {
    let s = this.threads.get(threadId);
    if (!s) this.threads.set(threadId, (s = { runStartedAt: null, activity: null, steps: [], nextTaskId: 1, typicalMs: null }));
    return s;
  }

  runStarted(threadId: string, typicalMs: number | null): void {
    const s = this.state(threadId);
    s.runStartedAt = new Date().toISOString();
    s.activity = null;
    s.typicalMs = typicalMs;
    // A finished list is from earlier work; an unfinished one carries on in this run.
    if (s.steps.length > 0 && s.steps.every((t) => t.status === 'completed')) s.steps = [];
  }

  runEnded(threadId: string): void {
    const s = this.state(threadId);
    s.runStartedAt = null;
    s.activity = null;
  }

  /** Returns true when what the thread shows changed. */
  toolUse(threadId: string, name: string, input: unknown): boolean {
    const s = this.state(threadId);
    const args = (input ?? {}) as Record<string, unknown>;
    if (name === 'TodoWrite' && Array.isArray(args.todos)) {
      s.steps = (args.todos as Record<string, unknown>[]).map((t, i) => ({
        id: String(i),
        title: String(t.content ?? ''),
        active: typeof t.activeForm === 'string' ? t.activeForm : undefined,
        status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
      }));
      return true;
    }
    if (name === 'TaskCreate') {
      s.steps.push({
        id: String(s.nextTaskId++),
        title: String(args.subject ?? args.description ?? ''),
        active: typeof args.activeForm === 'string' ? args.activeForm : undefined,
        status: 'pending',
      });
      return true;
    }
    if (name === 'TaskUpdate') {
      const step = s.steps.find((t) => t.id === String(args.taskId));
      if (!step) return false;
      if (args.status === 'deleted') s.steps = s.steps.filter((t) => t !== step);
      else if (args.status === 'completed' || args.status === 'in_progress' || args.status === 'pending') step.status = args.status;
      if (typeof args.subject === 'string') step.title = args.subject;
      if (typeof args.activeForm === 'string') step.active = args.activeForm;
      return true;
    }
    const activity = describeTool(name, args);
    if (activity === null || activity === s.activity) return false;
    s.activity = activity;
    return true;
  }

  view(threadId: string): ThreadProgress | undefined {
    const s = this.threads.get(threadId);
    if (!s || (!s.runStartedAt && s.steps.length === 0)) return undefined;
    const current = s.steps.find((t) => t.status === 'in_progress');
    const done = s.steps.filter((t) => t.status === 'completed').length;
    return {
      runStartedAt: s.runStartedAt,
      activity: s.activity,
      step:
        s.steps.length > 0
          ? { number: Math.min(done + (current ? 1 : 0), s.steps.length) || 1, total: s.steps.length, title: current ? (current.active ?? current.title) : null }
          : null,
      typicalMs: s.typicalMs,
    };
  }
}

/** A few words on what a tool call is doing, or null for calls the user doesn't need to see. */
export function describeTool(name: string, input: Record<string, unknown>): string | null {
  const file = typeof input.file_path === 'string' ? path.basename(input.file_path) : null;
  switch (name) {
    case 'Bash':
      return typeof input.description === 'string' && input.description.trim() ? input.description.trim() : 'Running a command';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return file ? `Editing ${file}` : 'Editing files';
    case 'Read':
      return file ? `Reading ${file}` : 'Reading files';
    case 'Grep':
    case 'Glob':
      return 'Searching the code';
    case 'WebFetch':
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent':
      return 'Running a subagent';
    case 'ToolSearch':
    case 'TodoRead':
    case 'TaskList':
    case 'TaskGet':
      return null;
    default:
      return name.startsWith('mcp__app__') ? null : `Using ${name.replace(/^mcp__[^_]+__/, '')}`;
  }
}

/** The middle of a list of run lengths, or null with too few to mean anything. */
export function typicalDuration(durationsMs: number[], minimum = 2): number | null {
  if (durationsMs.length < minimum) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
