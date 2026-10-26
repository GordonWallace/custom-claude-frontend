import type { NodeResources, RunnerMode, ThinkingLevel } from '@ccf/shared';
import type { McpServerConfig, RunEvent } from '../runners/types.js';

/**
 * The messages between the orchestrator and a node, as JSON over the node's WebSocket (or handed
 * across in memory for the orchestrator's own node). Every run's events, approvals and transcript
 * travel this way, so a node needs nothing but this connection and outbound internet.
 */

/** Where a run works: a folder on the orchestrator's machine, or the thread's own worktree of a repo. */
export type Workspace =
  | { kind: 'folder'; path: string }
  | {
      kind: 'repo';
      projectId: string;
      repoUrl: string;
      /** Branch new threads start from; the remote's default branch when unset. */
      baseBranch: string | null;
      threadId: string;
      branch: string;
      /** The thread is new to this node: replace any worktree left from an earlier stay. */
      fresh: boolean;
    };

/** A RunConfig as it crosses the wire: no callbacks, and URLs relative to the orchestrator. */
export interface WireRunConfig {
  model?: string;
  thinking?: ThinkingLevel;
  appendSystemPrompt?: string;
  /** `url` is a path such as /mcp; the node puts its own base URL for the orchestrator in front. */
  mcpServers: McpServerConfig[];
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode: 'default' | 'acceptEdits' | 'plan';
  maxTurns?: number;
  /** Path of the SessionStart hook endpoint, such as /api/hooks/session-start/<token>. */
  sessionHookPath?: string;
}

export interface RunStart {
  t: 'run_start';
  runId: number;
  threadId: string;
  mode: RunnerMode;
  cfg: WireRunConfig;
  message: string;
  resumeSessionId: string | null;
  /** Size of the transcript the orchestrator holds for resumeSessionId; the node fetches it if its own copy is shorter. */
  transcriptSize: number;
  workspace: Workspace;
  /** Credentials for this run only, as environment variables. Never written to the node's disk. */
  env: Record<string, string>;
}

export interface NodeHello {
  t: 'hello';
  token: string;
  version: string;
  info: NodeInfoReport;
  resources: NodeResources;
  /** Projects this node already has a clone of, so the scheduler can prefer it. */
  projects: string[];
}

export interface NodeInfoReport {
  hostname: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  /** The claude CLI on the node's PATH, if any; without one, runs use the Agent SDK's bundled Claude Code. */
  claudeVersion: string | null;
  /** Whether the node's own claude is signed in to a Claude plan (used when no token is stored on the orchestrator). */
  claudeLoggedIn: boolean;
}

export interface Handoff {
  t: 'handoff';
  reqId: string;
  threadId: string;
  workspace: Workspace;
  sessionId: string | null;
  transcriptSize: number;
  /** Shown in the WIP commit message. */
  reason: string;
  env: Record<string, string>;
}

export type ToNode =
  | { t: 'welcome'; nodeId: string; name: string }
  | { t: 'refused'; reason: string }
  | RunStart
  | { t: 'run_send'; runId: number; text: string }
  | { t: 'run_interrupt'; runId: number }
  | { t: 'permission_result'; runId: number; reqId: string; behavior: 'allow' | 'deny'; message?: string; updatedPermissions?: unknown[] }
  | { t: 'transcript_data'; reqId: string; data: string | null }
  | { t: 'transcript_resync'; threadId: string; sessionId: string; size: number }
  | Handoff;

export type FromNode =
  | NodeHello
  | { t: 'heartbeat'; resources: NodeResources }
  | { t: 'run_workspace'; runId: number; cwd: string }
  | { t: 'run_event'; runId: number; event: RunEvent }
  | { t: 'run_end'; runId: number }
  /** A follow-up arrived after the run stopped taking input; the orchestrator queues it for the next run. */
  | { t: 'send_rejected'; runId: number; text: string }
  | {
      t: 'permission_request';
      runId: number;
      reqId: string;
      toolName: string;
      input: Record<string, unknown>;
      toolUseId?: string;
      decisionReason?: string;
      suggestions?: unknown[];
    }
  | { t: 'permission_cancel'; runId: number; reqId: string }
  | { t: 'transcript_fetch'; reqId: string; threadId: string; sessionId: string }
  /** Transcript bytes from `offset` on (the file only grows, so each upload is what's new since the last). */
  | { t: 'transcript'; threadId: string; sessionId: string; offset: number; data: string }
  | { t: 'pushed'; threadId: string; branch: string; commit: string; wip: boolean }
  | { t: 'git_error'; threadId: string; message: string }
  | { t: 'handoff_done'; reqId: string; ok: boolean; error?: string; commit?: string; wip?: boolean };

/** One end of a node connection. */
export interface Link<In, Out> {
  send(message: Out): void;
  onMessage(handler: (message: In) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/** The orchestrator's own node talks over this: the same messages, passed in memory (and JSON-copied, as on the wire). */
export function memoryLinkPair(): { orchestrator: Link<FromNode, ToNode>; node: Link<ToNode, FromNode> } {
  type Side<In> = { handlers: ((m: In) => void)[]; closers: (() => void)[] };
  const toNode: Side<ToNode> = { handlers: [], closers: [] };
  const toOrch: Side<FromNode> = { handlers: [], closers: [] };
  let closed = false;
  const deliver = <M>(side: Side<M>, message: M) => {
    if (closed) return;
    const copy = JSON.parse(JSON.stringify(message)) as M;
    queueMicrotask(() => side.handlers.forEach((h) => h(copy)));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    [...toNode.closers, ...toOrch.closers].forEach((c) => c());
  };
  return {
    orchestrator: {
      send: (m) => deliver(toNode, m),
      onMessage: (h) => toOrch.handlers.push(h),
      onClose: (h) => toOrch.closers.push(h),
      close,
    },
    node: {
      send: (m) => deliver(toOrch, m),
      onMessage: (h) => toNode.handlers.push(h),
      onClose: (h) => toNode.closers.push(h),
      close,
    },
  };
}

/** A node's end of the connection over Node's built-in WebSocket client (the worker, and tests). */
export function webSocketLink(ws: WebSocket): Link<ToNode, FromNode> {
  const handlers: ((m: ToNode) => void)[] = [];
  const closers: (() => void)[] = [];
  ws.addEventListener('message', (e) => {
    let message: ToNode;
    try {
      message = JSON.parse(String(e.data)) as ToNode;
    } catch {
      return;
    }
    handlers.forEach((h) => h(message));
  });
  ws.addEventListener('close', () => closers.forEach((c) => c()));
  return {
    send: (m) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    onMessage: (h) => handlers.push(h),
    onClose: (h) => closers.push(h),
    close: () => ws.close(),
  };
}

export const HEARTBEAT_MS = 10_000;
export const OFFLINE_AFTER_MS = 30_000;
