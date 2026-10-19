import { useState } from 'react';
import type { ApprovalDecision, PendingApproval } from '@ccf/shared';
import { decideApproval } from '../api';

/** A tool call parked on the user's answer. Answering from any open view resolves it everywhere. */
export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const answer = async (decision: ApprovalDecision) => {
    setBusy(true);
    try {
      await decideApproval(approval.id, decision);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="approval" role="group" aria-label={`Approve ${approval.toolName}`} data-testid="approval">
      <div className="approval-head">
        <strong>Claude wants to use {approval.toolName}</strong>
        {approval.decisionReason && <span className="muted small">{approval.decisionReason}</span>}
      </div>
      <ToolInput toolName={approval.toolName} input={approval.input} />
      <div className="approval-actions">
        <button type="button" className="primary primary-subscription" disabled={busy} onClick={() => answer({ behavior: 'allow' })}>
          Allow
        </button>
        {approval.canAlwaysAllow && (
          <button type="button" disabled={busy} onClick={() => answer({ behavior: 'allow', always: true })}>
            Allow for this session
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => answer({ behavior: 'deny' })}>
          Deny
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** Shows the part of a tool's input a person needs to judge it. */
export function ToolInput({ toolName, input }: { toolName: string; input: unknown }) {
  const i = (input ?? {}) as Record<string, unknown>;
  if (toolName === 'Bash' && typeof i.command === 'string') return <pre className="code">{i.command}</pre>;
  if (typeof i.file_path === 'string' && typeof i.content === 'string') {
    return (
      <>
        <div className="muted small">{i.file_path}</div>
        <pre className="code">{i.content}</pre>
      </>
    );
  }
  return <pre className="code">{JSON.stringify(input, null, 2)}</pre>;
}
