import { useEffect, useState } from 'react';
import type { AuthStatus, RunnerMode, RuntimeState, SecretName, SecretStatus } from '@ccf/shared';
import { getAuth, listSecrets, putRuntime, putSecret, setPassword } from '../api';
import { ModeOptions } from './ModeOptions';

interface Props {
  state: RuntimeState;
  onPick: (mode: RunnerMode) => void;
  onState: (state: RuntimeState) => void;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}

export function SettingsPanel({ state, onPick, onState, onRefresh, onClose }: Props) {
  const [concurrency, setConcurrency] = useState(String(state.concurrency));
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);

  const saveConcurrency = async () => {
    setError(undefined);
    try {
      onState(await putRuntime({ concurrency: Number(concurrency) }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const recheck = async () => {
    setChecking(true);
    await onRefresh().finally(() => setChecking(false));
  };

  return (
    <aside className="settings" aria-label="Settings">
      <div className="settings-head">
        <h2>Settings</h2>
        <button type="button" onClick={onClose} aria-label="Close settings">
          ✕
        </button>
      </div>

      <section>
        <div className="section-head">
          <h3>Runner mode</h3>
          <button type="button" onClick={recheck} disabled={checking}>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
        </div>
        <ModeOptions state={state} onPick={onPick} />
      </section>

      <section>
        <h3>Parallel threads</h3>
        <p className="muted">How many thread sessions may run at once. Lower is gentler on plan limits and spend.</p>
        <div className="inline-form">
          <input
            type="number"
            min={1}
            max={32}
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
            aria-label="Concurrency cap"
          />
          <button type="button" onClick={saveConcurrency} disabled={Number(concurrency) === state.concurrency}>
            Save
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      <Credentials />
      <RemoteAccess />

      <p className="muted small">Active runs: {state.activeRuns}</p>
    </aside>
  );
}

const SECRETS: Record<SecretName, { label: string; help: string; placeholder: string }> = {
  claude_oauth_token: {
    label: 'Claude token (Subscription mode)',
    help: 'From `claude setup-token` on any machine signed in to your plan. Other nodes run Subscription threads with it; this machine keeps using its own login.',
    placeholder: 'sk-ant-oat01-…',
  },
  anthropic_api_key: {
    label: 'Anthropic API key (API mode)',
    help: 'Used by every node in API mode when the server has no ANTHROPIC_API_KEY in its environment.',
    placeholder: 'sk-ant-api03-…',
  },
  github_token: {
    label: 'GitHub token',
    help: 'A fine-grained token with contents read and write on your repos. Nodes clone and push threads\' branches with it.',
    placeholder: 'github_pat_…',
  },
};

/** Credentials the orchestrator hands to nodes with each run. Write-only: the server never sends them back. */
function Credentials() {
  const [status, setStatus] = useState<SecretStatus[]>([]);
  const [values, setValues] = useState<Partial<Record<SecretName, string>>>({});
  const [error, setError] = useState<string>();
  useEffect(() => {
    listSecrets().then(setStatus, (err: Error) => setError(err.message));
  }, []);
  const save = async (name: SecretName, value: string) => {
    setError(undefined);
    try {
      setStatus(await putSecret(name, value));
      setValues((v) => ({ ...v, [name]: '' }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section>
      <h3>Credentials</h3>
      <p className="muted small">Stored encrypted on this machine and sent to a node only for the run that needs it; nodes never save them.</p>
      {status.map((s) => (
        <div key={s.name} className="secret-row">
          <div className="label">
            <strong className="small">{SECRETS[s.name].label}</strong>
            <span className={`small ${s.set ? 'ok' : 'muted'}`}>{s.set ? 'Saved' : 'Not set'}</span>
          </div>
          <input
            type="password"
            autoComplete="off"
            placeholder={s.set ? 'Saved; type to replace' : SECRETS[s.name].placeholder}
            value={values[s.name] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [s.name]: e.target.value }))}
            aria-label={SECRETS[s.name].label}
          />
          {values[s.name] ? (
            <button type="button" onClick={() => save(s.name, values[s.name]!)}>
              Save
            </button>
          ) : s.set ? (
            <button type="button" className="link" onClick={() => save(s.name, '')}>
              Remove
            </button>
          ) : (
            <span />
          )}
          <p className="muted small" style={{ gridColumn: '1 / -1', margin: 0 }}>
            {SECRETS[s.name].help}
          </p>
        </div>
      ))}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** The password other devices log in with when the server listens beyond this machine. */
function RemoteAccess() {
  const [auth, setAuth] = useState<AuthStatus>();
  const [password, setPw] = useState('');
  const [note, setNote] = useState<string>();
  useEffect(() => {
    getAuth().then(setAuth, () => undefined);
  }, []);
  if (!auth) return null;
  const save = async () => {
    setNote(undefined);
    try {
      await setPassword(password);
      setPw('');
      setNote('Saved. Other devices need to log in again.');
      setAuth(await getAuth());
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  return (
    <section>
      <h3>Remote access</h3>
      <p className="muted small">
        {auth.remoteAccess
          ? 'On: the server accepts this machine, your Tailscale network and any allowedNetworks, and other devices log in with this password.'
          : 'Off: only this machine can open the app. Set remoteAccess to true in config.json (or CCF_REMOTE_ACCESS=1) and restart to use it from your phone or add other nodes.'}
      </p>
      <div className="inline-form">
        <input
          type="password"
          autoComplete="new-password"
          placeholder={auth.passwordSet ? 'New password' : 'Set a password (8+ characters)'}
          value={password}
          onChange={(e) => setPw(e.target.value)}
          aria-label="Remote access password"
        />
        <button type="button" onClick={save} disabled={password.length < 8}>
          {auth.passwordSet ? 'Change' : 'Set'}
        </button>
      </div>
      {note && <p className="muted small">{note}</p>}
    </section>
  );
}
