import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CliRunner, compareVersions, subscriptionEnv } from '../src/runners/cliRunner.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccf-cli-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Writes a fake claude executable that prints `version` and answers `auth status` with `auth`. */
function fakeClaude(name: string, version: string, auth: string, authExit = 0): string {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi
if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"loggedIn":true,"authMethod":"api_key"}'; exit 0; fi
echo '${auth}'; exit ${authExit}
`,
    { mode: 0o755 },
  );
  return file;
}

const signedIn = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}';

describe('subscriptionEnv', () => {
  it('removes API credentials and provider switches, keeps everything else', () => {
    const env = subscriptionEnv({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'sk',
      ANTHROPIC_AUTH_TOKEN: 't',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'keep',
    });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'keep' });
  });
});

describe('CliRunner.health', () => {
  it('is healthy for a signed-in CLI, even with ANTHROPIC_API_KEY in the parent env', async () => {
    const runner = new CliRunner(fakeClaude('ok', '2.1.0', signedIn), { PATH: '/bin', ANTHROPIC_API_KEY: 'sk' });
    expect(await runner.health()).toMatchObject({
      ok: true,
      version: '2.1.0',
      credentialSource: 'claude CLI login (claude.ai)',
    });
  });

  it('explains a missing binary', async () => {
    const h = await new CliRunner(path.join(dir, 'missing')).health();
    expect(h.ok).toBe(false);
    expect(h.reason).toMatch(/not found/);
  });

  it('explains a signed-out CLI that exits non-zero', async () => {
    const h = await new CliRunner(fakeClaude('out', '2.1.0', '{"loggedIn":false}', 1)).health();
    expect(h).toMatchObject({ ok: false, version: '2.1.0' });
    expect(h.reason).toMatch(/not signed in/);
  });

  it('refuses a CLI older than the minimum version', async () => {
    const h = await new CliRunner(fakeClaude('old', '1.0.99', signedIn)).health();
    expect(h.ok).toBe(false);
    expect(h.reason).toMatch(/too old/);
  });

  it('refuses a CLI signed in with an API key or another provider', async () => {
    const key = await new CliRunner(fakeClaude('key', '2.1.0', '{"loggedIn":true,"authMethod":"api_key"}')).health();
    expect(key.reason).toMatch(/API key/);
    const bedrock = await new CliRunner(
      fakeClaude('bedrock', '2.1.0', '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"bedrock"}'),
    ).health();
    expect(bedrock.reason).toMatch(/bedrock/);
  });
});

describe('compareVersions', () => {
  it('orders numerically', () => {
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('1.9.0', '2.0.0')).toBeLessThan(0);
  });
});
