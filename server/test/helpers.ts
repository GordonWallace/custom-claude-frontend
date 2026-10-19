import type { RunnerHealth, RunnerMode } from '@ccf/shared';
import { buildApp } from '../src/app.js';
import { openDb, Settings } from '../src/db.js';
import { EventBus } from '../src/events.js';
import { NotImplementedError, type SessionRunner } from '../src/runners/types.js';
import { RuntimeService } from '../src/runtime.js';

export class FakeRunner implements SessionRunner {
  ok = true;
  reason = 'not signed in';
  constructor(readonly mode: RunnerMode) {}

  async health(): Promise<RunnerHealth> {
    return {
      mode: this.mode,
      ok: this.ok,
      reason: this.ok ? undefined : this.reason,
      credentialSource: this.ok ? `fake ${this.mode} credential` : undefined,
      checkedAt: new Date().toISOString(),
    };
  }
  start(): never {
    throw new NotImplementedError('start');
  }
  resume(): never {
    throw new NotImplementedError('resume');
  }
}

export async function setup(opts: { mode?: RunnerMode | null; env?: NodeJS.ProcessEnv } = {}) {
  const runners = { api: new FakeRunner('api'), subscription: new FakeRunner('subscription') };
  const settings = new Settings(openDb(':memory:'));
  const bus = new EventBus();
  const logs: string[] = [];
  const runtime = new RuntimeService(
    runners,
    settings,
    bus,
    { mode: opts.mode ?? null, concurrency: 3 },
    opts.env ?? {},
    { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  );
  const app = await buildApp({ runtime, bus });
  return { app, runtime, runners, settings, bus, logs };
}
