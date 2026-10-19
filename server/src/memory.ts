import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '@ccf/shared';

/** The project's memory file: MEMORY.md in its workspace, shared by every session in the project. */
export function memoryPath(project: Project): string {
  return path.join(project.workspacePath, 'MEMORY.md');
}

export function readMemory(project: Project): string {
  try {
    return fs.readFileSync(memoryPath(project), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export function writeMemory(project: Project, text: string): void {
  fs.writeFileSync(memoryPath(project), text.endsWith('\n') || text === '' ? text : `${text}\n`);
}
