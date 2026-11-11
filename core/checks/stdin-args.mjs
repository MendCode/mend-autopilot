// Workflow transport: CLI arguments and the frozen policy arrive as one stdin envelope.
// Direct CLI invocations retain their original argument forms.
import { readFileSync } from 'node:fs';

export function stdinArgs(argv) {
  if (!argv.includes('--stdin')) return argv;
  if (argv.length !== 1) throw new Error('--stdin cannot be combined with CLI arguments');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string')) throw new Error('stdin requires a string args array');
  // Existing policy consumers (including child checks) use this process-local binding.
  // This is not a shell environment prefix; the snapshot crosses check() via stdin.
  if (input.policy) process.env.MEND_REVIEW_POLICY = JSON.stringify(input.policy);
  else delete process.env.MEND_REVIEW_POLICY;
  return input.args;
}
