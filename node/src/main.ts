import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeAgent } from '../../server/src/nodes/agent.js';
import { HEARTBEAT_MS, type NodeInfoReport, webSocketLink } from '../../server/src/nodes/protocol.js';
import { ApiRunner } from '../../server/src/runners/apiRunner.js';
import { CliRunner, resolveExecutable, subscriptionEnv } from '../../server/src/runners/cliRunner.js';
import { type LaunchProfile, SdkRunner, setHookScript } from '../../server/src/runners/sdkRunner.js';
import type { RunnerHealth } from '../../server/src/runners/types.js';

declare const WORKER_VERSION: string;

/**
 * The node worker. `pair <url> <code>` trades a one-time code from the orchestrator's Nodes view for
 * this node's token; `run` keeps a WebSocket open to the orchestrator and runs the threads it sends.
 * It keeps its token and clones in CCF_NODE_HOME (default ~/.ccf-node) and never stores credentials:
 * those arrive with each run.
 */

const home = process.env.CCF_NODE_HOME || path.join(os.homedir(), '.ccf-node');
const configFile = path.join(home, 'config.json');
const log = {
  info: (msg: string) => console.log(`${new Date().toISOString()} ${msg}`),
  warn: (msg: string) => console.warn(`${new Date().toISOString()} ${msg}`),
};

interface WorkerConfig {
  url: string;
  nodeId: string;
  name: string;
  token: string;
}

/** Subscription mode on a node without its own claude: the SDK's bundled Claude Code with the token the orchestrator sends. */
class BundledSubscriptionRunner extends SdkRunner {
  readonly mode = 'subscription' as const;
  protected launchProfile(): LaunchProfile {
    return { env: subscriptionEnv(process.env) };
  }
  async health(): Promise<RunnerHealth> {
    return { mode: this.mode, ok: true, checkedAt: new Date().toISOString() };
  }
}

async function describe(): Promise<NodeInfoReport> {
  const claudeOnPath = resolveExecutable('claude', process.env.PATH);
  const health = claudeOnPath.includes('/') ? await new CliRunner(claudeOnPath).health() : null;
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    claudeVersion: health?.version ?? null,
    claudeLoggedIn: Boolean(health?.ok),
  };
}

async function pair(url: string, code: string, name = os.hostname()): Promise<void> {
  const base = url.replace(/\/$/, '');
  const res = await fetch(`${base}/api/nodes/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
  const body = (await res.json()) as { nodeId?: string; name?: string; token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(body.error ?? `Pairing failed (HTTP ${res.status}).`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ url: base, nodeId: body.nodeId, name: body.name, token: body.token }, null, 2), { mode: 0o600 });
  console.log(`Paired as node "${body.name}". Start it with: node ${path.join(home, 'worker.mjs')} run`);
}

async function run(): Promise<void> {
  if (!fs.existsSync(configFile)) throw new Error(`Not paired yet: run "node worker.mjs pair <orchestrator url> <code>" first.`);
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) as WorkerConfig;
  setHookScript(path.join(home, 'post-hook.mjs'));

  const info = await describe();
  const claude = resolveExecutable('claude', process.env.PATH);
  const agent = new NodeAgent({
    workDir: path.join(home, 'work'),
    baseUrl: () => cfg.url,
    runners: {
      subscription: claude.includes('/') ? new CliRunner(claude) : new BundledSubscriptionRunner(),
      api: new ApiRunner(),
    },
    log,
  });
  log.info(`Node worker ${WORKER_VERSION} for ${cfg.url}; claude ${info.claudeVersion ?? 'not on PATH (using the bundled Claude Code)'}`);

  let delay = 1000;
  const connect = () => {
    const ws = new WebSocket(`${cfg.url.replace(/^http/, 'ws')}/api/nodes/connect`);
    const link = webSocketLink(ws);
    let beat: NodeJS.Timeout | undefined;
    link.onMessage((m) => {
      if (m.t === 'welcome') {
        delay = 1000;
        log.info(`Connected as ${m.name}`);
      } else if (m.t === 'refused') {
        log.warn(`The orchestrator refused this node: ${m.reason}`);
        process.exit(0);
      }
    });
    ws.addEventListener('open', () => {
      agent.attach(link);
      link.send(agent.hello(cfg.token, WORKER_VERSION, info));
      beat = setInterval(() => link.send({ t: 'heartbeat', resources: agent.resources() }), HEARTBEAT_MS);
    });
    ws.addEventListener('close', () => {
      clearInterval(beat);
      log.warn(`Disconnected; retrying in ${Math.round(delay / 1000)}s`);
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    });
    ws.addEventListener('error', () => {
      // The close event follows and schedules the retry.
    });
  };
  connect();
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'pair' && args.length >= 2) await pair(args[0], args[1], args[2]);
  else if (command === 'run') await run();
  else {
    console.log('Usage: node worker.mjs pair <orchestrator url> <code> [name]\n       node worker.mjs run');
    process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
