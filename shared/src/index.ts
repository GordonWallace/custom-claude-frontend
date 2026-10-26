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

/**
 * How tool calls are approved: ask for every one, approve everything except risky shell commands
 * (recursive deletes, force pushes, sudo, piping downloads into a shell…), or approve everything.
 */
export type ApprovalPolicy = 'ask' | 'auto' | 'all';

/** How hard Claude thinks: off (no extended thinking) or an effort level. Null anywhere means "use the default". */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A model Claude Code offers, as its CLI reports them (or a short built-in list until a run has reported). */
export interface ModelOption {
  /** Alias or model id passed to Claude Code, such as "opus". */
  value: string;
  label: string;
  description?: string;
  /** Effort levels the model takes; absent when unknown. */
  efforts?: ThinkingLevel[];
}

/** Model and thinking for new runs; null leaves the choice to Claude Code. */
export interface SessionDefaults {
  model: string | null;
  thinking: ThinkingLevel | null;
}

export interface RuntimeState {
  /** Null until the user picks a mode, when neither config.json nor CCF_MODE sets a default. */
  mode: RunnerMode | null;
  health: Record<RunnerMode, RunnerHealth>;
  activeRuns: number;
  concurrency: number;
  /** Estimated spend of all API-mode runs so far. */
  spendUsdEstimate: number;
  /** Spend at which the header warns, from config (spendWarnUsd); null for no warning. */
  spendWarnUsd: number | null;
  /** True when ANTHROPIC_API_KEY is set but Subscription mode is active, so the key is ignored for runs. */
  apiKeyIgnored: boolean;
  approvals: ApprovalPolicy;
  /** Defaults for project chats (coordinator) and threads; each thread can override them. */
  sessionDefaults: { coordinator: SessionDefaults; thread: SessionDefaults };
  models: ModelOption[];
  /** Latest measured plan usage from Subscription-mode runs; null until one has reported it. */
  planUsage: PlanUsage | null;
}

