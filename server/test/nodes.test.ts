import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeView, Project, Thread } from '@ccf/shared';
import { NodeAgent } from '../src/nodes/agent.js';
import { webSocketLink } from '../src/nodes/protocol.js';
import { transcriptPath } from '../src/nodes/transcripts.js';
import type { RunConfig } from '../src/runners/types.js';
import { FakeRunner, LOCAL_INFO, type Script, setup, until } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await ctx?.app.close();
  ctx = undefined;
});

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();

/** A bare repo with one commit on main, standing in for GitHub. */
function bareRepo(dir: string): string {
  const bare = path.join(dir, 'remote.git');
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed);
  sh(dir, 'init', '--bare', '-b', 'main', bare);
  sh(seed, 'init', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-m', 'first');
  sh(seed, 'push', bare, 'main');
  return bare;
}

/** A Claude stand-in that writes a transcript line per turn and, when asked, a file (committed or not). */
const workingScript =
  (sessionId: string): Script =>
  async function* (cfg: RunConfig, message: string) {
    const env = { ...process.env, ...cfg.env };
    yield { type: 'init', sessionId, model: 'm', mode: 'subscription' };
    const file = transcriptPath(cfg.cwd, sessionId, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ cwd: cfg.cwd, message }) + '\n');
    const commit = /commit (\S+)/.exec(message)?.[1];
    const leave = /leave (\S+)/.exec(message)?.[1];
    if (commit) {
      fs.writeFileSync(path.join(cfg.cwd, commit), `${commit}\n`);
      execFileSync('git', ['add', '.'], { cwd: cfg.cwd, env });
      execFileSync('git', ['commit', '-m', `add ${commit}`], { cwd: cfg.cwd, env });
    }
    if (leave) fs.writeFileSync(path.join(cfg.cwd, leave), 'unfinished\n');
    yield { type: 'result', ok: true, finalText: `did ${message.split('\n').at(-1)}` };
  };

async function listen(c: Ctx): Promise<string> {
  if (!c.app.server.listening) await c.app.listen({ host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${(c.app.server.address() as AddressInfo).port}`;
}

/** Pairs and connects a second node over a real WebSocket, as the worker does. */
async function remoteNode(c: Ctx, name: string) {
  const url = await listen(c);
  const code = (await c.app.inject({ method: 'POST', url: '/api/nodes/pairing' })).json<{ code: string }>().code;
  const paired = await c.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code, name } });
  const { nodeId, token } = paired.json<{ nodeId: string; token: string }>();
  const runner = new FakeRunner('subscription');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(c.dir, `claude-${name}`) };
  const agent = new NodeAgent({ workDir: path.join(c.dir, `work-${name}`), baseUrl: () => url, runners: { subscription: runner, api: new FakeRunner('api') }, env });
  const connect = async () => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/api/nodes/connect`);
    sockets.push(ws);
    await new Promise((r) => ws.addEventListener('open', r));
    const link = webSocketLink(ws);
    agent.attach(link);
    link.send(agent.hello(token, 'test', { ...LOCAL_INFO, hostname: name }));
    await until(() => c.nodes.isOnline(nodeId));
    return ws;
  };
  const ws = await connect();
  return { nodeId, token, runner, agent, env, ws, connect };
}

async function repoProject(c: Ctx): Promise<Project> {
  const bare = bareRepo(c.dir);
  const res = await c.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Demo', repoUrl: bare } });
  expect(res.statusCode).toBe(201);
  return res.json<Project>();
}

const nodeView = async (c: Ctx, id: string) => (await c.app.inject({ method: 'GET', url: '/api/nodes' })).json<NodeView[]>().find((n) => n.id === id)!;
const send = (c: Ctx, threadId: string, text: string) => c.app.inject({ method: 'POST', url: `/api/threads/${threadId}/messages`, payload: { text } });
const thread = (c: Ctx, id: string): Thread => c.store.getThread(id)!;
const settled = (c: Ctx, id: string) => until(() => thread(c, id).status === 'idle' && !c.store.hasQueuedInput(id), 5000);

