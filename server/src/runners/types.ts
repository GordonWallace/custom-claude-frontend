import type { RunnerHealth, RunnerMode, UsageWindow } from '@ccf/shared';

export type { RunnerHealth, RunnerMode };

export interface McpServerConfig {
  name: string;
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

/** A tool call Claude Code wants to make and the user has to answer. */
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  decisionReason?: string;
  /** Rules Claude Code proposes so it stops asking (returned on "always allow"). */
  suggestions?: unknown[];
  signal: AbortSignal;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string };

export interface RunConfig {
  cwd: string; // project workspace directory
  model?: string;
  appendSystemPrompt?: string; // role prompt + project memory
  mcpServers: McpServerConfig[]; // always includes the app's own MCP server (from M2)
  allowedTools?: string[];
  permissionMode: 'default' | 'acceptEdits' | 'plan';
  maxTurns?: number;
  /** Answers tool approvals. Both modes reach it through the same stream-json control protocol. */
  onPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** URL a SessionStart hook POSTs its JSON to, so the app learns the real session id on start, resume and compaction. */
  sessionHookUrl?: string;
}

export type RunEvent =
  | { type: 'init'; sessionId: string; model: string; mode: RunnerMode }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; isError: boolean; summary: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; contextTokens?: number }
  | { type: 'compacted' }
  | {
      type: 'result';
      ok: boolean;
      finalText: string;
      costUsdEstimate?: number;
      /** API-price value of the run in either mode; the basis for apportioning plan usage (M3). */
      notionalCostUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
    }
  | { type: 'plan_usage'; status?: string; fiveHour?: UsageWindow; sevenDay?: UsageWindow }
  | { type: 'error'; message: string };

export interface RunHandle {
  events: AsyncIterable<RunEvent>; // normalized stream
  send(message: string): void; // follow-up user turn while running
  interrupt(): Promise<void>;
}

/** The one seam between the app and Claude Code. Everything above it is mode-agnostic. */
export interface SessionRunner {
  readonly mode: RunnerMode;
  health(): Promise<RunnerHealth>; // binary found, credential present, version
  start(cfg: RunConfig, firstMessage: string): RunHandle;
  resume(sessionId: string, cfg: RunConfig, message: string): RunHandle;
}
