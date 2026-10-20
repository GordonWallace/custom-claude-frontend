// Bundles the worker into one file the orchestrator serves to nodes (dist/worker.mjs). The Agent SDK
// stays external: install.sh installs it on the node, with the Claude Code binary for its platform.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export async function buildWorker() {
  const { build } = await import('esbuild');
  const { version } = JSON.parse(fs.readFileSync(here('./package.json'), 'utf8'));
  await build({
    entryPoints: [here('./src/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: here('./dist/worker.mjs'),
    external: ['@anthropic-ai/claude-agent-sdk'],
    define: { WORKER_VERSION: JSON.stringify(version) },
    logLevel: 'warning',
  });
  return here('./dist/worker.mjs');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildWorker();
}
