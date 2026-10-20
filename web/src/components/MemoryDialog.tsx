import { useEffect, useState } from 'react';
import { getMemory, putMemory } from '../api';

/** Edits the project's MEMORY.md, which every session in the project gets in its prompt. */
export function MemoryDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getMemory(projectId).then((m) => setText(m.text), (e: Error) => setError(e.message));
  }, [projectId]);

  const save = async () => {
    if (text === null) return;
    setSaving(true);
    try {
      await putMemory(projectId, text);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal aria-labelledby="memory-title">
      <div className="dialog memory-dialog">
        <h2 id="memory-title">Project memory</h2>
        <p className="muted small">
          MEMORY.md in the project folder. Every session in this project gets it in its prompt from its next run, and
          sessions add durable facts and decisions to it themselves.
        </p>
        {text === null && !error ? (
          <p className="muted">Loading…</p>
        ) : (
          <textarea
            value={text ?? ''}
            onChange={(e) => setText(e.target.value)}
            rows={16}
            aria-label="Project memory"
            placeholder="Nothing yet."
          />
        )}
        {error && <p className="error small">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary primary-subscription" onClick={save} disabled={text === null || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
