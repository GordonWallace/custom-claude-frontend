import type { ThreadStatus } from '@ccf/shared';

const LABEL: Record<ThreadStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  awaiting_permission: 'Waiting on you',
  interrupted: 'Stopped',
  failed: 'Failed',
};

export function StatusPill({ status }: { status: ThreadStatus }) {
  return (
    <span className={`status status-${status}`} data-testid="thread-status">
      {status === 'running' && <span className="spinner" aria-hidden />}
      {LABEL[status]}
    </span>
  );
}
