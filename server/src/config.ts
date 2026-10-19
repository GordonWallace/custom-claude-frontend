import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerMode } from '@ccf/shared';

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
}

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function isRunnerMode(value: unknown): value is RunnerMode {
  return value === 'api' || value === 'subscription';
}

/**
 * Reads config.json (or the file named by CCF_CONFIG) from the repo root, then applies
 * environment overrides: CCF_MODE, CCF_PORT, CCF_DATA_DIR, CCF_CLAUDE_PATH.
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
  return {
    mode: mode ?? null,
    host: '127.0.0.1',
    port: Number(env.CCF_PORT ?? fromFile.port ?? 4317),
    dataDir: path.resolve(repoRoot, dataDir),
    claudePath: String(env.CCF_CLAUDE_PATH ?? fromFile.claudePath ?? 'claude'),
    concurrency: Number(fromFile.concurrency ?? 3),
    workspacesDir: path.resolve(repoRoot, String(fromFile.workspacesDir ?? path.join(dataDir, 'workspaces'))),
    maxTurns: Number(fromFile.maxTurns ?? 50),
    spendWarnUsd: Number(fromFile.spendWarnUsd ?? 10) || null,
  };
}
