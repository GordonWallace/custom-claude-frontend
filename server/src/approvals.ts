import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, PendingApproval } from '@ccf/shared';
import type { EventBus } from './events.js';
import type { PermissionDecision, PermissionRequest } from './runners/types.js';

interface Entry {
  approval: PendingApproval;
  suggestions?: unknown[];
  resolve: (decision: PermissionDecision) => void;
}

/**
 * Tool calls waiting on the user, keyed by request id. Each request and each answer is broadcast,
 * so any open view (or one opened after a reload) can show and answer it.
 */
export class ApprovalStore {
  private readonly pending = new Map<string, Entry>();

  constructor(private readonly bus: EventBus) {}

  request(threadId: string, runId: number, req: PermissionRequest): Promise<PermissionDecision> {
    const approval: PendingApproval = {
      id: randomUUID(),
      threadId,
      runId,
      toolName: req.toolName,
      input: req.input,
      decisionReason: req.decisionReason,
      canAlwaysAllow: Boolean(req.suggestions?.length),
      createdAt: new Date().toISOString(),
    };
    return new Promise((resolve) => {
      this.pending.set(approval.id, { approval, suggestions: req.suggestions, resolve });
      this.bus.publish({ type: 'approval_requested', approval });
      req.signal.addEventListener('abort', () => this.settle(approval.id, { behavior: 'deny', message: 'Run stopped.' }), {
        once: true,
      });
    });
  }

  /** Applies the user's answer. Returns false if the request is gone (already answered or its run ended). */
  decide(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    return this.settle(
      id,
      decision.behavior === 'allow'
        ? { behavior: 'allow', updatedPermissions: decision.always ? entry.suggestions : undefined }
        : { behavior: 'deny', message: decision.message?.trim() || 'The user denied this tool call.' },
    );
  }

  forThread(threadId: string): PendingApproval[] {
    return [...this.pending.values()].filter((e) => e.approval.threadId === threadId).map((e) => e.approval);
  }

  /** Denies whatever a finished or stopped run left waiting. */
  cancelRun(runId: number): void {
    for (const [id, entry] of this.pending) {
      if (entry.approval.runId === runId) this.settle(id, { behavior: 'deny', message: 'Run ended.' });
    }
  }

  private settle(id: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(decision);
    this.bus.publish({
      type: 'approval_resolved',
      id,
      threadId: entry.approval.threadId,
      behavior: decision.behavior,
    });
    return true;
  }
}
