import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunnerHealth, RunnerMode } from '@ccf/shared';
import { NodeAgent } from '../src/nodes/agent.js';
import { NodeHub } from '../src/nodes/hub.js';
import type { NodeInfoReport } from '../src/nodes/protocol.js';
import { TranscriptStore } from '../src/nodes/transcripts.js';
import { SecretStore } from '../src/secrets.js';
import { buildApp } from '../src/app.js';
import { Access, type AccessOptions } from '../src/auth.js';
import { ApprovalStore } from '../src/approvals.js';
import { openDb, Settings } from '../src/db.js';
import { EventBus } from '../src/events.js';
import type { RunConfig, RunEvent, RunHandle, SessionRunner } from '../src/runners/types.js';
import { RuntimeService } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { ThreadService } from '../src/threads.js';

/** Drives a run from the test: `script` gets the run's config and yields its events. */
export type Script = (cfg: RunConfig, message: string) => AsyncGenerator<RunEvent>;

export class FakeRunner implements SessionRunner {
  ok = true;
  reason = 'not signed in';
  script: Script = async function* () {
    yield { type: 'result', ok: true, finalText: 'ok' };
  };
  readonly calls: { kind: 'start' | 'resume'; sessionId?: string; message: string; cfg: RunConfig }[] = [];
  readonly sent: string[] = [];
  interrupted = false;
  /** False makes send() refuse, like a run whose input stream has ended. */
  acceptSends = true;

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

  start(cfg: RunConfig, message: string): RunHandle {
    this.calls.push({ kind: 'start', message, cfg });
    return this.handle(cfg, message);
  }

  resume(sessionId: string, cfg: RunConfig, message: string): RunHandle {
    this.calls.push({ kind: 'resume', sessionId, message, cfg });
    return this.handle(cfg, message);
  }

  private handle(cfg: RunConfig, message: string): RunHandle {
    return {
      events: this.script(cfg, message),
      send: (text) => {
        if (!this.acceptSends) return false;
        this.sent.push(text);
        return true;
      },
      interrupt: async () => {
        this.interrupted = true;
      },
    };
  }
}

export async function setup(opts: { mode?: RunnerMode | null; env?: NodeJS.ProcessEnv; access?: AccessOptions } = {}) {
  const runners = { api: new FakeRunner('api'), subscription: new FakeRunner('subscription') };
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const store = new Store(db);
  const bus = new EventBus();
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
  const runtime = new RuntimeService(
    runners,
    settings,
    bus,
    { mode: opts.mode ?? null, concurrency: 3 },
    opts.env ?? {},
    log,
    () => store.apiSpendUsd(),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccf-test-'));
  const secrets = new SecretStore(store, null);
  const nodes = new NodeHub(store, new TranscriptStore(path.join(dir, 'transcripts')), log);
  const threads = new ThreadService(store, runtime, new ApprovalStore(bus), bus, {
    workspacesDir: path.join(dir, 'workspaces'),
    log,
    nodes,
    secrets,
    env: opts.env ?? {},
  });
  nodes.attachLocal(
    new NodeAgent({ workDir: path.join(dir, 'node-work'), baseUrl: () => 'http://127.0.0.1:1', runners, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'claude-local'), ...opts.env } }),
    LOCAL_INFO,
    'this machine',
    3,
  );
  const access = opts.access && new Access(store, settings, opts.access);
  const app = await buildApp({ runtime, threads, bus, nodes, secrets, access });
  return { app, runtime, threads, runners, settings, store, bus, logs, nodes, secrets, access, dir };
}

export const LOCAL_INFO: NodeInfoReport = {
  hostname: 'test',
  platform: 'linux',
  arch: 'x64',
  nodeVersion: '22',
  claudeVersion: '2.1.0',
  claudeLoggedIn: true,
};

/** Resolves when `check` passes, polling the event loop (runs are consumed asynchronously). */
export async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
