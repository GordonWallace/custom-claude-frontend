import type { ThreadStatus } from '@ccf/shared';

/**
 * The thread state machine. Every status change goes through `assertTransition`, so an
 * impossible move (say, idle straight to awaiting_permission) is a bug that fails loudly.
 */
const allowed: Record<ThreadStatus, readonly ThreadStatus[]> = {
  idle: ['running'],
  running: ['awaiting_permission', 'idle', 'failed', 'interrupted'],
  awaiting_permission: ['running', 'idle', 'failed', 'interrupted'],
  interrupted: ['running'],
  failed: ['running'],
};

export function canTransition(from: ThreadStatus, to: ThreadStatus): boolean {
  return from === to || allowed[from].includes(to);
}

export function assertTransition(from: ThreadStatus, to: ThreadStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid thread status change: ${from} -> ${to}`);
}

export const isBusy = (status: ThreadStatus) => status === 'running' || status === 'awaiting_permission';
