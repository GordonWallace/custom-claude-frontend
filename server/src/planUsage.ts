import type { PlanCalibration, PlanShare, ProjectUsage, UsageWindow } from '@ccf/shared';

/**
 * Estimates each thread's and project's share of the plan's usage windows.
 *
 * The CLI reports the account's real utilization (see mapSdkMessage), but parallel threads share one
 * meter, so per-thread figures must be estimated. Each Subscription run is weighed by its API-price
 * value (the SDK's notional total_cost_usd), and this account's own history says how many percentage
 * points a notional dollar moves the meter. Usage from other clients (claude.ai, the desktop app)
 * moves the meter too; it shows up as unattributed rather than being charged to app threads.
 */

export interface PlanReading {
  at: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
}

export interface RunWeight {
  runId: number;
  threadId: string;
  projectId: string;
  endedAt: string;
  usd: number;
}

export type WindowKey = 'fiveHour' | 'sevenDay';

const WINDOW_MS: Record<WindowKey, number> = { fiveHour: 5 * 3600_000, sevenDay: 7 * 86400_000 };

/** How far back calibration looks; long enough to span a few weekly windows' worth of readings. */
export const CALIBRATION_MS = 14 * 86400_000;

/**
 * Learns percentage points per notional dollar from consecutive readings in the same window: each
 * rise in the meter is set against the runs that ended between the two readings. A rise with no app
 * run in it is someone else's usage.
 */
export function calibrate(readings: PlanReading[], runs: RunWeight[], key: WindowKey): PlanCalibration {
  const current = readings.at(-1)?.[key]?.resetsAt;
  let pct = 0;
  let usd = 0;
  let samples = 0;
  let unattributedPct = 0;

  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1][key];
    const b = readings[i][key];
    // A different reset time means the window rolled over between the readings.
    if (!a || !b || a.resetsAt !== b.resetsAt) continue;
    const delta = (b.utilization - a.utilization) * 100;
    if (delta < 0) continue;
    const from = readings[i - 1].at;
    const to = readings[i].at;
    const spent = runs.filter((r) => r.endedAt > from && r.endedAt <= to).reduce((sum, r) => sum + r.usd, 0);
    if (spent > 0) {
      pct += delta;
      usd += spent;
      if (delta > 0) samples++;
    } else if (b.resetsAt === current) {
      unattributedPct += delta;
    }
  }

  return { pctPerUsd: usd > 0 && pct > 0 ? pct / usd : null, samples, unattributedPct };
}

/** When the window the latest reading belongs to started (or the window's length ago, without a reset time). */
export function windowStart(readings: PlanReading[], key: WindowKey, now: number): string {
  const resetsAt = readings.at(-1)?.[key]?.resetsAt;
  const end = resetsAt ? Date.parse(resetsAt) : now;
  return new Date(end - WINDOW_MS[key]).toISOString();
}

/** Estimated usage per thread and for one project in the current windows. */
export function projectUsage(readings: PlanReading[], runs: RunWeight[], projectId: string, now = Date.now()): ProjectUsage {
  const calibration = { fiveHour: calibrate(readings, runs, 'fiveHour'), sevenDay: calibrate(readings, runs, 'sevenDay') };
  const starts = { fiveHour: windowStart(readings, 'fiveHour', now), sevenDay: windowStart(readings, 'sevenDay', now) };
  const empty = (): PlanShare => ({ notionalUsd: 0, fiveHour: null, sevenDay: null });

  const project = empty();
  const threads: Record<string, PlanShare> = {};
  for (const run of runs) {
    if (run.projectId !== projectId) continue;
    const share = (threads[run.threadId] ??= empty());
    for (const target of [share, project]) {
      if (run.endedAt >= starts.sevenDay) target.notionalUsd += run.usd;
      for (const key of ['fiveHour', 'sevenDay'] as const) {
        const k = calibration[key].pctPerUsd;
        if (k !== null && run.endedAt >= starts[key]) target[key] = (target[key] ?? 0) + run.usd * k;
      }
    }
  }
  return { project, threads, calibration };
}
