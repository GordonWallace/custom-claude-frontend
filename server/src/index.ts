import path from 'node:path';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { loadConfig, repoRoot } from './config.js';
import { openDb, Settings } from './db.js';
import { EventBus } from './events.js';
import { ApiRunner } from './runners/apiRunner.js';
import { CliRunner } from './runners/cliRunner.js';
import { ApprovalStore } from './approvals.js';
import { RuntimeService } from './runtime.js';
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
const bus = new EventBus();
const log = { info: (msg: string) => logger.info(msg), warn: (msg: string) => logger.warn(msg) };
const runtime = new RuntimeService(
  { api: new ApiRunner(), subscription: new CliRunner(config.claudePath) },
  new Settings(db),
  bus,
  { mode: config.mode, concurrency: config.concurrency, spendWarnUsd: config.spendWarnUsd },
  process.env,
  log,
  () => store.apiSpendUsd(),
);
const threads = new ThreadService(store, runtime, new ApprovalStore(bus), bus, {
  workspacesDir: config.workspacesDir,
  serverUrl: () => `http://${config.host}:${config.port}`,
  maxTurns: config.maxTurns,
  log,
});
threads.recoverAfterRestart();
threads.ensureDefaultProject();

const app = await buildApp({ runtime, threads, bus, webDist: path.join(repoRoot, 'web/dist'), logger });
await runtime.logStartup();
await app.listen({ host: config.host, port: config.port });
// Start input that was queued before the restart, now that sessions can reach the MCP server.
void threads.pump();
