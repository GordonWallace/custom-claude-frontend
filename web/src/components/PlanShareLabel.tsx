import type { PlanCalibration, PlanShare } from '@ccf/shared';

/**
 * A thread's or project's estimated share of the plan's usage windows. Estimated, not measured: the
 * CLI reports only the account total, which this splits by each run's API-price value.
 */
export function PlanShareLabel({
  share,
  calibration,
  scope,
}: {
  share?: PlanShare;
  calibration?: PlanCalibration;
  /** "project" labels the whole project's total rather than one thread's. */
  scope: 'project' | 'thread';
}) {
  const subject = scope === 'project' ? 'Project plan share' : 'Plan share';
  if (!share || share.notionalUsd === 0) return null;
  const how =
    'Estimated from the API-price value of this work and how far your plan meter has moved for past app runs. ' +
    'Your plan only reports an account-wide total.';
  if (share.sevenDay === null && share.fiveHour === null) {
    return (
      <span className="plan-share" title={how}>
        {subject}: calibrating (${share.notionalUsd.toFixed(2)} at API prices)
      </span>
    );
  }
  const parts = [
    share.sevenDay !== null ? `${formatPct(share.sevenDay)} of week` : null,
    share.fiveHour !== null ? `${formatPct(share.fiveHour)} of 5h` : null,
  ].filter(Boolean);
  const samples = calibration ? ` Based on ${calibration.samples} meter reading${calibration.samples === 1 ? '' : 's'} so far.` : '';
  return (
    <span className="plan-share" title={how + samples} data-testid="plan-share">
      {subject}: ≈ {parts.join(' · ')} (est.)
    </span>
  );
}

function formatPct(pct: number): string {
  return pct < 0.1 ? '<0.1%' : `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}
