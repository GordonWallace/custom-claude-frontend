import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApprovalPolicy, RunnerMode } from '@ccf/shared';

export interface AppConfig {
  /** Default mode; a mode chosen through the API or UI is stored in the settings table and wins over this. */
  mode: RunnerMode | null;
  host: string;
  port: number;
  dataDir: string;
  claudePath: string;
  concurrency: number;
  /** Where new projects' workspaces go by default. */
  workspacesDir: string;
  /** Cap on agent turns per run, so a runaway session stops on its own. */
  maxTurns: number;
  /** API-mode spend at which the header badge turns into a warning; 0 turns the warning off. */
  spendWarnUsd: number | null;
  /** Default tool-approval policy; one chosen in the UI or through PUT /api/runtime wins. */
  approvals: ApprovalPolicy;
  /** Listen on every interface (accepting only Tailscale and allowedNetworks) with a login, for other devices and nodes (M5). */
  remoteAccess: boolean;
  allowedNetworks: string[];
  /** This server's URL as other machines reach it, e.g. http://orchestrator.tailnet-name.ts.net:4317. */
  publicUrl: string | null;
  /** Threads the orchestrator's own machine runs at once, as a node. */
  localThreadLimit: number;
}

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function isRunnerMode(value: unknown): value is RunnerMode {
  return value === 'api' || value === 'subscription';
}

/**
 * Reads config.json (or the file named by CCF_CONFIG) from the repo root, then applies
 * environment overrides: CCF_MODE, CCF_PORT, CCF_DATA_DIR, CCF_CLAUDE_PATH, CCF_REMOTE_ACCESS, CCF_PUBLIC_URL.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const file = path.resolve(repoRoot, env.CCF_CONFIG ?? 'config.json');
  let fromFile: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  }

  const mode = env.CCF_MODE ?? fromFile.mode;
  if (mode !== undefined && mode !== null && !isRunnerMode(mode)) {
    throw new Error(`Invalid mode ${JSON.stringify(mode)}: expected "api" or "subscription"`);
  }

  const dataDir = String(env.CCF_DATA_DIR ?? fromFile.dataDir ?? './data');
  const remoteAccess = env.CCF_REMOTE_ACCESS !== undefined ? env.CCF_REMOTE_ACCESS === '1' : fromFile.remoteAccess === true;
  const concurrency = Number(fromFile.concurrency ?? 3);
  return {
    mode: mode ?? null,
    host: remoteAccess ? '::' : '127.0.0.1',
    port: Number(env.CCF_PORT ?? fromFile.port ?? 4317),
    dataDir: path.resolve(repoRoot, dataDir),
    claudePath: String(env.CCF_CLAUDE_PATH ?? fromFile.claudePath ?? 'claude'),
    concurrency,
    workspacesDir: path.resolve(repoRoot, String(fromFile.workspacesDir ?? path.join(dataDir, 'workspaces'))),
    maxTurns: Number(fromFile.maxTurns ?? 50),
    spendWarnUsd: Number(fromFile.spendWarnUsd ?? 10) || null,
    approvals: fromFile.approvals === 'ask' || fromFile.approvals === 'all' ? fromFile.approvals : 'auto',
    remoteAccess,
    allowedNetworks: Array.isArray(fromFile.allowedNetworks) ? fromFile.allowedNetworks.map(String) : [],
    publicUrl: (env.CCF_PUBLIC_URL ?? (fromFile.publicUrl as string | undefined)) || null,
    localThreadLimit: Number(fromFile.localThreadLimit ?? concurrency),
  };
}
