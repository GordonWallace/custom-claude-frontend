import { useEffect, useRef, useState } from 'react';
import type { ServerEvent } from '@ccf/shared';

/** One shared WebSocket to /api/events for the whole UI, reconnecting if the server restarts. */
type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
const connectionListeners = new Set<(epoch: number, connected: boolean) => void>();
let socket: WebSocket | undefined;
let connected = false;
/** Increments on every successful (re)connect, so views know to refetch what they may have missed. */
let epoch = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/api/events`);
  socket.onopen = () => {
    connected = true;
    epoch++;
    connectionListeners.forEach((l) => l(epoch, connected));
  };
  socket.onmessage = (msg) => {
    const event = JSON.parse(msg.data as string) as ServerEvent;
    listeners.forEach((l) => l(event));
  };
  socket.onclose = () => {
    socket = undefined;
    if (connected) {
      connected = false;
      connectionListeners.forEach((l) => l(epoch, connected));
    }
    setTimeout(connect, 2000);
  };
}

function ensureSocket() {
  if (!socket) connect();
}

/** Calls `handler` for every server event while the component is mounted. */
export function useServerEvents(handler: Listener): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener: Listener = (e) => ref.current(e);
    listeners.add(listener);
    ensureSocket();
    return () => {
      listeners.delete(listener);
    };
  }, []);
}

/** Connection state plus the reconnect epoch (use it as an effect dependency to refetch). */
export function useConnection(): { connected: boolean; epoch: number } {
  const [state, setState] = useState({ connected, epoch });
  useEffect(() => {
    const listener = (e: number, c: boolean) => setState({ connected: c, epoch: e });
    connectionListeners.add(listener);
    ensureSocket();
    setState({ connected, epoch });
    return () => {
      connectionListeners.delete(listener);
    };
  }, []);
  return state;
}
