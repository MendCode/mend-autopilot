import { evidenceLines, readCaptures } from '../../../checks/capture.mjs';
import { isLocalUrl } from '../../../checks/local-url.mjs';

function evaluate(capture) {
  const valid = capture && capture.exit === 0 && typeof capture.command === 'string' && capture.command.trim() && capture.database?.kind === 'ephemeral' && (capture.database.url === undefined || isLocalUrl(capture.database.url)) && Array.isArray(capture.combinations) && ['base-head', 'head-base'].every((value) => capture.combinations.includes(value));
  return valid ? { pass: true, failures: [] } : { pass: false, failures: [{ target: '(evidence)/captures', rule: 'compatibility', detail: 'capture a successful local compatibility test covering base application with head schema and head application with base schema' }] };
}

export default {
  id: 'compatibility',
  description: 'Require captured application compatibility tests against both schema versions.',
  afterProposal: true,
  async run({ repo, item, headSha }) {
    const captures = await readCaptures({ repo, itemId: item?.id, kind: 'compatibility', headSha });
    const capture = captures.at(-1);
    const observed = capture && evidenceLines(capture.output).at(-1);
    return evaluate(observed && { ...observed, command: capture.command, exit: capture.exit });
  },
  async runFixture(fixture) { return evaluate(fixture.capture); },
};
