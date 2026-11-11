// Internal shell runners do not pass through harness hooks. Preflight the same event explicitly.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../guard/mend_guard.py', import.meta.url));

export class GuardBlockedError extends Error {}

export async function assertGuardAllowed({ command, cwd, guardCwd = cwd, env = process.env }) {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'shell', cwd, tool_input: { command } };
  await new Promise((resolve, reject) => {
    const child = execFile('python3', ['-I', GUARD, '--config-cwd', guardCwd],
      { cwd, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error || stdout.trim() || stderr.trim()) {
          reject(new GuardBlockedError(stderr.trim() || '[MEND-GUARD]: guard preflight failed; command not executed'));
        } else resolve();
      });
    // The completion callback handles a missing runtime or early guard exit; never run the command on error.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event));
  });
}
