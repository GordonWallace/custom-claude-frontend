import { useState } from 'react';
import { login } from '../api';

/** The single user's password, asked on devices other than the orchestrator machine. */
export function Login({ passwordSet }: { passwordSet: boolean }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await login(password);
      location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="login" onSubmit={submit}>
      <h1>Custom Claude Frontend</h1>
      {passwordSet ? (
        <>
          <p className="muted">Enter the password set on the orchestrator machine.</p>
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
          <button type="submit" className="primary" disabled={busy || !password}>
            {busy ? 'Checking…' : 'Log in'}
          </button>
        </>
      ) : (
        <p className="muted">No password is set yet. On the orchestrator machine, open the app and set one under Settings › Remote access.</p>
      )}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
