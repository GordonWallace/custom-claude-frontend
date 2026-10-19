import { useState } from 'react';
import type { RunnerMode } from '@ccf/shared';
import { ModeBadge } from './components/ModeBadge';
import { ModeOptions } from './components/ModeOptions';
import { SettingsPanel } from './components/SettingsPanel';
import { SwitchDialog } from './components/SwitchDialog';
import { useRuntime } from './useRuntime';

export function App() {
  const { state, connected, setState, refresh } = useRuntime();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switchTo, setSwitchTo] = useState<RunnerMode>();

  const firstLaunch = state !== null && state.mode === null;

  return (
    <div className="app">
      <header className="header">
        <span className="brand">Custom Claude Frontend</span>
        <ModeBadge state={state} onClick={() => setSettingsOpen(true)} />
        <span className="spacer" />
        {!connected && <span className="chip chip-error">Server disconnected, reconnecting…</span>}
        <button type="button" onClick={() => setSettingsOpen((open) => !open)}>
          Settings
        </button>
      </header>

      <main className="main">
        {firstLaunch ? (
          <section className="first-launch">
            <h1>Choose how Claude runs</h1>
            <p className="muted">
              No mode is set in config.json or CCF_MODE, so pick one. You can switch at any time from the badge in the
              header.
            </p>
            <ModeOptions state={state} onPick={setSwitchTo} />
          </section>
        ) : (
          <section className="empty">
            <h1>Projects</h1>
            <p className="muted">Projects, the coordinator chat and threads arrive in the next milestones.</p>
          </section>
        )}
      </main>

      {settingsOpen && state && (
        <SettingsPanel
          state={state}
          onPick={setSwitchTo}
          onState={setState}
          onRefresh={refresh}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {switchTo && (
        <SwitchDialog
          target={switchTo}
          firstChoice={firstLaunch}
          onDone={(next) => {
            setState(next);
            setSwitchTo(undefined);
          }}
          onCancel={() => setSwitchTo(undefined)}
        />
      )}
    </div>
  );
}
