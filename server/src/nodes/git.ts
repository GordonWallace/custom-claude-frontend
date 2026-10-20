import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Env = NodeJS.ProcessEnv;

export async function git(cwd: string, args: string[], env: Env): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')}`);
  }
}

async function gitOk(cwd: string, args: string[], env: Env): Promise<string | null> {
  try {
    return await git(cwd, args, env);
  } catch {
    return null;
  }
}

/**
 * Credentials for git as environment only: a credential helper that answers with the token from
 * CCF_GITHUB_TOKEN, set through GIT_CONFIG_COUNT so nothing is written to the node's disk. GH_TOKEN
 * lets the gh CLI use the same token.
 */
export function gitCredentialEnv(githubToken: string | undefined): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (!githubToken) return env;
  return {
    ...env,
    CCF_GITHUB_TOKEN: githubToken,
    GH_TOKEN: githubToken,
    GIT_CONFIG_COUNT: '2',
    // An empty helper first clears any helper the node has configured, for github.com only.
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!f() { echo username=x-access-token; echo "password=$CCF_GITHUB_TOKEN"; }; f',
  };
}

export interface RepoWorkspace {
  workDir: string;
  projectId: string;
  repoUrl: string;
  baseBranch: string | null;
  threadId: string;
  branch: string;
  fresh: boolean;
}

export function repoDir(workDir: string, projectId: string): string {
  return path.join(workDir, 'projects', projectId, 'repo');
}

export function worktreeDir(workDir: string, projectId: string, threadId: string): string {
  return path.join(workDir, 'projects', projectId, 'threads', threadId.slice(0, 8));
}

/** Projects this node has a clone of. */
export function clonedProjects(workDir: string): string[] {
  try {
    return fs.readdirSync(path.join(workDir, 'projects')).filter((p) => fs.existsSync(path.join(repoDir(workDir, p), '.git')));
  } catch {
    return [];
  }
}

/**
 * The thread's own worktree on its branch: reused while the thread stays on this node, otherwise
 * made from the pushed branch if there is one, else from the base branch.
 */
export async function ensureWorktree(ws: RepoWorkspace, env: Env): Promise<string> {
  const repo = repoDir(ws.workDir, ws.projectId);
  const tree = worktreeDir(ws.workDir, ws.projectId, ws.threadId);

  if (!fs.existsSync(path.join(repo, '.git'))) {
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    await git(path.dirname(repo), ['clone', '--no-checkout', ws.repoUrl, repo], env);
  } else {
    await git(repo, ['remote', 'set-url', 'origin', ws.repoUrl], env);
  }
  await git(repo, ['fetch', '--prune', 'origin'], env);

  if (fs.existsSync(tree)) {
    if (!ws.fresh) return fs.realpathSync(tree);
    // Left from an earlier stay on this node; the pushed branch is the truth now. Keep the old copy aside rather than delete it.
    const aside = path.join(ws.workDir, 'stale', `${path.basename(tree)}-${Date.now()}`);
    fs.mkdirSync(path.dirname(aside), { recursive: true });
    fs.renameSync(tree, aside);
    await git(repo, ['worktree', 'prune'], env);
  }

  fs.mkdirSync(path.dirname(tree), { recursive: true });
  const pushed = await gitOk(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ws.branch}`], env);
  if (pushed) {
    await git(repo, ['worktree', 'add', '-B', ws.branch, tree, `origin/${ws.branch}`], env);
  } else {
    const base = await baseRef(repo, ws.baseBranch, env);
    if (base) await git(repo, ['worktree', 'add', '--no-track', '-B', ws.branch, tree, base], env);
    // An empty repository has nothing to branch from.
    else await git(repo, ['worktree', 'add', '--orphan', '-b', ws.branch, tree], env);
  }
  return fs.realpathSync(tree);
}

async function baseRef(repo: string, baseBranch: string | null, env: Env): Promise<string | null> {
  if (baseBranch) return `origin/${baseBranch}`;
  const head = await gitOk(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], env);
  if (head) return head.replace('refs/remotes/', '');
  for (const name of ['main', 'master']) {
    if (await gitOk(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`], env)) return `origin/${name}`;
  }
  return null;
}

/** Pushes the thread's branch when it has commits the remote doesn't. Returns the pushed commit, or null if nothing was new. */
export async function pushIfAhead(tree: string, branch: string, env: Env): Promise<string | null> {
  const head = await gitOk(tree, ['rev-parse', '--verify', '--quiet', 'HEAD'], env);
  if (!head) return null;
  const remote = await gitOk(tree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], env);
  if (remote === head) return null;
  if (!remote) {
    // Nothing pushed yet: only push once the thread has made a commit of its own.
    const upstream = await gitOk(tree, ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin/'], env);
    const onRemote = (upstream ?? '').split('\n').includes(head);
    if (onRemote) return null;
  }
  await git(tree, ['push', 'origin', `HEAD:refs/heads/${branch}`], env);
  await gitOk(tree, ['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`], env);
  return head;
}

/** Commits everything uncommitted as a WIP commit. Returns true if there was anything to commit. */
export async function commitWip(tree: string, message: string, env: Env): Promise<boolean> {
  const status = await git(tree, ['status', '--porcelain'], env);
  if (!status) return false;
  await git(tree, ['add', '-A'], env);
  const identity = (await gitOk(tree, ['config', 'user.email'], env)) ? [] : ['-c', 'user.name=Custom Claude Frontend', '-c', 'user.email=ccf-node@localhost'];
  await git(tree, [...identity, 'commit', '--no-verify', '-m', message], env);
  return true;
}

export async function removeWorktree(workDir: string, projectId: string, tree: string, env: Env): Promise<void> {
  await gitOk(repoDir(workDir, projectId), ['worktree', 'remove', '--force', tree], env);
  if (fs.existsSync(tree)) fs.rmSync(tree, { recursive: true, force: true });
  await gitOk(repoDir(workDir, projectId), ['worktree', 'prune'], env);
}
