import { useEffect, useState } from 'react';
import type { NodeView, PairingCode, RunnerMode } from '@ccf/shared';
import { createPairing, MODE_LABEL, removeNode, updateNode } from '../api';
import { StatusPill } from './StatusPill';

interface Props {
  nodes: NodeView[];
  onOpenThread: (projectId: string, threadId: string) => void;
}

/** The machines threads run on: their state, resources and threads, and the controls to add, drain or stop them. */
export function NodesView({ nodes, onOpenThread }: Props) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="nodes-view" aria-label="Nodes">
      <header className="nodes-head">
        <h1>Nodes</h1>
        <button type="button" onClick={() => setAdding(true)} data-testid="add-node">
          Add node
        </button>
      </header>
      <p className="muted">
        Threads of repo projects run on any enabled node, each in its own worktree and branch. This machine always runs the
        project chats and local-folder projects.
      </p>
      <div className="node-list">
        {nodes.map((n) => (
          <NodeCard key={n.id} node={n} onOpenThread={onOpenThread} />
        ))}
      </div>
      {adding && <AddNodeDialog onClose={() => setAdding(false)} />}
    </section>
  );
}

function stateLabel(n: NodeView): { label: string; tone: string } {
  if (!n.online) return { label: 'Offline', tone: 'offline' };
  if (n.state === 'draining') return { label: 'Draining', tone: 'draining' };
  if (n.state === 'disabled') return { label: 'Disabled', tone: 'disabled' };
  return { label: 'Enabled', tone: 'enabled' };
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes > 10 * 1024 ** 3 ? 0 : 1)} GB`;

function NodeCard({ node: n, onOpenThread }: { node: NodeView; onOpenThread: Props['onOpenThread'] }) {
  const [limit, setLimit] = useState(String(n.threadLimit));
  const [confirm, setConfirm] = useState<'stop' | 'remove'>();
  const [error, setError] = useState<string>();
  const state = stateLabel(n);
  useEffect(() => setLimit(String(n.threadLimit)), [n.threadLimit]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    setConfirm(undefined);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const r = n.resources;
  const notReady = (Object.keys(n.ready) as RunnerMode[]).filter((m) => !n.ready[m].ok);

  return (
    <article className={`node-card node-${state.tone}`} data-testid="node-card">
      <div className="node-card-head">
        <h2>{n.name}</h2>
        {n.local && <span className="chip">This machine</span>}
        <span className={`node-state node-state-${state.tone}`}>{state.label}</span>
        <span className="spacer" />
        {n.state === 'enabled' && (
          <>
            <button type="button" onClick={() => act(() => updateNode(n.id, { action: 'drain' }))} title="Finish current turns, then move its threads to other nodes">
              Drain
            </button>
            <StopButton confirm={confirm === 'stop'} onAsk={() => setConfirm('stop')} onStop={() => act(() => updateNode(n.id, { action: 'stop' }))} />
          </>
        )}
        {n.state === 'draining' && (
          <StopButton confirm={confirm === 'stop'} onAsk={() => setConfirm('stop')} onStop={() => act(() => updateNode(n.id, { action: 'stop' }))} />
        )}
        {n.state !== 'enabled' && (
          <button type="button" onClick={() => act(() => updateNode(n.id, { action: 'enable' }))}>
            Enable
          </button>
        )}
        {!n.local &&
          (confirm === 'remove' ? (
            <button type="button" className="danger" onClick={() => act(() => removeNode(n.id))}>
              Remove and revoke its token?
            </button>
          ) : (
            <button type="button" className="link" onClick={() => setConfirm('remove')}>
              Remove
            </button>
          ))}
      </div>

      <div className="node-facts muted small">
        {n.info && (
          <span>
            {n.info.hostname} · {n.info.platform}/{n.info.arch} · Node {n.info.nodeVersion} ·{' '}
            {n.info.claudeVersion ? `claude ${n.info.claudeVersion}${n.info.claudeLoggedIn ? ', signed in' : ''}` : 'bundled Claude Code'}
          </span>
        )}
        {!n.online && n.lastSeenAt && <span>Last seen {new Date(n.lastSeenAt).toLocaleString()}</span>}
      </div>

      {r && (
        <div className="node-resources small">
          <Meter label="CPU load" value={r.load1 / r.cpus} text={`${r.load1.toFixed(2)} on ${r.cpus} cores`} />
          <Meter label="Memory" value={1 - r.memFree / r.memTotal} text={`${gb(r.memTotal - r.memFree)} of ${gb(r.memTotal)}`} />
          {r.diskTotal > 0 && <Meter label="Disk" value={1 - r.diskFree / r.diskTotal} text={`${gb(r.diskFree)} free`} />}
        </div>
      )}

      {notReady.map((m) => (
        <p key={m} className="chip chip-warn small">
          {MODE_LABEL[m].split(':')[0]} can't run here: {n.ready[m].reason}
        </p>
      ))}

      <div className="node-limit small">
        <label>
          Thread limit{' '}
          <input type="number" min={1} max={32} value={limit} onChange={(e) => setLimit(e.target.value)} aria-label={`Thread limit for ${n.name}`} />
        </label>
        {Number(limit) !== n.threadLimit && (
          <button type="button" onClick={() => act(() => updateNode(n.id, { threadLimit: Number(limit) }))}>
            Save
          </button>
        )}
      </div>

      <div className="node-threads">
        <h3 className="small">Threads here</h3>
        {n.threads.length === 0 ? (
          <p className="muted small">None.</p>
        ) : (
          <ul>
            {n.threads.map((t) => (
              <li key={t.id}>
                <button type="button" className="link" onClick={() => onOpenThread(t.projectId, t.id)}>
                  {t.title}
                </button>
                <StatusPill status={t.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
    </article>
  );
}

function StopButton({ confirm, onAsk, onStop }: { confirm: boolean; onAsk: () => void; onStop: () => void }) {
  return confirm ? (
    <button type="button" className="danger" onClick={onStop} title="Interrupts running turns, saves unfinished work as a WIP commit and moves the threads">
      Stop its turns now?
    </button>
  ) : (
    <button type="button" onClick={onAsk}>
      Stop now
    </button>
  );
}

function Meter({ label, value, text }: { label: string; value: number; text: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="node-meter" title={text}>
      <span className="node-meter-label">{label}</span>
      <span className="node-meter-track">
        <span className="node-meter-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="muted">{text}</span>
    </div>
  );
}

function AddNodeDialog({ onClose }: { onClose: () => void }) {
  const [pairing, setPairing] = useState<PairingCode>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    createPairing().then(setPairing, (err: Error) => setError(err.message));
  }, []);
  return (
    <div className="overlay" role="dialog" aria-modal aria-label="Add node">
      <div className="dialog add-node-dialog">
        <h2>Add a node</h2>
        <p>
          Run this on the new machine. It needs Linux with Node.js 22.13+ and git (it installs both with apt if they're
          missing), and must reach this server, usually over Tailscale. It installs the worker, pairs, and starts it as a
          service; the node then shows up here.
        </p>
        {error && <p className="error">{error}</p>}
        {pairing && (
          <>
            <pre className="command" data-testid="install-command">{pairing.command}</pre>
            <div className="dialog-actions">
              <span className="muted small">The code works once and expires at {new Date(pairing.expiresAt).toLocaleTimeString()}.</span>
              <span className="spacer" />
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard?.writeText(pairing.command).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                }
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" onClick={onClose}>
                Done
              </button>
            </div>
            {pairing.warning && <p className="chip chip-warn small">{pairing.warning}</p>}
          </>
        )}
      </div>
    </div>
  );
}
