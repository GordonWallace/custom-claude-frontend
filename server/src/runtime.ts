import type { RunnerHealth, RunnerMode, RuntimeState } from '@ccf/shared';
import { isRunnerMode } from './config.js';
import type { Settings } from './db.js';
import type { EventBus } from './events.js';
import type { SessionRunner } from './runners/types.js';

const HEALTH_TTL_MS = 15_000;

export class RuntimeError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly reason?: string,
    readonly health?: RunnerHealth,
  ) {
    super(message);
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
    private readonly defaults: { mode: RunnerMode | null; concurrency: number },
    private readonly env: NodeJS.ProcessEnv,
    private readonly log: RuntimeLogger,
  ) {}

  get mode(): RunnerMode | null {
    const stored = this.settings.get('runtime.mode');
    return isRunnerMode(stored) ? stored : this.defaults.mode;
  }

  get concurrency(): number {
    const stored = Number(this.settings.get('runtime.concurrency'));
    return Number.isInteger(stored) && stored > 0 ? stored : this.defaults.concurrency;
  }

  /** The runner new runs should use. Throws if no mode has been chosen yet. */
  activeRunner(): SessionRunner {
    const mode = this.mode;
    if (!mode) throw new RuntimeError(409, 'No runner mode has been chosen yet.');
    return this.runners[mode];
  }

  async health(mode: RunnerMode, refresh = false): Promise<RunnerHealth> {
    const cached = this.healthCache.get(mode);
    if (!refresh && cached && Date.now() - Date.parse(cached.checkedAt) < HEALTH_TTL_MS) return cached;
    const health = await this.runners[mode].health();
    this.healthCache.set(mode, health);
    return health;
  }

  async state(refresh = false): Promise<RuntimeState> {
    const [api, subscription] = await Promise.all([this.health('api', refresh), this.health('subscription', refresh)]);
    const mode = this.mode;
    return {
      mode,
      health: { api, subscription },
      activeRuns: this.activeRuns,
      concurrency: this.concurrency,
      spendUsdEstimate: 0,
      apiKeyIgnored: mode === 'subscription' && Boolean(this.env.ANTHROPIC_API_KEY?.trim()),
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

  private async publish(): Promise<RuntimeState> {
    const state = await this.state();
    this.bus.publish({ type: 'runtime', state });
    return state;
  }
}

export function modeLabel(mode: RunnerMode): string {
  return mode === 'api' ? 'API mode' : 'Subscription mode';
}
