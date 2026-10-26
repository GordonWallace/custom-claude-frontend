import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message, ModelOption, ModeChangedError, NodeView, ProjectUsage, RunnerMode, RuntimeState, ThinkingLevel, Thread, ThreadDetail } from '@ccf/shared';
import { ApiError, BILLING_CONSEQUENCE, MODE_LABEL, getThread, interruptThread, postMessage, resetCoordinator, updateThreadSettings } from '../api';
import { SessionPickers, THINKING_LABEL } from './SessionPickers';
import { ContextMeter } from './ContextMeter';
import { Markdown } from './Markdown';
import { MemoryDialog } from './MemoryDialog';
import { PlanShareLabel } from './PlanShareLabel';
import { useConnection, useServerEvents } from '../live';
import { usePrefs } from '../prefs';
import { ApprovalCard, ToolInput } from './ApprovalCard';
import { ProgressLine } from './ProgressLine';
import { StatusPill } from './StatusPill';

interface Props {
  threadId: string;
  /** The project's threads, live, for the project chat's thread cards. */
  threads: Thread[];
  /** Project chat only: the thread open in the right pane, and how to open one. */
  openThreadId?: string;
  onOpenThread?: (threadId: string) => void;
  /** Right pane only: closes it. */
  onClose?: () => void;
  /** Estimated plan usage for the project's threads. */
  usage?: ProjectUsage | null;
  /** Nodes, to name the one the thread runs on. */
  nodes?: NodeView[];
  /** For the model and thinking pickers. */
  runtime?: RuntimeState | null;
}

/** A conversation: the project chat (the coordinator) in the centre pane, or one thread in the right pane. */
export function ThreadView({ threadId, threads, openThreadId, onOpenThread, onClose, usage, nodes, runtime }: Props) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [dialog, setDialog] = useState<'memory' | 'reset'>();
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

  // Refresh the resume command once the session id arrives, or the thread lands in a new working directory.
  const sessionId = detail?.thread.claudeSessionId;
  const worktree = detail?.thread.worktreePath;
  useEffect(() => {
    if (sessionId && detail) void getThread(threadId).then(setDetail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, worktree]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [detail?.messages.length, detail?.approvals.length]);

  if (!detail) return <section className="thread-view muted">Loading…</section>;
  const { thread } = detail;
  const busy = thread.status === 'running' || thread.status === 'awaiting_permission';
  const isChat = thread.kind === 'coordinator';

  return (
    <section className={`thread-view${isChat ? ' project-chat' : ' thread-pane'}`} aria-label={isChat ? 'Project chat' : 'Thread'}>
      <header className="thread-head">
        <div className="thread-head-row">
          <h2>{isChat ? detail.project.name : thread.title}</h2>
          {isChat && <span className="muted">Project chat</span>}
          <StatusPill status={thread.status} />
          {isChat && (
            <span className="head-actions">
              <button type="button" className="link" onClick={() => setDialog('memory')}>
                Memory
              </button>
              <button type="button" className="link" onClick={() => setDialog('reset')} disabled={busy || thread.status === 'queued'}>
                Fresh session
              </button>
            </span>
          )}
          {onClose && (
            <button type="button" className="link close" onClick={onClose} aria-label="Close thread">
              Close
            </button>
          )}
        </div>
        <div className="thread-meta muted small">
          {thread.origin === 'coordinator' && <span>Started by the coordinator</span>}
          {thread.lastMode ? <span className={`mode-tag mode-tag-${thread.lastMode}`}>Last ran: {MODE_LABEL[thread.lastMode]}</span> : <span>Not run yet</span>}
          <ContextMeter thread={thread} />
          <PlanShareLabel
            share={isChat ? usage?.project : usage?.threads[thread.id]}
            calibration={usage?.calibration.sevenDay}
            scope={isChat ? 'project' : 'thread'}
          />
          {!isChat && thread.nodeId && (
            <span className="node-chip" title="The node this thread runs on" data-testid="thread-node">
              On {nodes?.find((n) => n.id === thread.nodeId)?.name ?? 'a node'}
            </span>
          )}
          {detail.resumeCommand && <ResumeCommand command={detail.resumeCommand} node={detail.resumeNode} />}
        </div>
      </header>

      <div className="timeline" data-testid="timeline">
        {isChat && detail.messages.length === 0 && (
          <p className="muted empty-chat">
            Ask for something here. The coordinator answers quick questions itself and starts threads for real work, which run
            in parallel and report back.
          </p>
        )}
        <Timeline messages={detail.messages} threads={threads} openThreadId={openThreadId} onOpenThread={onOpenThread} nodes={nodes} models={runtime?.models} />
        {detail.approvals.map((a) => (
          <ApprovalCard key={a.id} approval={a} />
        ))}
        <div ref={bottom} />
      </div>

      <Composer threadId={threadId} busy={busy} queued={thread.status === 'queued'} isChat={isChat} thread={thread} runtime={runtime} />

      {dialog === 'memory' && <MemoryDialog projectId={detail.project.id} onClose={() => setDialog(undefined)} />}
      {dialog === 'reset' && <ResetDialog projectId={detail.project.id} onClose={() => setDialog(undefined)} />}
    </section>
  );
}

