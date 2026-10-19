import type { RuntimeState } from '@ccf/shared';
import { MODE_LABEL } from '../api';

/** Always-visible statement of which bill a new message lands on. */
export function ModeBadge({ state, onClick }: { state: RuntimeState | null; onClick: () => void }) {
  if (!state) return <span className="badge badge-unknown">Connecting…</span>;

  const { mode } = state;
  const active = mode ? state.health[mode] : undefined;
  return (
    <div className="badge-row">
      <button
        type="button"
        className={`badge badge-${mode ?? 'unset'}`}
        onClick={onClick}
        title="Change runner mode"
        data-testid="mode-badge"
      >
        <span className="badge-dot" aria-hidden />
        {mode ? MODE_LABEL[mode] : 'No mode chosen'}
        {mode === 'api' && <span className="badge-spend">${state.spendUsdEstimate.toFixed(2)} est.</span>}
      </button>
      {active && !active.ok && (
        <span className="chip chip-error" title={active.reason}>
          Not ready: {active.reason}
        </span>
      )}
      {state.apiKeyIgnored && (
        <span className="chip chip-warn" title="Subscription mode strips ANTHROPIC_API_KEY from every claude run.">
          ANTHROPIC_API_KEY is set but ignored for runs
        </span>
      )}
    </div>
  );
}