describe('nodes', () => {
  it('pairs a node with a one-time code, connects it and shows it online', async () => {
    ctx = await setup({ mode: 'subscription' });
    const node = await remoteNode(ctx, 'pi-1');
    const view = await nodeView(ctx, node.nodeId);
    expect(view).toMatchObject({ name: 'pi-1', local: false, state: 'enabled', online: true, threadLimit: 2, info: { hostname: 'pi-1' } });
    expect(view.resources?.cpus).toBeGreaterThan(0);

    // Codes work once.
    const again = await ctx.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: 'NOPE', name: 'x' } });
    expect(again.statusCode).toBe(403);
    // The token is stored only as a hash.
    expect(JSON.stringify(ctx.store.getNode(node.nodeId))).not.toContain(node.token);
  });

  it('runs a repo thread on a node in its own worktree, pushes its commits and keeps its transcript', async () => {
    ctx = await setup({ mode: 'subscription' });
    const p = await repoProject(ctx);
    await ctx.app.inject({ method: 'PATCH', url: `/api/nodes/${ctx.nodes.localNodeId}`, payload: { action: 'stop' } });
    const node = await remoteNode(ctx, 'pi-1');
    node.runner.script = workingScript('sess-a');

    const t = ctx.threads.createThread(p.id);
    await send(ctx, t.id, 'commit hello.txt');
    await settled(ctx, t.id);

    const branch = `thread/${t.id.slice(0, 8)}`;
    expect(thread(ctx, t.id)).toMatchObject({ nodeId: node.nodeId, claudeSessionId: 'sess-a' });
    expect(thread(ctx, t.id).worktreePath).toContain(`work-pi-1`);
    expect(sh(ctx.dir, '--git-dir', path.join(ctx.dir, 'remote.git'), 'log', '--format=%s', branch)).toBe('add hello.txt\nfirst');
    await until(() => ctx!.store.listMessages(t.id).some((m) => m.kind === 'git_push'));
    expect(fs.readFileSync(path.join(ctx.dir, 'transcripts', t.id, 'sess-a.jsonl'), 'utf8')).toContain('commit hello.txt');
    expect((await nodeView(ctx, node.nodeId)).threads.map((x) => x.id)).toEqual([t.id]);

    // The node got the run's MCP server at its own URL for the orchestrator.
    expect(node.runner.calls[0].cfg.mcpServers[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('stops placing threads on a disabled node', async () => {
    ctx = await setup({ mode: 'subscription' });
    const p = await repoProject(ctx);
    await ctx.app.inject({ method: 'PATCH', url: `/api/nodes/${ctx.nodes.localNodeId}`, payload: { action: 'stop' } });
    const node = await remoteNode(ctx, 'pi-1');
    await ctx.app.inject({ method: 'PATCH', url: `/api/nodes/${node.nodeId}`, payload: { action: 'stop' } });
    const t = ctx.threads.createThread(p.id);
    await send(ctx, t.id, 'hello');
    await new Promise((r) => setTimeout(r, 100));
    expect(thread(ctx, t.id).status).toBe('queued');
    await ctx.app.inject({ method: 'PATCH', url: `/api/nodes/${node.nodeId}`, payload: { action: 'enable' } });
    await settled(ctx, t.id);
    expect(thread(ctx, t.id).nodeId).toBe(node.nodeId);
  });

  it('says why a node can\'t run Subscription threads without a token or its own login', async () => {
    ctx = await setup({ mode: 'subscription' });
    const url = await listen(ctx);
    void url;
    const node = await remoteNode(ctx, 'pi-1');
    node.agent; // connected with claudeLoggedIn true
    expect((await nodeView(ctx, node.nodeId)).ready.subscription.ok).toBe(true);
    ctx.store.updateNode(node.nodeId, { info_json: JSON.stringify({ ...LOCAL_INFO, claudeLoggedIn: false }) });
    node.ws.close();
    await until(() => !ctx!.nodes.isOnline(node.nodeId));
    expect((await nodeView(ctx, node.nodeId)).ready.subscription).toMatchObject({ ok: false, reason: expect.stringContaining('No Claude token') });
    ctx.secrets.set('claude_oauth_token', 'tok');
    expect((await nodeView(ctx, node.nodeId)).ready.subscription.ok).toBe(true);
  });
});

describe('handoff', () => {
  async function onRemote(c: Ctx) {
    const p = await repoProject(c);
    await c.app.inject({ method: 'PATCH', url: `/api/nodes/${c.nodes.localNodeId}`, payload: { action: 'stop' } });
    const node = await remoteNode(c, 'pi-1');
    node.runner.script = workingScript('sess-h');
    c.runners.subscription.script = workingScript('sess-h');
    const t = c.threads.createThread(p.id);
    return { p, node, t };
  }

  it('drains a node: unfinished work is pushed as WIP and the thread continues on another node', async () => {
    ctx = await setup({ mode: 'subscription' });
    const { node, t } = await onRemote(ctx);
    await send(ctx, t.id, 'commit a.txt leave b.txt');
    await settled(ctx, t.id);

    await ctx.app.inject({ method: 'PATCH', url: `/api/nodes/${node.nodeId}`, payload: { action: 'drain' } });
    await until(() => thread(ctx!, t.id).nodeId === null, 5000);
    expect(ctx.store.getNode(node.nodeId)!.state).toBe('disabled');
    const branch = `thread/${t.id.slice(0, 8)}`;
    expect(sh(ctx.dir, '--git-dir', path.join(ctx.dir, 'remote.git'), 'log', '--format=%s', branch).split('\n')[0]).toBe('WIP: handing off from pi-1');

    await ctx.app.inject({ method: 'PATCH', url: `/api/nodes/${ctx.nodes.localNodeId}`, payload: { action: 'enable' } });
    await send(ctx, t.id, 'carry on');
    await settled(ctx, t.id);
    const local = ctx.runners.subscription.calls[0];
    expect(thread(ctx, t.id).nodeId).toBe(ctx.nodes.localNodeId);
    expect(local).toMatchObject({ kind: 'resume', sessionId: 'sess-h' });
    expect(local.message).toMatch(/^\[Moved\] This thread moved from node pi-1 to node this machine/);
    expect(local.message).toContain('WIP commit');
    // Same branch, with the WIP commit, and the transcript restored before resuming.
    expect(fs.readFileSync(path.join(local.cfg.cwd, 'b.txt'), 'utf8')).toBe('unfinished\n');
    expect(fs.readFileSync(transcriptPath(local.cfg.cwd, 'sess-h', { CLAUDE_CONFIG_DIR: path.join(ctx.dir, 'claude-local') }), 'utf8')).toContain('commit a.txt');
    expect(ctx.store.listMessages(t.id).some((m) => m.kind === 'node_moved' && m.text === 'Moved from pi-1 to this machine')).toBe(true);
  });

  it('stops a node now: interrupts the turn, hands off and continues elsewhere', async () => {
    ctx = await setup({ mode: 'subscription' });
    const { node, t } = await onRemote(ctx);
    let started = false;
    node.runner.script = async function* (cfg) {
      started = true;
      fs.writeFileSync(path.join(cfg.cwd, 'half.txt'), 'half\n');
      await new Promise((r) => setTimeout(r, 60_000));
      yield { type: 'result', ok: true, finalText: '' };
    };
    // The fake's interrupt doesn't end its stream, so end the run the way the CLI would.
    const fake = node.runner;
    const original = fake.start.bind(fake);
    fake.start = (cfg, message) => {
      const handle = original(cfg, message);
      let stop!: () => void;
      const stopped = new Promise<void>((r) => (stop = r));
      const events = handle.events[Symbol.asyncIterator]();
      return {
        ...handle,
        interrupt: async () => stop(),
        events: (async function* () {
          const first = events.next();
          await Promise.race([first, stopped]);
          yield { type: 'result' as const, ok: false, finalText: 'Interrupted' };
        })(),
      };
    };
    await send(ctx, t.id, 'work');
    await until(() => started);
    await ctx.app.inject({ method: 'PATCH', url: `/api/nodes/${ctx.nodes.localNodeId}`, payload: { action: 'enable' } });
    await ctx.app.inject({ method: 'PATCH', url: `/api/nodes/${node.nodeId}`, payload: { action: 'stop' } });
    await until(() => ctx!.runners.subscription.calls.length === 1, 5000);
    await settled(ctx, t.id);
    expect(ctx.runners.subscription.calls[0].message).toMatch(/Continue where you left off\.$/);
    expect(fs.existsSync(path.join(ctx.runners.subscription.calls[0].cfg.cwd, 'half.txt'))).toBe(true);
    expect(ctx.store.listMessages(t.id).some((m) => m.kind === 'run_ended' && m.text === 'Stopped to move off pi-1')).toBe(true);
  });

  it('resumes a thread elsewhere when its node drops mid-turn', async () => {
    ctx = await setup({ mode: 'subscription' });
    const { node, t } = await onRemote(ctx);
    await send(ctx, t.id, 'commit a.txt');
    await settled(ctx, t.id);
    let started = false;
    node.runner.script = async function* () {
      started = true;
      await new Promise((r) => setTimeout(r, 60_000));
      yield { type: 'result', ok: true, finalText: '' };
    };
    await send(ctx, t.id, 'more');
    await until(() => started);
    await ctx.app.inject({ method: 'PATCH', url: `/api/nodes/${ctx.nodes.localNodeId}`, payload: { action: 'enable' } });
    node.ws.close();
    await until(() => ctx!.runners.subscription.calls.length === 1, 5000);
    await settled(ctx, t.id);
    const resumed = ctx.runners.subscription.calls[0];
    expect(resumed).toMatchObject({ kind: 'resume', sessionId: 'sess-h' });
    expect(resumed.message).toContain("pi-1 went offline mid-turn, so anything it hadn't committed and pushed may be lost");
    // The interrupted turn never reached the stored transcript, so its request is sent again.
    expect(resumed.message).toMatch(/This was the request:\n\nmore$/);
    expect(fs.existsSync(path.join(resumed.cfg.cwd, 'a.txt'))).toBe(true);
    expect(ctx.store.listMessages(t.id).some((m) => m.text === 'Cut off: pi-1 went offline')).toBe(true);
  });
});

describe('credentials', () => {
  it('stores credentials encrypted and never returns them', async () => {
    ctx = await setup({ mode: 'subscription' });
    const put = await ctx.app.inject({ method: 'PUT', url: '/api/secrets/github_token', payload: { value: 'ghp_secret123' } });
    expect(put.json()).toContainEqual(expect.objectContaining({ name: 'github_token', set: true }));
    expect(put.body).not.toContain('ghp_secret123');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/secrets' })).body).not.toContain('ghp_secret123');
    expect(JSON.stringify(ctx.store.getSecretRow('github_token'))).not.toContain('ghp_secret123');
    expect(ctx.secrets.get('github_token')).toBe('ghp_secret123');
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/secrets/nope', payload: { value: 'x' } })).statusCode).toBe(404);
    await ctx.app.inject({ method: 'PUT', url: '/api/secrets/github_token', payload: { value: '' } });
    expect(ctx.secrets.get('github_token')).toBeUndefined();
  });

  it('sends a node the Claude token and git credentials with each run', async () => {
    ctx = await setup({ mode: 'subscription' });
    const p = await repoProject(ctx);
    ctx.secrets.set('claude_oauth_token', 'oauth-tok');
    ctx.secrets.set('github_token', 'gh-tok');
    await ctx.app.inject({ method: 'PATCH', url: `/api/nodes/${ctx.nodes.localNodeId}`, payload: { action: 'stop' } });
    const node = await remoteNode(ctx, 'pi-1');
    const t = ctx.threads.createThread(p.id);
    await send(ctx, t.id, 'hi');
    await settled(ctx, t.id);
    const env = node.runner.calls[0].cfg.env!;
    expect(env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok', CCF_GITHUB_TOKEN: 'gh-tok', GIT_CONFIG_COUNT: '2' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // Nothing of it lands in the node's work directory.
    const grep = () => execFileSync('grep', ['-rl', 'oauth-tok', path.join(ctx!.dir, 'work-pi-1')], { encoding: 'utf8' });
    expect(grep).toThrow(); // grep exits 1 when nothing matches
  });
});
