import { describe, expect, it } from 'vitest';
import { ApiRunner } from '../src/runners/apiRunner.js';

describe('ApiRunner.health', () => {
  it('fails without ANTHROPIC_API_KEY', async () => {
    const h = await new ApiRunner({}).health();
    expect(h.ok).toBe(false);
    expect(h.reason).toMatch(/No API key/);
    expect(h.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is healthy with a key and names its source', async () => {
    const h = await new ApiRunner({ ANTHROPIC_API_KEY: 'sk-test' }).health();
    expect(h).toMatchObject({ ok: true, credentialSource: 'ANTHROPIC_API_KEY (environment)' });
  });
});
