import { useCallback, useEffect, useState } from 'react';
import type { RuntimeState, ServerEvent } from '@ccf/shared';
import { getRuntime } from './api';

export interface RuntimeView {
  state: RuntimeState | null;
  connected: boolean;
  /** Replace the state after a successful PUT, before the WS echo arrives. */
  setState: (state: RuntimeState) => void;
  refresh: () => Promise<void>;
}

/** Runtime state from GET /api/runtime, kept live by WS /api/events (reconnecting if the server restarts). */
export function useRuntime(): RuntimeView {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async () => {
    setState(await getRuntime(true));
  }, []);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/api/events`);
      socket.onopen = () => setConnected(true);
      socket.onmessage = (msg) => {
        const event = JSON.parse(msg.data as string) as ServerEvent;
        if (event.type === 'runtime') setState(event.state);
      };
      socket.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return { state, connected, setState, refresh };
}
