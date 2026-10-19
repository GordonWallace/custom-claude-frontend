import type { Thread } from '@ccf/shared';

/** Name the app's MCP server has in every session, so its tools appear as mcp__app__<tool>. */
export const APP_MCP_SERVER = 'app';

const SHARED_TOOLS = ['read_memory', 'write_memory'] as const;
const COORDINATOR_TOOLS = ['start_thread', 'message_thread', 'list_threads', 'read_thread'] as const;

/** The app tools a session of this kind gets. They are pre-approved, so calling them never asks the user. */
export function toolsFor(kind: Thread['kind']): string[] {
  return kind === 'coordinator' ? [...COORDINATOR_TOOLS, ...SHARED_TOOLS] : [...SHARED_TOOLS];
}
