import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { UsageWindow } from '@ccf/shared';
import type { RunEvent, RunnerMode } from './types.js';

const SUMMARY_LIMIT = 2000;

/**
 * Normalizes one Agent SDK message into RunEvents. Both modes produce the same SDK messages
 * (they are the CLI's stream-json lines), so this is the only parser; the contract test replays
 * recorded streams through it.
 */
export function mapSdkMessage(msg: SDKMessage, mode: RunnerMode): RunEvent[] {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') return [{ type: 'init', sessionId: msg.session_id, model: msg.model, mode }];
      if (msg.subtype === 'compact_boundary') return [{ type: 'compacted' }];
      return [];

    case 'assistant': {
      // Subagent turns stay out of the thread's own transcript.
      if (msg.parent_tool_use_id) return [];
      // An API failure arrives as a synthetic assistant message whose text is the error: report it once, as an error.
      if (msg.error) {
        const text = msg.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
        return [{ type: 'error', message: text || `Assistant error: ${msg.error}` }];
      }
      const events: RunEvent[] = [];
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text.trim()) events.push({ type: 'assistant_text', text: block.text });
        if (block.type === 'tool_use') events.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
      const usage = msg.message.usage;
      if (usage) {
        const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        events.push({ type: 'usage', inputTokens: input, outputTokens: usage.output_tokens ?? 0, contextTokens: input });
      }
      return events;
    }

    case 'user': {
      if (msg.parent_tool_use_id) return [];
      const content = msg.message.content;
      if (typeof content === 'string') return [];
      const events: RunEvent[] = [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          events.push({
            type: 'tool_result',
            id: block.tool_use_id,
            isError: Boolean(block.is_error),
            summary: summarize(block.content),
          });
        }
      }
      return events;
    }

    case 'result': {
      const ok = msg.subtype === 'success' && !msg.is_error;
      const finalText = msg.subtype === 'success' ? msg.result : (msg.errors ?? []).join('\n') || msg.subtype;
      const usage = msg.usage;
      return [
        {
          type: 'result',
          ok,
          finalText,
          // Subscription runs report a notional cost too; only API mode is actually billed.
          costUsdEstimate: mode === 'api' ? msg.total_cost_usd : undefined,
          notionalCostUsd: msg.total_cost_usd,
          inputTokens: usage
            ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
            : undefined,
          outputTokens: usage?.output_tokens,
        },
      ];
    }

    case 'rate_limit_event': {
      const usage = planUsage(msg.rate_limit_info as unknown as RateLimitInfo);
      return usage ? [usage] : [];
    }

    default:
      return [];
  }
}

interface RateLimitInfo {
  status?: string;
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
}

/**
 * Reads plan utilization from a rate_limit_event. Undocumented: newer CLIs send both windows in
 * `unifiedWindows`; older ones send one window as `rateLimitType` + `utilization`. Anything else is ignored.
 */
function planUsage(info: RateLimitInfo | undefined): RunEvent | undefined {
  if (!info) return undefined;
  const window = (w?: { utilization?: number; resetsAt?: number }): UsageWindow | undefined =>
    typeof w?.utilization === 'number'
      ? { utilization: w.utilization, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : undefined }
      : undefined;
  let fiveHour = window(info.unifiedWindows?.five_hour);
  let sevenDay = window(info.unifiedWindows?.seven_day);
  if (info.rateLimitType === 'five_hour') fiveHour ??= window(info);
  if (info.rateLimitType === 'seven_day') sevenDay ??= window(info);
  if (!fiveHour && !sevenDay) return undefined;
  return { type: 'plan_usage', status: info.status, fiveHour, sevenDay };
}

function summarize(content: unknown): string {
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
      .join('\n');
  } else text = content == null ? '' : JSON.stringify(content);
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text;
}
