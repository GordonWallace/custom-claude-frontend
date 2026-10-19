import { useCallback, useState } from 'react';
import type { RuntimeState } from '@ccf/shared';
import { getRuntime } from './api';
import { useConnection, useServerEvents } from './live';

export interface RuntimeView {
  state: RuntimeState | null;
  connected: boolean;
  /** Replace the state after a successful PUT, before the WS echo arrives. */
  setState: (state: RuntimeState) => void;
  refresh: () => Promise<void>;
}

/** Runtime state, sent by the server on every (re)connect and on every change. */
export function useRuntime(): RuntimeView {
  const [state, setState] = useState<RuntimeState | null>(null);
  const { connected } = useConnection();
  useServerEvents((event) => {
    if (event.type === 'runtime') setState(event.state);
  });

  const refresh = useCallback(async () => {
    setState(await getRuntime(true));
  }, []);

  return { state, connected, setState, refresh };
}
