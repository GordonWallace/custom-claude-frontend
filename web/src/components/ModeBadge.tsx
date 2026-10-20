import type { PlanUsage, RuntimeState } from '@ccf/shared';
import { MODE_LABEL } from '../api';

/** Always-visible statement of which bill a new message lands on. */
export function ModeBadge({ state, onClick }: { state: RuntimeState | null; onClick: () => void }) {
  if (!state) return <span className="badge badge-unknown">Connecting…</span>;

  const { mode } = state;
  const active = mode ? state.health[mode] : undefined;
  const overSpend = state.spendWarnUsd !== null && state.spendUsdEstimate >= state.spendWarnUsd;
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
        {mode === 'api' && (
          <span
            className={`badge-spend${overSpend ? ' badge-spend-over' : ''}`}
            title={overSpend ? `Estimated API spend is past the $${state.spendWarnUsd} warning set in config.json (spendWarnUsd).` : 'Estimated API spend of every API-mode run so far.'}
          >
            ${state.spendUsdEstimate.toFixed(2)} est.
          </span>
        )}
        {mode === 'subscription' && state.planUsage && <PlanUsageText usage={state.planUsage} />}
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

/** Measured account-wide plan usage, as the CLI last reported it. */
function PlanUsageText({ usage }: { usage: PlanUsage }) {
  const pct = (u?: { utilization: number }) => (u ? `${Math.round(u.utilization * 100)}%` : '?');
  const resets = (label: string, w?: { resetsAt?: string }) =>
    w?.resetsAt ? `${label} resets ${new Date(w.resetsAt).toLocaleString()}` : '';
  const title = [
    'Plan usage reported by the claude CLI on its last run (all clients on your account count).',
    resets('5-hour window', usage.fiveHour),
    resets('Weekly window', usage.sevenDay),
    `Reported ${new Date(usage.observedAt).toLocaleString()}`,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className="badge-spend" title={title} data-testid="plan-usage">
      {pct(usage.fiveHour)} of 5h · {pct(usage.sevenDay)} of week
    </span>
  );
}
