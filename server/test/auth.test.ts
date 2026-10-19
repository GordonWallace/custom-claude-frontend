import { afterEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

const TAILNET = '100.101.102.103';

describe('remote access', () => {
  it('lets the orchestrator machine in without a login', async () => {
    ctx = await setup({ access: { remoteAccess: true, allowedNetworks: [] } });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/projects', remoteAddress: '::1' })).statusCode).toBe(200);
  });

  it('turns away addresses outside Tailscale and the configured networks', async () => {
    ctx = await setup({ access: { remoteAccess: true, allowedNetworks: ['192.168.1.0/24'] } });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/projects', remoteAddress: '203.0.113.9' })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/status', remoteAddress: '::ffff:192.168.1.20' })).statusCode).toBe(200);
  });

  it('requires the password from other devices, and keeps a session cookie', async () => {
    ctx = await setup({ access: { remoteAccess: true, allowedNetworks: [] } });
    const remote = (url: string, extra: Record<string, unknown> = {}) =>
      ctx!.app.inject({ method: 'GET', url, remoteAddress: TAILNET, ...extra });

    // No password yet: remote use is refused with a reason, and only the orchestrator can set one.
    expect((await remote('/api/projects')).json()).toMatchObject({ error: 'login_unavailable' });
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/auth/password', remoteAddress: TAILNET, payload: { password: 'hunter22' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/auth/password', payload: { password: 'short' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/auth/password', payload: { password: 'correct horse' } })).statusCode).toBe(200);

    expect((await remote('/api/projects')).statusCode).toBe(401);
    expect((await remote('/api/auth/status')).json()).toMatchObject({ passwordSet: true, loopback: false, authenticated: false });
    const wrong = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: TAILNET, payload: { password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: TAILNET, payload: { password: 'correct horse' } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect(String(login.headers['set-cookie'])).toContain('HttpOnly');
    expect((await remote('/api/projects', { headers: { cookie } })).statusCode).toBe(200);

    // Node and session endpoints carry their own tokens.
    expect((await remote('/api/nodes/install.sh')).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/mcp', remoteAddress: TAILNET, payload: {} })).statusCode).toBe(401);

    // A new password signs everyone out.
    await ctx.app.inject({ method: 'PUT', url: '/api/auth/password', payload: { password: 'battery staple' } });
    expect((await remote('/api/projects', { headers: { cookie } })).statusCode).toBe(401);
  }, 10_000);
});

describe('the Add node command', () => {
  const pairing = async (headers: Record<string, string> = {}) =>
    (await ctx!.app.inject({ method: 'POST', url: '/api/nodes/pairing', headers })).json<{ url: string; setup?: string[]; note?: string }>();

  it('explains how to turn on remote access instead of offering a localhost command', async () => {
    ctx = await setup({ access: { remoteAccess: false, allowedNetworks: [] } });
    const p = await pairing();
    expect(p.setup?.[0]).toContain('"remoteAccess": true');
  });

  it('uses the address the app was opened by when other machines can use it', async () => {
    ctx = await setup({ access: { remoteAccess: true, allowedNetworks: [] } });
    const p = await pairing({ host: 'orchestrator.tail1234.ts.net:4317' });
    expect(p.url).toBe('http://orchestrator.tail1234.ts.net:4317');
    expect(p.setup).toBeUndefined();
  });

  it("picks this machine's Tailscale address over a LAN one in allowedNetworks", async () => {
    ctx = await setup({ access: { remoteAccess: true, allowedNetworks: ['192.168.1.0/24'] } });
    const nic = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }) as never;
    expect(ctx.access!.ownAddress({ lo: [nic('127.0.0.1', true)], eth0: [nic('192.168.1.5')], tailscale0: [nic(TAILNET)] })).toEqual({ address: TAILNET, tailscale: true });
    expect(ctx.access!.ownAddress({ eth0: [nic('10.0.0.5'), nic('192.168.1.5')] })).toEqual({ address: '192.168.1.5', tailscale: false });
    expect(ctx.access!.ownAddress({ eth0: [nic('10.0.0.5')] })).toBeNull();
  });
});
