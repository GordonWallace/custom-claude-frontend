import type { ApprovalPolicy } from '@ccf/shared';
import type { PermissionRequest } from './runners/types.js';

/** Tools that are questions for the user, not actions, so they always reach the UI. */
const ALWAYS_ASK = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Shell commands that still ask under the "auto" policy: anything that deletes recursively,
 * rewrites git history or remote branches, runs as root, pipes a download into a shell,
 * or touches the machine itself.
 */
const RISKY_COMMANDS: [RegExp, string][] = [
  [/\bsudo\b|\bsu\s+-?\w*\s*$|\bdoas\b/, 'runs as root'],
  [/\brm\s+(-\w*[rR]\w*|--recursive)\b/, 'deletes recursively'],
  [/\bgit\s+push\b.*(\s-f\b|--force|\s\+\S)/, 'force-pushes'],
  [/\bgit\s+push\b.*(--delete|\s-d\b|\s:\S)/, 'deletes a remote branch'],
  [/\bgit\s+(reset\s+--hard\b|clean\s+-\w*f|filter-branch\b|filter-repo\b)/, 'discards git history or files'],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node)\b/, 'runs a downloaded script'],
  [/\b(mkfs|fdisk|parted|dd\s+.*\bof=)/, 'writes to a disk'],
  [/\b(shutdown|reboot|poweroff|halt)\b|\bsystemctl\s+(stop|disable|mask|poweroff|reboot)\b/, 'stops services or the machine'],
  [/\bchmod\s+(-\w*R|--recursive)|\bchown\s+(-\w*R|--recursive)/, 'changes permissions recursively'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, 'publishes a package'],
  [/>\s*\/dev\/(sd|nvme|mmcblk)|>\s*\/etc\//, 'overwrites system files'],
];

/**
 * Whether a tool call can be approved without asking, under the chosen policy.
 * Returns why it still needs the user when it does, so the approval card can say so.
 */
export function autoApproval(policy: ApprovalPolicy, req: Pick<PermissionRequest, 'toolName' | 'input'>): { allow: true } | { allow: false; reason?: string } {
  if (policy === 'ask' || ALWAYS_ASK.has(req.toolName)) return { allow: false };
  if (policy === 'all') return { allow: true };
  if (req.toolName === 'Bash') {
    const command = typeof req.input.command === 'string' ? req.input.command : '';
    for (const [pattern, why] of RISKY_COMMANDS) {
      if (pattern.test(command)) return { allow: false, reason: `Auto-approve skipped this because it ${why}.` };
    }
  }
  return { allow: true };
}
