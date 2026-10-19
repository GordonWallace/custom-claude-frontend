import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SecretName, SecretStatus } from '@ccf/shared';
import { HttpError } from './errors.js';
import type { Store } from './store.js';

export const SECRET_NAMES: SecretName[] = ['claude_oauth_token', 'anthropic_api_key', 'github_token'];

export function isSecretName(value: string): value is SecretName {
  return (SECRET_NAMES as string[]).includes(value);
}

/**
 * Credentials the orchestrator hands to nodes, encrypted at rest with AES-256-GCM. The key is a
 * file next to the database (secret.key, readable only by its owner), so a copied database alone
 * doesn't give them away. Values never leave through the HTTP API; only nodes get them, per run.
 */
export class SecretStore {
  private readonly key: Buffer;

  constructor(
    private readonly store: Store,
    keyFile: string | null,
  ) {
    this.key = keyFile ? loadOrCreateKey(keyFile) : randomBytes(32);
  }

  status(): SecretStatus[] {
    const rows = new Map(this.store.listSecretRows().map((r) => [r.name, r]));
    return SECRET_NAMES.map((name) => ({ name, set: rows.has(name), updatedAt: rows.get(name)?.updated_at ?? null }));
  }

  get(name: SecretName): string | undefined {
    const row = this.store.getSecretRow(name);
    if (!row) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      // The key file was replaced: the stored value can't be read and has to be entered again.
      return undefined;
    }
  }

  set(name: string, value: string): SecretStatus[] {
    if (!isSecretName(name)) throw new HttpError(404, `Unknown credential ${name}. Use one of: ${SECRET_NAMES.join(', ')}.`);
    if (typeof value !== 'string') throw new HttpError(400, 'Send { "value": "..." }; an empty value removes it.');
    const trimmed = value.trim();
    if (!trimmed) {
      this.store.deleteSecretRow(name);
      return this.status();
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
    this.store.putSecretRow({
      name,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
    return this.status();
  }
}

function loadOrCreateKey(file: string): Buffer {
  if (fs.existsSync(file)) {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length === 32) return key;
    throw new Error(`${file} is not a valid key (expected 32 bytes, base64). Move it aside to start over; stored credentials will need entering again.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(32);
  fs.writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600 });
  return key;
}
