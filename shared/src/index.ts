// Types shared by the server and the web UI. Type-only: nothing here exists at runtime.

export type RunnerMode = 'api' | 'subscription';

export interface RunnerHealth {
  mode: RunnerMode;
  ok: boolean;
  /** Why the runner can't be used, when ok is false. */
  reason?: string;
  /** Where the credential comes from, e.g. "ANTHROPIC_API_KEY (environment)" or "claude CLI login (claude.ai)". */
  credentialSource?: string;
  /** Agent SDK version (API mode) or claude CLI version (Subscription mode). */
  version?: string;
  checkedAt: string;
}

export interface RuntimeState {
  /** Null until the user picks a mode, when neither config.json nor CCF_MODE sets a default. */
  mode: RunnerMode | null;
  health: Record<RunnerMode, RunnerHealth>;
  activeRuns: number;
  concurrency: number;
  /** Estimated spend of API-mode runs. Always 0 until runs exist (M1). */
  spendUsdEstimate: number;
  /** True when ANTHROPIC_API_KEY is set but Subscription mode is active, so the key is ignored for runs. */
  apiKeyIgnored: boolean;
}

export interface RuntimeUpdate {
  mode?: RunnerMode;
  concurrency?: number;
}

export interface RuntimeError {
  error: string;
  reason?: string;
  health?: RunnerHealth;
}

/** Messages pushed over WS /api/events. */
export type ServerEvent = { type: 'runtime'; state: RuntimeState };
