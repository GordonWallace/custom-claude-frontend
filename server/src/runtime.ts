import type { ApprovalPolicy, PlanUsage, RunnerHealth, RunnerMode, RuntimeState } from '@ccf/shared';
import { isRunnerMode } from './config.js';
import { HttpError } from './errors.js';
import type { Settings } from './db.js';
import type { EventBus } from './events.js';
import type { SessionRunner } from './runners/types.js';

const HEALTH_TTL_MS = 15_000;

export class RuntimeError extends HttpError {
  constructor(statusCode: number, message: string, reason?: string, health?: RunnerHealth) {
    super(statusCode, message, { reason, health });
  }
}

export interface RuntimeLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Owns the active runner mode. A mode stored in settings (chosen through the API or UI) wins over
 * the configured default; with neither, the mode is null and the UI asks on first launch.
 * A switch applies to new runs only.
 */
export class RuntimeService {
  private readonly healthCache = new Map<RunnerMode, RunnerHealth>();
  private activeRuns = 0;

  constructor(
    private readonly runners: Record<RunnerMode, SessionRunner>,
    private readonly settings: Settings,
    private readonly bus: EventBus,
    private readonly defaults: { mode: RunnerMode | null; concurrency: number; spendWarnUsd?: number | null; approvals?: ApprovalPolicy },
    private readonly env: NodeJS.ProcessEnv,
    private readonly log: RuntimeLogger,
    private readonly apiSpend: () => number = () => 0,
  ) {}

  get mode(): RunnerMode | null {
    const stored = this.settings.get('runtime.mode');
    return isRunnerMode(stored) ? stored : this.defaults.mode;
  }

  get concurrency(): number {
    const stored = Number(this.settings.get('runtime.concurrency'));
    return Number.isInteger(stored) && stored > 0 ? stored : this.defaults.concurrency;
  }

  get approvals(): ApprovalPolicy {
    const stored = this.settings.get('runtime.approvals');
    return isApprovalPolicy(stored) ? stored : (this.defaults.approvals ?? 'ask');
  }

  async setApprovals(policy: ApprovalPolicy): Promise<RuntimeState> {
    if (!isApprovalPolicy(policy)) throw new RuntimeError(400, 'approvals must be "ask", "auto" or "all".');
    this.settings.set('runtime.approvals', policy);
    this.log.info(`Tool approvals set to ${policy}`);
    return this.publish();
  }

  /** The runner new runs should use. Throws 409 if no mode is chosen or its runner isn't usable. */
  async activeRunner(): Promise<SessionRunner> {
    const mode = this.mode;
    if (!mode) throw new RuntimeError(409, 'Choose a runner mode first.');
    const health = await this.health(mode);
    if (!health.ok) throw new RuntimeError(409, `${modeLabel(mode)} isn't ready.`, health.reason, health);
    return this.runners[mode];
  }

  /** Counts a run in flight; call the returned function once when it ends. */
  trackRun(): () => void {
    this.activeRuns++;
    void this.publish();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.activeRuns--;
      void this.publish();
    };
  }

  async health(mode: RunnerMode, refresh = false): Promise<RunnerHealth> {
    const cached = this.healthCache.get(mode);
    if (!refresh && cached && Date.now() - Date.parse(cached.checkedAt) < HEALTH_TTL_MS) return cached;
    const health = await this.runners[mode].health();
    this.healthCache.set(mode, health);
    return health;
  }

  /** The last health check of a mode, without checking again. */
  cachedHealth(mode: RunnerMode): RunnerHealth | undefined {
    return this.healthCache.get(mode);
  }

  async state(refresh = false): Promise<RuntimeState> {
    const [api, subscription] = await Promise.all([this.health('api', refresh), this.health('subscription', refresh)]);
    const mode = this.mode;
    return {
      mode,
      health: { api, subscription },
      activeRuns: this.activeRuns,
      concurrency: this.concurrency,
      spendUsdEstimate: this.apiSpend(),
      spendWarnUsd: this.defaults.spendWarnUsd ?? null,
      approvals: this.approvals,
      apiKeyIgnored: mode === 'subscription' && Boolean(this.env.ANTHROPIC_API_KEY?.trim()),
      planUsage: this.planUsage(),
    };
  }

  /** Switches mode after a fresh health check of the target runner; refuses with 409 if it fails. */
  async setMode(mode: RunnerMode): Promise<RuntimeState> {
    const health = await this.health(mode, true);
    if (!health.ok) {
      throw new RuntimeError(409, `Can't switch to ${modeLabel(mode)}.`, health.reason, health);
    }
    const previous = this.mode;
    this.settings.set('runtime.mode', mode);
    this.log.info(`Runner mode ${previous ?? 'unset'} -> ${mode}; credential: ${health.credentialSource}`);
    return this.publish();
  }

  async setConcurrency(concurrency: number): Promise<RuntimeState> {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new RuntimeError(400, 'concurrency must be a whole number from 1 to 32.');
    }
    this.settings.set('runtime.concurrency', String(concurrency));
    this.log.info(`Concurrency cap set to ${concurrency}`);
    return this.publish();
  }

  planUsage(): PlanUsage | null {
    const stored = this.settings.get('plan.usage');
    return stored ? (JSON.parse(stored) as PlanUsage) : null;
  }

  /** Stores the plan usage a Subscription-mode run reported, keeping windows the report left out. */
  recordPlanUsage(update: Omit<PlanUsage, 'observedAt'>): void {
    const previous = this.planUsage();
    const usage: PlanUsage = {
      fiveHour: update.fiveHour ?? previous?.fiveHour,
      sevenDay: update.sevenDay ?? previous?.sevenDay,
      status: update.status,
      observedAt: new Date().toISOString(),
    };
    this.settings.set('plan.usage', JSON.stringify(usage));
    void this.publish();
  }

  /** Logs the mode and where its credential comes from; called once at startup. */
  async logStartup(): Promise<void> {
    const mode = this.mode;
    if (!mode) {
      this.log.warn('No runner mode set (config.json or CCF_MODE). The UI will ask on first launch.');
      return;
    }
    const health = await this.health(mode, true);
    if (health.ok) {
      this.log.info(`Runner mode: ${mode}; credential: ${health.credentialSource}`);
    } else {
      this.log.warn(`Runner mode: ${mode}, but it is not usable: ${health.reason}`);
    }
    if (mode === 'subscription' && this.env.ANTHROPIC_API_KEY?.trim()) {
      this.log.warn('ANTHROPIC_API_KEY is set but ignored: Subscription mode strips it from every claude run.');
    }
  }

  /** Pushes the current state to every open view (after a mode switch, or when runs start or end). */
  async publish(): Promise<RuntimeState> {
    const state = await this.state();
    this.bus.publish({ type: 'runtime', state });
    return state;
  }
}

export function modeLabel(mode: RunnerMode): string {
  return mode === 'api' ? 'API mode' : 'Subscription mode';
}

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return value === 'ask' || value === 'auto' || value === 'all';
}
