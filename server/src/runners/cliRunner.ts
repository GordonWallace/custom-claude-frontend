import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { type LaunchProfile, type QueryFn, SdkRunner } from './sdkRunner.js';
import type { RunnerHealth } from './types.js';

const execFileAsync = promisify(execFile);

/** Oldest claude CLI whose stream-json protocol this app has been checked against. */
export const MIN_CLI_VERSION = '2.0.0';

/**
 * The environment every claude child process gets: the parent's, minus anything that would
 * make the CLI bill an API account or another provider instead of the user's Claude plan.
 */
export function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN') continue;
    if (key.startsWith('CLAUDE_CODE_USE_')) continue;
    child[key] = value;
  }
  return child;
}

interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
}

/**
 * Subscription mode: the Agent SDK driving the user's own installed, signed-in claude CLI, with API
 * credentials stripped from its environment so usage comes from their Claude plan.
 */
export class CliRunner extends SdkRunner {
  readonly mode = 'subscription' as const;

  constructor(
    private readonly claudePath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    queryFn?: QueryFn,
  ) {
    super(queryFn);
  }

  protected launchProfile(): LaunchProfile {
    const env = subscriptionEnv(this.env);
    return { executablePath: resolveExecutable(this.claudePath, env.PATH), env };
  }

  async health(): Promise<RunnerHealth> {
    const checkedAt = new Date().toISOString();
    const fail = (reason: string, version?: string): RunnerHealth => ({
      mode: this.mode,
      ok: false,
      reason,
      version,
      checkedAt,
    });

    let version: string;
    try {
      const out = await this.exec(['--version']);
      const match = /(\d+\.\d+\.\d+)/.exec(out);
      if (!match) return fail(`Couldn't read a version from "${this.claudePath} --version": ${out.trim()}`);
      version = match[1];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return fail(
          `The claude CLI was not found at "${this.claudePath}". Install Claude Code, or set claudePath in config.json.`,
        );
      }
      return fail(`"${this.claudePath} --version" failed: ${errorText(err)}`);
    }
    if (compareVersions(version, MIN_CLI_VERSION) < 0) {
      return fail(`claude CLI ${version} is too old; this app needs ${MIN_CLI_VERSION} or newer. Run claude update.`, version);
    }

    let status: AuthStatus;
    try {
      status = JSON.parse(await this.exec(['auth', 'status', '--json'])) as AuthStatus;
    } catch (err) {
      // A signed-out CLI may exit non-zero and still print its status.
      const parsed = parseJson((err as { stdout?: string }).stdout);
      if (!parsed) {
        return fail(`Couldn't check the claude CLI login ("claude auth status" failed): ${errorText(err)}`, version);
      }
      status = parsed as AuthStatus;
    }
    if (!status.loggedIn) {
      return fail('The claude CLI is not signed in. Run claude auth login in a terminal, then try again.', version);
    }
    if (status.apiProvider && status.apiProvider !== 'firstParty') {
      return fail(
        `The claude CLI is configured for ${status.apiProvider}, not your Claude plan, so runs would not use your subscription.`,
        version,
      );
    }
    if (status.authMethod && /api.?key/i.test(status.authMethod)) {
      return fail(
        'The claude CLI is signed in with an API key, not a Claude plan, so runs would be billed to that key. Run claude auth login with your Claude account.',
        version,
      );
    }
    return {
      mode: this.mode,
      ok: true,
      version,
      credentialSource: `claude CLI login (${status.authMethod ?? 'unknown method'})`,
      checkedAt,
    };
  }


  private async exec(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.claudePath, args, {
      env: subscriptionEnv(this.env),
      timeout: 15_000,
    });
    return stdout;
  }
}

/** The SDK wants a path, not a bare command name, so look `claude` up on PATH the way a shell would. */
export function resolveExecutable(command: string, searchPath = ''): string {
  if (command.includes('/') || command.includes('\\')) return path.resolve(command);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return command;
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).split('\n')[0];
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
