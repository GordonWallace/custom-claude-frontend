import type { ThreadStatus } from '@ccf/shared';

/**
 * The thread state machine. Every status change goes through `assertTransition`, so an
 * impossible move (say, idle straight to awaiting_permission) is a bug that fails loudly.
 */
const allowed: Record<ThreadStatus, readonly ThreadStatus[]> = {
  idle: ['queued', 'running'],
  // A queued thread starts when a slot frees up; stopping it drops its queued input.
  queued: ['running', 'idle', 'failed'],
  // A run that ends with input still queued for its thread goes straight back to queued.
  running: ['awaiting_permission', 'idle', 'queued', 'failed', 'interrupted'],
  awaiting_permission: ['running', 'idle', 'queued', 'failed', 'interrupted'],
  interrupted: ['queued', 'running'],
  failed: ['queued', 'running'],
};

export function canTransition(from: ThreadStatus, to: ThreadStatus): boolean {
  return from === to || allowed[from].includes(to);
}

export function assertTransition(from: ThreadStatus, to: ThreadStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid thread status change: ${from} -> ${to}`);
}

export const isBusy = (status: ThreadStatus) => status === 'running' || status === 'awaiting_permission';
