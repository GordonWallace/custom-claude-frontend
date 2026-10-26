import { useEffect, useState } from 'react';
import type { Thread } from '@ccf/shared';

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Re-renders every few seconds while active, so elapsed times keep up. */
function useTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, [active]);
}

/**
 * One line on what a busy thread is doing: its step in Claude Code's to-do list or the tool it is
 * running, how long the run has gone, and how long its runs usually take. Nothing when idle.
 */
export function ProgressLine({ thread }: { thread: Thread }) {
  const running = thread.status === 'running';
  useTick(running);
  if (thread.status === 'awaiting_permission') return <span className="progress-line needs-you">Needs you to approve a tool call</span>;
  if (thread.status === 'queued') return <span className="progress-line">Waiting for a free slot</span>;
  const p = thread.progress;
  if (!running || !p) return null;

  const parts: string[] = [];
  if (p.step) parts.push(`Step ${p.step.number} of ${p.step.total}${p.step.title ? `: ${p.step.title}` : ''}`);
  else if (p.activity) parts.push(p.activity);
  if (p.runStartedAt) {
    const elapsed = formatDuration(Date.now() - Date.parse(p.runStartedAt));
    parts.push(p.typicalMs ? `${elapsed} (usually ~${formatDuration(p.typicalMs)})` : elapsed);
  }
  const title = [
    parts.join(' · '),
    p.step && p.activity ? `Now: ${p.activity}` : null,
    p.typicalMs ? "The usual time is the middle of this thread's past runs (or the project's), not a prediction." : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className="progress-line" title={title || undefined} data-testid="progress-line">
      {parts.join(' · ')}
    </span>
  );
}
