import { useState } from 'react';
import type { RunnerMode, RuntimeState } from '@ccf/shared';
import { putRuntime } from '../api';
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

      <p className="muted small">Active runs: {state.activeRuns}</p>
    </aside>
  );
}