interface TimelineProps {
  messages: Message[];
  threads: Thread[];
  openThreadId?: string;
  onOpenThread?: (threadId: string) => void;
  nodes?: NodeView[];
  models?: ModelOption[];
}

function Timeline({ messages, threads, openThreadId, onOpenThread, nodes, models }: TimelineProps) {
  const results = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) if (m.kind === 'tool_result') map.set(String(m.meta?.toolUseId), m);
    return map;
  }, [messages]);
  const endedRuns = useMemo(() => new Set(messages.filter((m) => m.kind === 'run_ended').map((m) => m.runId)), [messages]);
  const [{ showToolCalls }] = usePrefs();
  const shown = new Set<string>();

  return (
    <>
      {messages.map((m) => {
        switch (m.kind) {
          case 'text':
            if (m.meta?.from === 'coordinator') return <CoordinatorMessage key={m.id} message={m} />;
            return (
              <div key={m.id} className={`bubble bubble-${m.author}${m.meta?.from === 'coordinator' ? ' bubble-coordinator' : ''}`}>
                {m.meta?.from === 'coordinator' && <div className="bubble-label muted small">From the coordinator</div>}
                {m.author === 'assistant' ? <Markdown text={m.text} /> : m.text}
                {m.meta?.queued === true && <span className="muted small"> · sent during the run</span>}
              </div>
            );
          case 'tool_use': {
            if (!showToolCalls) return null;
            const id = String(m.meta?.toolUseId);
            shown.add(id);
            // The thread card below says this better than the raw tool call, and ToolSearch is
            // Claude Code loading the app's tools, not work the user asked for.
            if (m.text === 'mcp__app__start_thread' || m.text === 'ToolSearch') return null;
            return <ToolCall key={m.id} name={m.text} input={m.meta?.input} result={results.get(id)} ended={m.runId !== null && endedRuns.has(m.runId)} />;
          }
          case 'tool_result':
            if (!showToolCalls) return null;
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
                  {m.meta?.model ? ` · ${models?.find((x) => x.value === m.meta?.model)?.label ?? String(m.meta.model)}` : ''}
                  {m.meta?.thinking ? ` · thinking ${THINKING_LABEL[m.meta.thinking as ThinkingLevel]?.toLowerCase() ?? String(m.meta.thinking)}` : ''}
                  {m.meta?.resumed ? ' · resumed session' : ''}
                  {(() => {
                    const node = nodes?.find((n) => n.id === m.meta?.nodeId);
                    return node && !node.local ? ` · on ${node.name}` : '';
                  })()}
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
          case 'thread_started': {
            const id = String(m.meta?.threadId);
            const t = threads.find((x) => x.id === id);
            return (
              <ThreadCard
                key={m.id}
                title={t?.title ?? m.text}
                thread={t}
                open={id === openThreadId}
                onOpen={onOpenThread && (() => onOpenThread(id))}
              />
            );
          }
          case 'thread_notice':
            return <ThreadNotice key={m.id} message={m} onOpenThread={onOpenThread} />;
          case 'compacted':
            return (
              <div key={m.id} className="run-divider run-divider-compacted" data-testid="compacted">
                <span>{m.text}</span>
              </div>
            );
          case 'node_moved':
            return (
              <div key={m.id} className="run-divider run-divider-moved" data-testid="node-moved">
                <span>{m.text}</span>
              </div>
            );
          case 'git_push':
            return (
              <div key={m.id} className="run-divider run-divider-push">
                <span>{m.text}</span>
              </div>
            );
          case 'session_reset':
            return (
              <div key={m.id} className="run-divider run-divider-reset">
                <span>Fresh coordinator session · earlier messages stay here but the coordinator no longer has them</span>
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

/** A brief or follow-up the coordinator sent this thread: one line until clicked. */
function CoordinatorMessage({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const preview = message.text.split('\n').find((line) => line.trim()) ?? '';
  return (
    <div className={`bubble bubble-user bubble-coordinator${open ? ' open' : ''}`}>
      <button type="button" className="collapse-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chevron">{open ? '▾' : '▸'}</span>
        <span className="muted small">From the coordinator</span>
        {!open && <span className="collapse-preview">{preview}</span>}
        {message.meta?.queued === true && <span className="muted small">· sent during the run</span>}
      </button>
      {open && <div className="collapse-body">{message.text}</div>}
    </div>
  );
}

/** A thread finished and the coordinator was told: one line until clicked, then what it was told. */
function ThreadNotice({ message, onOpenThread }: { message: Message; onOpenThread?: (threadId: string) => void }) {
  const [open, setOpen] = useState(false);
  const id = String(message.meta?.threadId);
  const outcome = String(message.meta?.outcome);
  const finalText = typeof message.meta?.finalText === 'string' ? message.meta.finalText : null;
  return (
    <div className={`notice notice-${outcome}${open ? ' open' : ''}`}>
      <button type="button" className="collapse-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chevron">{open ? '▾' : '▸'}</span>
        {outcome === 'done' ? '✓' : outcome === 'failed' ? '✕' : '■'} {message.text}
      </button>
      {open && (
        <div className="collapse-body">
          {finalText ? <Markdown text={finalText} /> : <p className="muted small">This notice predates saved summaries.</p>}
          {onOpenThread && (
            <button type="button" className="link" onClick={() => onOpenThread(id)}>
              Open thread
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ThreadCard({ title, thread, open, onOpen }: { title: string; thread?: Thread; open: boolean; onOpen?: () => void }) {
  return (
    <button type="button" className={`thread-card${open ? ' open' : ''}`} onClick={onOpen} data-testid="thread-card">
      <span className="thread-card-main">
        <span className="thread-card-title">{title}</span>
        {thread && <ProgressLine thread={thread} />}
      </span>
      <span className="thread-card-meta">
        {thread?.lastMode && <span className={`mode-tag mode-tag-${thread.lastMode}`}>{MODE_LABEL[thread.lastMode].split(':')[0]}</span>}
        {thread && <StatusPill status={thread.status} />}
      </span>
    </button>
  );
}

function ToolCall({ name, input, result, ended }: { name: string; input: unknown; result?: Message; ended: boolean }) {
  const isError = result?.meta?.isError === true;
  return (
    <details className={`tool${isError ? ' tool-error' : ''}`}>
      <summary>
        <span className="tool-name">{name}</span> <span className="muted small">{toolSummary(name, input)}</span>
        {!result && <span className="muted small"> · {ended ? 'no result' : 'running'}</span>}
        {isError && <span className="error small"> · error</span>}
      </summary>
      <ToolInput toolName={name} input={input} />
      {result && <pre className="code result">{result.text || '(no output)'}</pre>}
    </details>
  );
}

interface ComposerProps {
  threadId: string;
  busy: boolean;
  queued: boolean;
  isChat: boolean;
  thread: Thread;
  runtime?: RuntimeState | null;
}

function Composer({ threadId, busy, queued, isChat, thread, runtime }: ComposerProps) {
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
          placeholder={
            busy ? 'Send a follow-up (runs after the current turn)…' : isChat ? 'Message the coordinator…' : 'Message Claude…'
          }
          rows={2}
          aria-label="Message"
        />
        <div className="composer-actions">
          <button type="submit" className="primary primary-subscription" disabled={!text.trim()}>
            Send
          </button>
          {(busy || queued) && (
            <button type="button" onClick={() => void interruptThread(threadId).catch((e: Error) => setError(e.message))}>
              {queued ? 'Cancel' : 'Stop'}
            </button>
          )}
        </div>
      </div>
      {runtime && (
        <div className="composer-options">
          <SessionPickers
            compact
            models={runtime.models}
            value={{ model: thread.model, thinking: thread.thinking }}
            fallback={runtime.sessionDefaults[thread.kind]}
            onChange={(patch) => void updateThreadSettings(threadId, patch).catch((e: Error) => setError(e.message))}
          />
          {busy && <span className="muted small">Changes apply from the next run.</span>}
        </div>
      )}

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

function ResetDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [error, setError] = useState<string>();
  return (
    <div className="overlay" role="dialog" aria-modal aria-labelledby="reset-title">
      <div className="dialog">
        <h2 id="reset-title">Start a fresh coordinator session?</h2>
        <p>
          The coordinator's next reply starts a new session that knows the project memory and the list of threads, but not
          this conversation. Use it when the project chat has grown large. Threads keep their own sessions.
        </p>
        {error && <p className="error small">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary primary-subscription"
            onClick={() => void resetCoordinator(projectId).then(onClose, (e: Error) => setError(e.message))}
          >
            Start fresh
          </button>
        </div>
      </div>
    </div>
  );
}

function ResumeCommand({ command, node }: { command: string; node: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="link small"
      title={node ? `Run on ${node}: ${command}` : command}
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : node ? `Copy resume command (on ${node})` : 'Copy terminal resume command'}
    </button>
  );
}

function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const value = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description;
  const text = typeof value === 'string' ? value : '';
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
