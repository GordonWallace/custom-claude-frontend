import fs from 'node:fs';
import os from 'node:os';
import type { NodeResources } from '@ccf/shared';

export function readResources(dir: string): NodeResources {
  let diskTotal = 0;
  let diskFree = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const s = fs.statfsSync(dir);
    diskTotal = s.blocks * s.bsize;
    diskFree = s.bavail * s.bsize;
  } catch {
    // Not every platform reports it.
  }
  return {
    cpus: os.cpus().length,
    load1: os.loadavg()[0],
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    diskTotal,
    diskFree,
  };
}
