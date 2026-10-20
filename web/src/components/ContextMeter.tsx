import type { Thread } from '@ccf/shared';

/** How full the session's context window is, with a tick where Claude Code compacts automatically. */
export function ContextMeter({ thread }: { thread: Thread }) {
  const used = thread.contextTokens;
  if (used === null) return null;
  const max = thread.contextWindow;
  if (!max) return <span title="Context size of the latest turn">Context {formatTokens(used)} tokens</span>;

  const pct = Math.min(100, (used / max) * 100);
  const compactAt = thread.autoCompactAt;
  const near = compactAt ? used >= compactAt * 0.85 : pct >= 80;
  const title = [
    `${used.toLocaleString()} of ${max.toLocaleString()} tokens in context`,
    compactAt ? `Claude Code compacts automatically at about ${compactAt.toLocaleString()}` : null,
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <span className={`context-meter${near ? ' near' : ''}`} title={title} data-testid="context-meter">
      <span className="context-bar" aria-hidden>
        <span className="context-fill" style={{ width: `${pct}%` }} />
        {compactAt && <span className="context-tick" style={{ left: `${Math.min(100, (compactAt / max) * 100)}%` }} />}
      </span>
      Context {formatTokens(used)} / {formatTokens(max)}
      {near && ' · compacts soon'}
    </span>
  );
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}
