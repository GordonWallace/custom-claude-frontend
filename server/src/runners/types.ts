import type { RunnerHealth, RunnerMode } from '@ccf/shared';

export type { RunnerHealth, RunnerMode };

export interface McpServerConfig {
  name: string;
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface RunConfig {
  cwd: string; // project workspace directory
  model?: string;
  appendSystemPrompt?: string; // role prompt + project memory
  mcpServers: McpServerConfig[]; // always includes the app's own MCP server
  allowedTools?: string[];
  permissionMode: 'default' | 'acceptEdits' | 'plan';
  maxTurns?: number;
}

export type RunEvent =
  | { type: 'init'; sessionId: string; model: string; mode: RunnerMode }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; isError: boolean; summary: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; contextTokens?: number }
  | { type: 'compacted' }
  | { type: 'result'; ok: boolean; finalText: string; costUsdEstimate?: number }
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

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet (milestone M1)`);
  }
}
