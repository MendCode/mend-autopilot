// The bug is reproduced by a command that fails at base and passes at head, measured here rather than
// taken from the card. Thin adapter over core/checks/red-green.mjs, which runs both sides in throwaway worktrees.
import { authorizedTests, RedGreenBlockedError, runRedGreen } from '../../../checks/red-green.mjs';
import { readCard } from '../../../checks/repo-read.mjs';

const TARGET = '(regression command)';

function fail(failures, rule, detail) {
  failures.push({ target: TARGET, rule, detail });
}

/** The regression command the item declared, or the one written on its card. */
export function regressionCommand({ item, card }) {
  const declared = [item?.regressionCommand, item?.regression, card?.redGreen?.command]
    .find((value) => typeof value === 'string' && value.trim() !== '');
  return declared === undefined ? null : declared.trim();
}

/**
 * command: the declared regression command or null.
 * outcome: { baseExit, headExit, timedOut?, blocked?, reason? } as measured, or null when nothing ran.
 * claimed: the card's redGreen block, compared with what was measured.
 */
export function evaluate({ command, keep, outcome, claimed }) {
  const failures = [];
  if (command === null) {
    fail(failures, 'regression-command-missing', 'no regressionCommand on the item and no redGreen.command on the card; a bugfix needs a command that shows the bug');
    return { pass: false, failures };
  }
  if (outcome?.blocked) {
    fail(failures, 'red-green-blocked', `BLOCKED: ${outcome.reason ?? 'the command could not be run at base and head'}`);
    return { pass: false, blocked: true, failures };
  }
  if (outcome?.timedOut) {
    fail(failures, 'red-green-timeout', `${command} timed out, so neither side proves anything; make the command shorter or raise the timeout`);
    return { pass: false, failures };
  }
  if (outcome.baseExit === 0) fail(failures, 'not-red-at-base', `${command} passes at base, so it does not reproduce the bug`);
  else if (outcome.baseMatched === false) fail(failures, 'not-red-for-the-bug', `${command} fails at base, but its log does not match the expected failure /${outcome.expectBase}/`);
  if (outcome.headExit !== 0) fail(failures, 'not-green-at-head', `${command} still fails at head (exit ${outcome.headExit})`);
  if (keep !== undefined && keep !== null) {
    if (outcome.keep?.baseExit !== 0) fail(failures, 'keep-not-green-at-base', `${keep} does not pass at base`);
    if (outcome.keep?.headExit !== 0) fail(failures, 'keep-not-green-at-head', `${keep} does not pass at head`);
  }
  if (claimed && (claimed.command !== command || claimed.baseExit !== outcome.baseExit || claimed.headExit !== outcome.headExit || (keep != null && (claimed.keep?.command !== keep || claimed.keep?.baseExit !== outcome.keep?.baseExit || claimed.keep?.headExit !== outcome.keep?.headExit)) || (keep == null && claimed.keep != null))) {
    fail(failures, 'card-red-green-mismatch', `the card says "${claimed.command}" exits ${claimed.baseExit} then ${claimed.headExit}; measured "${command}" exits ${outcome.baseExit} then ${outcome.headExit}`);
  }
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'red-green',
  afterProposal: true,
  description: 'The declared regression command fails at base and passes at head, measured in throwaway worktrees, and the card reports the same exits.',
  async run({ repo, item, baseSha, headSha, config, card }) {
    const loaded = await readCard({ repo, item, card });
    const command = regressionCommand({ item, card: loaded });
    const keep = item?.regressionKeep ?? loaded?.redGreen?.keep?.command;
    const setup = item?.regressionSetup ?? loaded?.redGreen?.setup;
    const expectBase = item?.regressionExpect ?? loaded?.redGreen?.expectBase;
    if (command === null) return evaluate({ command, outcome: null, claimed: null });
    let outcome;
    try {
      const testFiles = await authorizedTests({ repo, baseSha, headSha, item });
      outcome = await runRedGreen({ repo, baseSha, headSha, command, keep, setup, expectBase, testFiles, timeoutMs: item?.regressionTimeoutMs ?? config?.redGreenTimeoutMs ?? loaded?.redGreen?.timeoutMs });
    } catch (error) {
      if (!(error instanceof RedGreenBlockedError)) throw error;
      outcome = { blocked: true, reason: error.message.replace(/^\[RED-GREEN\]: BLOCKED: /, '') };
    }
    return evaluate({ command, keep, outcome, claimed: loaded?.redGreen ?? null });
  },
  async runFixture(fixture) {
    const command = regressionCommand({ item: fixture.item, card: fixture.card });
    return evaluate({ command, keep: fixture.item?.regressionKeep ?? fixture.card?.redGreen?.keep?.command, outcome: fixture.outcome ?? null, claimed: fixture.card?.redGreen ?? null });
  },
};
