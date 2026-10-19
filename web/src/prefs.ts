import { useEffect, useState } from 'react';

/** Display preferences for this browser only, kept in localStorage. */
export interface Prefs {
  showToolCalls: boolean;
}

const KEY = 'ccf.prefs';
const DEFAULTS: Prefs = { showToolCalls: false };
const CHANGED = 'ccf-prefs-changed';

function read(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

export function usePrefs(): [Prefs, (update: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState(read);
  useEffect(() => {
    const sync = () => setPrefs(read());
    window.addEventListener(CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGED, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const update = (change: Partial<Prefs>) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...read(), ...change }));
    } catch {
      // Storage blocked: the change lasts until the page reloads.
    }
    setPrefs((p) => ({ ...p, ...change }));
    window.dispatchEvent(new Event(CHANGED));
  };
  return [prefs, update];
}
