import { useState } from 'react';
import type { RunnerMode, RuntimeState } from '@ccf/shared';
import { BILLING_CONSEQUENCE, MODE_LABEL, putRuntime } from '../api';

interface Props {
  target: RunnerMode;
  /** First launch: no mode yet, so there is nothing to keep. */
  firstChoice?: boolean;
  onDone: (state: RuntimeState) => void;
  onCancel: () => void;
}

/** Confirms a mode switch, stating the billing consequence; shows the server's reason if it refuses. */
export function SwitchDialog({ target, firstChoice, onDone, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await putRuntime({ mode: target }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal aria-labelledby="switch-title">
      <div className="dialog">
        <h2 id="switch-title">{firstChoice ? 'Use' : 'Switch to'} {MODE_LABEL[target]}?</h2>
        <p>{BILLING_CONSEQUENCE[target]}</p>
        {!firstChoice && <p className="muted">Runs already in progress finish in the mode they started in.</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`primary primary-${target}`} onClick={confirm} disabled={busy}>
            {busy ? 'Checking…' : firstChoice ? 'Use this mode' : 'Switch'}
          </button>
        </div>
      </div>
    </div>
  );
}
