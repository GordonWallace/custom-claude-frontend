import type { RunnerMode, RuntimeState } from '@ccf/shared';
import { MODE_LABEL } from '../api';

const MODES: RunnerMode[] = ['subscription', 'api'];

const DESCRIPTION: Record<RunnerMode, string> = {
  subscription: 'Runs your installed claude CLI with your own login. API keys are stripped from every run.',
  api: 'Runs the Agent SDK with ANTHROPIC_API_KEY, billed per token.',
};

/** One card per runner with its health; picking a card asks the parent to confirm the switch. */
export function ModeOptions({ state, onPick }: { state: RuntimeState; onPick: (mode: RunnerMode) => void }) {
  return (
    <div className="mode-options">
      {MODES.map((mode) => {
        const health = state.health[mode];
        const current = state.mode === mode;
        return (
          <button
            key={mode}
            type="button"
            className={`mode-option mode-option-${mode}${current ? ' current' : ''}`}
            onClick={() => onPick(mode)}
            disabled={current}
            data-testid={`mode-option-${mode}`}
          >
            <strong>{MODE_LABEL[mode]}</strong>
            {current && <span className="tag">Active</span>}
            <span className="muted">{DESCRIPTION[mode]}</span>
            {health.ok ? (
              <span className="health ok">
                Ready · {health.credentialSource}
                {health.version && ` · v${health.version}`}
              </span>
            ) : (
              <span className="health bad">Unavailable: {health.reason}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
