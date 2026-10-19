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

export interface UsageWindow {
  /** 0 to 1. */
  utilization: number;
  resetsAt?: string;
}

/** The Claude plan's account-wide usage as the CLI last reported it (undocumented signal; may be absent). */
export interface PlanUsage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  status?: string;
  observedAt: string;
}

export interface RuntimeState {
  /** Null until the user picks a mode, when neither config.json nor CCF_MODE sets a default. */
  mode: RunnerMode | null;
  health: Record<RunnerMode, RunnerHealth>;
  activeRuns: number;
  concurrency: number;
  /** Estimated spend of all API-mode runs so far. */
  spendUsdEstimate: number;
  /** True when ANTHROPIC_API_KEY is set but Subscription mode is active, so the key is ignored for runs. */
  apiKeyIgnored: boolean;
  /** Latest measured plan usage from Subscription-mode runs; null until one has reported it. */
  planUsage: PlanUsage | null;
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


// ---- Projects, threads and runs (M1) ----

/**
 * Thread lifecycle. Allowed moves live in server/src/threadState.ts.
 * awaiting_permission is what the user most needs to see: a tool call is parked on their answer.
 */
export type ThreadStatus = 'idle' | 'running' | 'awaiting_permission' | 'interrupted' | 'failed';

export interface Project {
  id: string;
  name: string;
  workspacePath: string;
  createdAt: string;
}

export interface Thread {
  id: string;
  projectId: string;
  kind: 'coordinator' | 'thread';
  title: string;
  status: ThreadStatus;
  claudeSessionId: string | null;
  /** Mode of the thread's most recent run; a send in another mode asks once before continuing. */
  lastMode: RunnerMode | null;
  /** Context size reported by the latest assistant turn. */
  contextTokens: number | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageKind = 'text' | 'tool_use' | 'tool_result' | 'compacted' | 'error' | 'run_started' | 'run_ended';

export interface Message {
  id: number;
  threadId: string;
  runId: number | null;
  author: 'user' | 'assistant' | 'system';
  kind: MessageKind;
  text: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface Run {
  id: number;
  threadId: string;
  mode: RunnerMode;
  startedAt: string;
  endedAt: string | null;
  ok: boolean | null;
  inputTokens: number;
  outputTokens: number;
  costUsdEstimate: number | null;
}

/** A tool call parked until the user allows or denies it. */
export interface PendingApproval {
  id: string;
  threadId: string;
  runId: number;
  toolName: string;
  input: Record<string, unknown>;
  decisionReason?: string;
  /** True when Claude Code offered a rule that would stop it asking again this session. */
  canAlwaysAllow: boolean;
  createdAt: string;
}

export interface ApprovalDecision {
  behavior: 'allow' | 'deny';
  /** Allow, and apply Claude Code's suggested rule so it stops asking for this session. */
  always?: boolean;
  message?: string;
}

export interface ThreadDetail {
  thread: Thread;
  project: Project;
  messages: Message[];
  runs: Run[];
  approvals: PendingApproval[];
  /** Command that opens this thread's session in the user's own terminal. */
  resumeCommand: string | null;
}

export interface PostMessageBody {
  text: string;
  /** Confirms continuing a thread whose last run used the other mode. */
  continueInMode?: RunnerMode;
}

export interface ModeChangedError {
  error: 'mode_changed';
  lastMode: RunnerMode;
  mode: RunnerMode;
}

/** Messages pushed over WS /api/events. */
export type ServerEvent =
  | { type: 'runtime'; state: RuntimeState }
  | { type: 'thread'; thread: Thread }
  | { type: 'message'; message: Message }
  | { type: 'approval_requested'; approval: PendingApproval }
  | { type: 'approval_resolved'; id: string; threadId: string; behavior: 'allow' | 'deny' };
