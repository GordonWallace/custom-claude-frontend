import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { Access } from './auth.js';
import { loadConfig, repoRoot } from './config.js';
import { openDb, Settings } from './db.js';
import { EventBus } from './events.js';
import { NodeAgent } from './nodes/agent.js';
import { NodeHub } from './nodes/hub.js';
import { TranscriptStore } from './nodes/transcripts.js';
import { ApiRunner } from './runners/apiRunner.js';
import { CliRunner } from './runners/cliRunner.js';
import { ApprovalStore } from './approvals.js';
import { RuntimeService } from './runtime.js';
import { SecretStore } from './secrets.js';
import { Store } from './store.js';
import { ThreadService } from './threads.js';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node ${process.versions.node} is too old: this app needs Node 22.13 or newer (for node:sqlite).`);
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const config = loadConfig();
const db = openDb(path.join(config.dataDir, 'app.db'));
const store = new Store(db);
const settings = new Settings(db);
const bus = new EventBus();
const log = { info: (msg: string) => logger.info(msg), warn: (msg: string) => logger.warn(msg) };
const secrets = new SecretStore(store, path.join(config.dataDir, 'secret.key'));
const runners = {
  api: new ApiRunner(process.env, undefined, () => secrets.get('anthropic_api_key')),
  subscription: new CliRunner(config.claudePath),
};
const runtime = new RuntimeService(
  runners,
  settings,
  bus,
  { mode: config.mode, concurrency: config.concurrency, spendWarnUsd: config.spendWarnUsd, approvals: config.approvals },
  process.env,
  log,
  () => store.apiSpendUsd(),
);
const nodes = new NodeHub(store, new TranscriptStore(path.join(config.dataDir, 'transcripts')), log);
const threads = new ThreadService(store, runtime, new ApprovalStore(bus), bus, {
  workspacesDir: config.workspacesDir,
  maxTurns: config.maxTurns,
  log,
  nodes,
  secrets,
  env: process.env,
});

// This machine is the first node: it runs the coordinator, local-folder projects and any repo threads placed here.
const cli = await runtime.health('subscription');
nodes.attachLocal(
  new NodeAgent({ workDir: path.join(config.dataDir, 'node-work'), baseUrl: () => `http://127.0.0.1:${config.port}`, runners, log }),
  {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    claudeVersion: cli.version ?? null,
    claudeLoggedIn: cli.ok,
  },
  `${os.hostname()} (this machine)`,
  config.localThreadLimit,
);
threads.recoverAfterRestart();
threads.ensureDefaultProject();

const access = new Access(store, settings, { remoteAccess: config.remoteAccess, allowedNetworks: config.allowedNetworks });
const app = await buildApp({
  runtime,
  threads,
  bus,
  nodes,
  secrets,
  access,
  publicUrl: config.publicUrl ?? undefined,
  port: config.port,
  webDist: path.join(repoRoot, 'web/dist'),
  logger,
});
await runtime.logStartup();
try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  // A machine without IPv6 can't listen on '::'; every IPv4 interface does the same job.
  if ((err as NodeJS.ErrnoException).code !== 'EAFNOSUPPORT' || config.host !== '::') throw err;
  await app.listen({ host: '0.0.0.0', port: config.port });
}
if (config.remoteAccess) {
  log.info(
    `Remote access is on: listening on every interface for Tailscale${config.allowedNetworks.length ? ` and ${config.allowedNetworks.join(', ')}` : ''}.` +
      (access.passwordSet() ? '' : ' Set a password under Settings › Remote access before using it from another device.'),
  );
}
// Start input that was queued before the restart, now that sessions can reach the MCP server.
void threads.pump();
