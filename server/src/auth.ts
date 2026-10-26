import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthStatus } from '@ccf/shared';
import type { Settings } from './db.js';
import { HttpError } from './errors.js';
import { hashToken } from './nodes/hub.js';
import type { Store } from './store.js';

const COOKIE = 'ccf_session';
const SESSION_DAYS = 30;
const PASSWORD_KEY = 'auth.password';

/** Tailscale's address ranges: every device on a tailnet gets one of these. */
const TAILSCALE: [string, number, 'ipv4' | 'ipv6'][] = [
  ['100.64.0.0', 10, 'ipv4'],
  ['fd7a:115c:a1e0::', 48, 'ipv6'],
];

/** Paths a node or a session calls without a login: each carries its own token, or hands one out. */
const OPEN_PATHS = ['/mcp', '/api/hooks/', '/api/nodes/connect', '/api/nodes/pair', '/api/nodes/install.sh', '/api/nodes/worker/', '/api/auth/status', '/api/auth/login', '/api/auth/logout'];

export interface AccessOptions {
  /** Listen beyond localhost, for clients and nodes on the tailnet. */
  remoteAccess: boolean;
  /** Extra networks to accept, in CIDR form (e.g. a home LAN without Tailscale). */
  allowedNetworks: string[];
}

/**
 * Remote access (M5). The orchestrator's own machine never logs in. When the server listens beyond
 * localhost, it accepts only Tailscale addresses (plus any configured networks), and everything
 * under /api needs the single user's password, kept as a session cookie. The built UI itself is
 * public so the login page can load.
 */
export class Access {
  private readonly networks = new net.BlockList();

  constructor(
    private readonly store: Store,
    private readonly settings: Settings,
    private readonly opts: AccessOptions,
  ) {
    for (const [addr, prefix, type] of TAILSCALE) this.networks.addSubnet(addr, prefix, type);
    for (const cidr of opts.allowedNetworks) {
      const [addr, prefix] = cidr.split('/');
      const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
      this.networks.addSubnet(addr, Number(prefix ?? (type === 'ipv6' ? 128 : 32)), type);
    }
  }

  get remoteAccess(): boolean {
    return this.opts.remoteAccess;
  }

  /**
   * An address of this machine that other machines may reach and this server accepts: its
   * Tailscale IPv4 address if it has one, else one in allowedNetworks. Null when there's neither.
   */
  ownAddress(interfaces = os.networkInterfaces()): { address: string; tailscale: boolean } | null {
    const tailnet = new net.BlockList();
    tailnet.addSubnet(TAILSCALE[0][0], TAILSCALE[0][1], 'ipv4');
    let fallback: string | null = null;
    for (const list of Object.values(interfaces)) {
      for (const i of list ?? []) {
        if (i.internal || i.family !== 'IPv4') continue;
        if (tailnet.check(i.address, 'ipv4')) return { address: i.address, tailscale: true };
        if (!fallback && this.isAllowedNetwork(i.address)) fallback = i.address;
      }
    }
    return fallback ? { address: fallback, tailscale: false } : null;
  }

  isLoopback(addr: string): boolean {
    const a = normalize(addr);
    return a === '::1' || a.startsWith('127.');
  }

  isAllowedNetwork(addr: string): boolean {
    const a = normalize(addr);
    return this.networks.check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4');
  }

  passwordSet(): boolean {
    return Boolean(this.settings.get(PASSWORD_KEY));
  }

  setPassword(password: string): void {
    if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.');
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 32);
    this.settings.set(PASSWORD_KEY, `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`);
    // A new password signs every other device out.
    this.store.deleteAllAuthSessions();
  }

  verify(password: string): boolean {
    const stored = this.settings.get(PASSWORD_KEY);
    if (!stored || typeof password !== 'string') return false;
    const [, salt, hash] = stored.split('$');
    const expected = Buffer.from(hash, 'base64');
    const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
    return timingSafeEqual(actual, expected);
  }

  private session(req: FastifyRequest): string | undefined {
    const cookie = req.headers.cookie ?? '';
    return cookie
      .split(';')
      .map((c) => c.trim().split('='))
      .find(([k]) => k === COOKIE)?.[1];
  }

  authenticated(req: FastifyRequest): boolean {
    const token = this.session(req);
    return Boolean(token && this.store.authSessionValid(hashToken(token)));
  }

  status(req: FastifyRequest): AuthStatus {
    return {
      remoteAccess: this.opts.remoteAccess,
      passwordSet: this.passwordSet(),
      loopback: this.isLoopback(req.socket.remoteAddress ?? ''),
      authenticated: this.authenticated(req),
    };
  }

  register(app: FastifyInstance): void {
    app.addHook('onRequest', async (req, reply) => {
      const addr = req.socket.remoteAddress ?? '';
      if (this.isLoopback(addr)) return;
      if (!this.isAllowedNetwork(addr)) {
        return reply.status(403).send({ error: 'This server only accepts connections from its own machine and your Tailscale network.' });
      }
      const url = req.url.split('?')[0];
      if (!url.startsWith('/api/') && url !== '/mcp') return;
      if (OPEN_PATHS.some((p) => url === p || (p.endsWith('/') && url.startsWith(p)))) return;
      if (!this.passwordSet()) {
        return reply.status(403).send({ error: 'login_unavailable', reason: 'Set a password on the orchestrator machine first, under Settings › Remote access.' });
      }
      if (!this.authenticated(req)) return reply.status(401).send({ error: 'login_required' });
    });

    app.get('/api/auth/status', async (req) => this.status(req));

    app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
      if (!this.passwordSet()) throw new HttpError(400, 'No password is set. Set one on the orchestrator machine, under Settings › Remote access.');
      if (!this.verify(req.body?.password ?? '')) {
        // Slows guessing down.
        await new Promise((r) => setTimeout(r, 1000));
        throw new HttpError(401, 'Wrong password.');
      }
      const token = randomBytes(32).toString('base64url');
      this.store.addAuthSession(hashToken(token), new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString());
      setCookie(reply, `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
      return this.status(req);
    });

    app.post('/api/auth/logout', async (req, reply) => {
      const token = this.session(req);
      if (token) this.store.deleteAuthSession(hashToken(token));
      setCookie(reply, `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      return { ok: true };
    });

    // Behind the hook above: only this machine, or a device that's already logged in, can change it.
    app.put<{ Body: { password?: string } }>('/api/auth/password', async (req) => {
      this.setPassword(req.body?.password as string);
      return { ok: true };
    });
  }
}

function setCookie(reply: FastifyReply, value: string): void {
  reply.header('set-cookie', value);
}

/** IPv4 clients of a dual-stack socket show up as ::ffff:a.b.c.d. */
function normalize(addr: string): string {
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}
