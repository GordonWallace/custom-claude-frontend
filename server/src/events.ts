import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@ccf/shared';

/** In-process fan-out for everything pushed to browsers over WS /api/events. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  publish(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
