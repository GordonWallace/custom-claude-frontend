import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LaunchProfile, type QueryFn, SdkRunner } from './sdkRunner.js';
import type { RunnerHealth } from './types.js';

/** API mode: the Agent SDK's bundled Claude Code, billed to ANTHROPIC_API_KEY. */
export class ApiRunner extends SdkRunner {
  readonly mode = 'api' as const;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    queryFn?: QueryFn,
  ) {
    super(queryFn);
  }

  protected launchProfile(): LaunchProfile {
    return { env: { ...this.env } };
  }

  async health(): Promise<RunnerHealth> {
    const checkedAt = new Date().toISOString();
    const version = sdkVersion();
    if (!version) {
      return { mode: this.mode, ok: false, reason: 'The Agent SDK package is not installed. Run pnpm install.', checkedAt };
    }
    if (!this.env.ANTHROPIC_API_KEY?.trim()) {
      return {
        mode: this.mode,
        ok: false,
        version,
        reason: 'ANTHROPIC_API_KEY is not set. Set it in the environment the server starts in to use API mode.',
        checkedAt,
      };
    }
    return { mode: this.mode, ok: true, version, credentialSource: 'ANTHROPIC_API_KEY (environment)', checkedAt };
  }

}

function sdkVersion(): string | undefined {
  try {
    // The package doesn't export its package.json, so find it next to the entry point.
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}
