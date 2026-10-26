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
    /** A key stored in the app (M5), used when the environment has none. */
    private readonly storedKey: () => string | undefined = () => undefined,
  ) {
    super(queryFn);
  }

  private key(): { value?: string; source: string } {
    const env = this.env.ANTHROPIC_API_KEY?.trim();
    if (env) return { value: env, source: 'ANTHROPIC_API_KEY (environment)' };
    return { value: this.storedKey()?.trim() || undefined, source: 'API key stored in the app' };
  }

  protected launchProfile(): LaunchProfile {
    return { env: { ...this.env, ANTHROPIC_API_KEY: this.key().value } };
  }

  async health(): Promise<RunnerHealth> {
    const checkedAt = new Date().toISOString();
    const version = sdkVersion();
    if (!version) {
      return { mode: this.mode, ok: false, reason: 'The Agent SDK package is not installed. Run pnpm install.', checkedAt };
    }
    const key = this.key();
    if (!key.value) {
      return {
        mode: this.mode,
        ok: false,
        version,
        reason: 'No API key. Set ANTHROPIC_API_KEY in the environment the server starts in, or save one under Settings › Credentials.',
        checkedAt,
      };
    }
    return { mode: this.mode, ok: true, version, credentialSource: key.source, checkedAt };
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
