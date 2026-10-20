import type { ModelOption, SessionDefaults, ThinkingLevel } from '@ccf/shared';

export const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};
const LEVELS = Object.keys(THINKING_LABEL) as ThinkingLevel[];

interface Props {
  models: ModelOption[];
  value: SessionDefaults;
  /** What "Default" means here; null when it's Claude Code's own default. */
  fallback: SessionDefaults | null;
  onChange: (patch: Partial<SessionDefaults>) => void;
  /** Prefix for the pickers' accessible names, e.g. "Thread". */
  label?: string;
  compact?: boolean;
}

/** Model and thinking pickers. The empty choice means "use the default", shown with what that is. */
export function SessionPickers({ models, value, fallback, onChange, label, compact }: Props) {
  const modelName = (v: string) => models.find((m) => m.value === v)?.label ?? v;
  const defaultLabel = (what: string, chosen: string | null) =>
    fallback ? `${what}: default${chosen ? ` (${chosen})` : ''}` : `${what}: Claude Code's default`;
  const effective = value.model ?? fallback?.model ?? null;
  const efforts = models.find((m) => m.value === effective)?.efforts;
  // Off is always possible; a model that reports its effort levels only offers those.
  const levels = LEVELS.filter((l) => l === 'off' || !efforts || efforts.includes(l));
  const known = value.model === null || models.some((m) => m.value === value.model);

  return (
    <span className={`session-pickers${compact ? ' compact' : ''}`}>
      <select
        value={value.model ?? ''}
        onChange={(e) => onChange({ model: e.target.value || null })}
        aria-label={`${label ? `${label} ` : ''}model`}
        title="Model, from the next run"
      >
        <option value="">{defaultLabel('Model', fallback?.model ? modelName(fallback.model) : null)}</option>
        {models.map((m) => (
          <option key={m.value} value={m.value} title={m.description}>
            Model: {m.label}
          </option>
        ))}
        {!known && <option value={value.model!}>{value.model}</option>}
      </select>
      <select
        value={value.thinking ?? ''}
        onChange={(e) => onChange({ thinking: (e.target.value || null) as ThinkingLevel | null })}
        aria-label={`${label ? `${label} ` : ''}thinking`}
        title="Thinking, from the next run"
      >
        <option value="">{defaultLabel('Thinking', fallback?.thinking ? THINKING_LABEL[fallback.thinking] : null)}</option>
        {levels.map((l) => (
          <option key={l} value={l}>
            Thinking: {THINKING_LABEL[l]}
          </option>
        ))}
      </select>
    </span>
  );
}
