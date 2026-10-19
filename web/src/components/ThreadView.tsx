import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message, ModeChangedError, RunnerMode, ThreadDetail } from '@ccf/shared';
import { ApiError, BILLING_CONSEQUENCE, MODE_LABEL, getThread, interruptThread, postMessage } from '../api';
import { useConnection, useServerEvents } from '../live';
import { ApprovalCard, ToolInput } from './ApprovalCard';
import { StatusPill } from './StatusPill';

export function ThreadView({ threadId }: { threadId: string }) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const { epoch } = useConnection();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDetail(null);
    void getThread(threadId).then(setDetail);
  }, [threadId, epoch]);

  useServerEvents((event) => {
    setDetail((d) => {
      if (!d) return d;
      switch (event.type) {
        case 'thread':
          return event.thread.id === threadId ? { ...d, thread: event.thread } : d;
        case 'message':
          if (event.message.threadId !== threadId || d.messages.some((m) => m.id === event.message.id)) return d;
          return { ...d, messages: [...d.messages, event.message] };
        case 'approval_requested':
          return event.approval.threadId === threadId ? { ...d, approvals: [...d.approvals, event.approval] } : d;
        case 'approval_resolved':
          return { ...d, approvals: d.approvals.filter((a) => a.id !== event.id) };
        default:
          return d;
      }
    });
  });

  // Refresh the resume command once the session id arrives.
  const sessionId = detail?.thread.claudeSessionId;
  useEffect(() => {
    if (sessionId && detail && !detail.resumeCommand) void getThread(threadId).then(setDetail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [detail?.messages.length, detail?.approvals.length]);

  if (!detail) return <section className="thread-view muted">Loading…</section>;
  const { thread } = detail;
  const busy = thread.status === 'running' || thread.status === 'awaiting_permission';

  return (
    <section className="thread-view">
      <header className="thread-head">
        <div className="thread-head-row">
          <h2>{thread.title}</h2>
          <StatusPill status={thread.status} />
        </div>
        <div className="thread-meta muted small">
          {thread.lastMode ? <span className={`mode-tag mode-tag-${thread.lastMode}`}>Last ran: {MODE_LABEL[thread.lastMode]}</span> : <span>Not run yet</span>}
          {thread.contextTokens !== null && <span title="Context size of the latest turn">Context {formatTokens(thread.contextTokens)} tokens</span>}
          {detail.resumeCommand && <ResumeCommand command={detail.resumeCommand} />}
        </div>
      </header>

      <div className="timeline" data-testid="timeline">
        <Timeline messages={detail.messages} />
        {detail.approvals.map((a) => (
          <ApprovalCard key={a.id} approval={a} />
        ))}
        <div ref={bottom} />
      </div>

      <Composer threadId={threadId} busy={busy} />
    </section>
  );
}

function Timeline({ messages }: { messages: Message[] }) {
  const results = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) if (m.kind === 'tool_result') map.set(String(m.meta?.toolUseId), m);
    return map;
  }, [messages]);
  const shown = new Set<string>();

  return (
    <>
      {messages.map((m) => {
        switch (m.kind) {
          case 'text':
            return (
              <div key={m.id} className={`bubble bubble-${m.author}`}>
                {m.text}
                {m.meta?.queued === true && <span className="muted small"> · sent during the run</span>}
              </div>
            );
          case 'tool_use': {
            const id = String(m.meta?.toolUseId);
            shown.add(id);
            return <ToolCall key={m.id} name={m.text} input={m.meta?.input} result={results.get(id)} />;
          }
          case 'tool_result':
            return shown.has(String(m.meta?.toolUseId)) ? null : (
              <div key={m.id} className="muted small">
                Tool result: {m.text}
              </div>
            );
          case 'run_started': {
            const mode = m.meta?.mode as RunnerMode;
            return (
              <div key={m.id} className={`run-divider run-divider-${mode}`} data-testid="run-started">
                <span>
                  Run · {MODE_LABEL[mode]}
                  {m.meta?.resumed ? ' · resumed session' : ''}
                </span>
              </div>
            );
          }
          case 'run_ended': {
            const cost = m.meta?.costUsdEstimate as number | null | undefined;
            return (
              <div key={m.id} className="run-end muted small">
                {m.text}
                {typeof cost === 'number' && ` · $${cost.toFixed(4)} est.`}
              </div>
            );
          }
          case 'compacted':
            return (
              <div key={m.id} className="run-divider">
                <span>Context compacted</span>
              </div>
            );
          case 'error':
            return (
              <div key={m.id} className="bubble bubble-error" role="alert">
                {m.text}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

function ToolCall({ name, input, result }: { name: string; input: unknown; result?: Message }) {
  const isError = result?.meta?.isError === true;
  return (
    <details className={`tool${isError ? ' tool-error' : ''}`}>
      <summary>
        <span className="tool-name">{name}</span> <span className="muted small">{toolSummary(name, input)}</span>
        {!result && <span className="muted small"> · running</span>}
        {isError && <span className="error small"> · error</span>}
      </summary>
      <ToolInput toolName={name} input={input} />
      {result && <pre className="code result">{result.text || '(no output)'}</pre>}
    </details>
  );
}

function Composer({ threadId, busy }: { threadId: string; busy: boolean }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [modeChange, setModeChange] = useState<ModeChangedError & { text: string }>();

  const send = async (body: { text: string; continueInMode?: RunnerMode }) => {
    setError(undefined);
    try {
      await postMessage(threadId, body);
      setText('');
      setModeChange(undefined);
    } catch (err) {
      if (err instanceof ApiError && err.body.error === 'mode_changed') {
        setModeChange({ ...(err.body as unknown as ModeChangedError), text: body.text });
      } else {
        setError((err as Error).message);
      }
    }
  };

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (text.trim()) void send({ text });
  };

  return (
    <form className="composer" onSubmit={submit}>
      {error && <p className="error small">{error}</p>}
      <div className="composer-row">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) submit(e);
          }}
          placeholder={busy ? 'Send a follow-up (runs after the current turn)…' : 'Message Claude…'}
          rows={2}
          aria-label="Message"
        />
        <div className="composer-actions">
          <button type="submit" className="primary primary-subscription" disabled={!text.trim()}>
            Send
          </button>
          {busy && (
            <button type="button" onClick={() => void interruptThread(threadId).catch((e: Error) => setError(e.message))}>
              Stop
            </button>
          )}
        </div>
      </div>

      {modeChange && (
        <div className="overlay" role="dialog" aria-modal aria-labelledby="mode-change-title">
          <div className="dialog">
            <h2 id="mode-change-title">Continue in {MODE_LABEL[modeChange.mode]}?</h2>
            <p>
              This thread last ran in {MODE_LABEL[modeChange.lastMode]}. {BILLING_CONSEQUENCE[modeChange.mode]}
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setModeChange(undefined)}>
                Cancel
              </button>
              <button
                type="button"
                className={`primary primary-${modeChange.mode}`}
                onClick={() => void send({ text: modeChange.text, continueInMode: modeChange.mode })}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

function ResumeCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="link small"
      title={command}
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy terminal resume command'}
    </button>
  );
}

function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const value = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description;
  const text = typeof value === 'string' ? value : '';
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