export interface RuntimeUpdate {
  mode?: RunnerMode;
  concurrency?: number;
  approvals?: ApprovalPolicy;
  sessionDefaults?: { coordinator?: Partial<SessionDefaults>; thread?: Partial<SessionDefaults> };
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
 * queued means input is waiting for a free slot under the concurrency cap.
 */
export type ThreadStatus = 'idle' | 'queued' | 'running' | 'awaiting_permission' | 'interrupted' | 'failed';

export interface Project {
  id: string;
  name: string;
  workspacePath: string;
  /**
   * A git repo URL (M5). Threads of a repo project run on any node, each in its own worktree on
   * branch thread/<short id>; without one, threads run in workspacePath on the orchestrator's machine.
   */
  repoUrl: string | null;
  /** Branch new threads start from; the remote's default branch when null. */
  baseBranch: string | null;
  /** The thread that backs the project chat. */
  coordinatorThreadId: string;
  createdAt: string;
}

export interface Thread {
  id: string;
  projectId: string;
  kind: 'coordinator' | 'thread';
  /** Who opened the thread. The coordinator hears when threads it started finish a run. */
  origin: 'user' | 'coordinator';
  title: string;
  status: ThreadStatus;
  claudeSessionId: string | null;
  /** Mode of the thread's most recent run; a send in another mode asks once before continuing. */
  lastMode: RunnerMode | null;
  /** Context size reported by the latest assistant turn. */
  contextTokens: number | null;
  /** The model's context window, from the latest context report. */
  contextWindow: number | null;
  /** Context size at which Claude Code compacts automatically, when it reports one. */
  autoCompactAt: number | null;
  /** The node the thread runs on (M5). Threads stay on their node between runs until it is drained, stopped or lost. */
  nodeId: string | null;
  /** Where the thread's session works on its node, for the terminal resume command. */
  worktreePath: string | null;
  /** This thread's own model and thinking level; null uses the default for its kind. */
  model: string | null;
  thinking: ThinkingLevel | null;
  /** What the thread is doing now, from its to-do list and tool calls; live only, absent when idle with no list. */
  progress?: ThreadProgress;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadProgress {
  /** When the current run started; null between runs. */
  runStartedAt: string | null;
  /** The tool it is running, in a few words ("Running tests"). */
  activity: string | null;
  /** Its place in Claude Code's own to-do list, when it keeps one. */
  step: { number: number; total: number; title: string | null } | null;
  /** The middle length of this thread's past runs (or the project's), when there are enough to say. */
  typicalMs: number | null;
}

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'compacted'
  | 'error'
  | 'run_started'
  | 'run_ended'
  /** Project chat: the coordinator started a thread (meta.threadId). */
  | 'thread_started'
  /** Project chat: a thread's run ended and the coordinator was told (meta.threadId, meta.outcome). */
  | 'thread_notice'
  /** Project chat: the user retired the coordinator's session; the next message starts a fresh one. */
  | 'session_reset'
  /** The thread's run started on a different node than its last one (meta.from, meta.to). */
  | 'node_moved'
  /** A node pushed the thread's branch (meta.branch, meta.commit, meta.wip). */
  | 'git_push';

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
  /** The node the thread last ran on, when it is not this machine: the resume command works there. */
  resumeNode: string | null;
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

/** Estimated share of the plan's usage windows, in percentage points (0 to 100). */
export interface PlanShare {
  /** API-price value of the Subscription runs counted, the basis of the estimate. */
  notionalUsd: number;
  fiveHour: number | null;
  sevenDay: number | null;
}

/** How measured plan usage maps to API-price value for this account, learned from its own history. */
export interface PlanCalibration {
  /** Percentage points of the window per notional dollar; null until there is a sample. */
  pctPerUsd: number | null;
  /** Meter readings that moved while app runs were the only known activity. */
  samples: number;
  /** Rise in the window's meter that no app run accounts for (claude.ai, other clients). */
  unattributedPct: number;
}

/** GET /api/projects/:id/usage: estimated plan usage per thread and for the project, in the current windows. */
export interface ProjectUsage {
  project: PlanShare;
  threads: Record<string, PlanShare>;
  calibration: { fiveHour: PlanCalibration; sevenDay: PlanCalibration };
}

/** Messages pushed over WS /api/events. */
export type ServerEvent =
  | { type: 'runtime'; state: RuntimeState }
  | { type: 'thread'; thread: Thread }
  | { type: 'message'; message: Message }
  | { type: 'approval_requested'; approval: PendingApproval }
  | { type: 'approval_resolved'; id: string; threadId: string; behavior: 'allow' | 'deny' }
  | { type: 'nodes'; nodes: NodeView[] };

// ---- Nodes and remote access (M5, M6) ----

export interface NodeResources {
  cpus: number;
  load1: number;
  memTotal: number;
  memFree: number;
  diskTotal: number;
  diskFree: number;
}

/**
 * What the user set: enabled nodes take new threads up to their limit; draining nodes finish their
 * current turns and hand their threads off; disabled nodes take nothing. Offline is shown on top.
 */
export type NodeState = 'enabled' | 'draining' | 'disabled';

export interface NodeView {
  id: string;
  name: string;
  /** The orchestrator's own machine, which always runs the coordinator and local-folder projects. */
  local: boolean;
  state: NodeState;
  online: boolean;
  threadLimit: number;
  lastSeenAt: string | null;
  resources: NodeResources | null;
  info: {
    hostname: string;
    platform: string;
    arch: string;
    nodeVersion: string;
    claudeVersion: string | null;
    claudeLoggedIn: boolean;
  } | null;
  /** Whether each mode can run here now, and why not. */
  ready: Record<RunnerMode, { ok: boolean; reason?: string }>;
  threads: { id: string; projectId: string; title: string; status: ThreadStatus; running: boolean }[];
  createdAt: string;
}

export interface NodeUpdate {
  /** enable: take threads again. drain: finish current turns, then hand threads off. stop: interrupt now and hand off. */
  action?: 'enable' | 'drain' | 'stop';
  threadLimit?: number;
  name?: string;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
  /** Run on the new machine. */
  command: string;
  /** The orchestrator URL in the command; nodes must be able to reach it. */
  url: string;
  /** Steps to do on the orchestrator first, when no other machine could reach it yet; the command won't work until then. */
  setup?: string[];
  /** Where the URL came from, when the app picked it. */
  note?: string;
}

export type SecretName = 'claude_oauth_token' | 'anthropic_api_key' | 'github_token';

/** Credentials are write-only through the API: only whether one is set comes back. */
export interface SecretStatus {
  name: SecretName;
  set: boolean;
  updatedAt: string | null;
}

export interface AuthStatus {
  /** The server listens beyond localhost (remoteAccess in config). */
  remoteAccess: boolean;
  passwordSet: boolean;
  /** This request came from the orchestrator machine itself, which never needs to log in. */
  loopback: boolean;
  authenticated: boolean;
}
