// Static heuristics for newly added label-hiding and truncation options.
import { changesFromFiles, collectChanges, isTestPath } from '../../../checks/changes.mjs';

const CODE_PATH = /\.(?:[cm]?[jt]sx?|vue|svelte|css|scss|less)$/i;
const LABEL_CONTEXT = /(?:label|categor(?:y|ies)|axis|axes|\btick)/i;
const HIDDEN = /\bhideOverlap\s*:\s*true\b/;
const OVERFLOW = /\boverflow\s*:\s*['"](?:truncate|ellipsis)['"]/;
const ELLIPSIS = /\bellipsis\s*:/;
const FIXED_WIDTH = /\b(?:width|maxWidth|max-width)\s*:\s*(?:\d+(?:\.\d+)?(?:px)?\b|['"]\d+(?:\.\d+)?px['"])/i;
const SLICED = /\.(?:slice|substring)\s*\(\s*0\s*,\s*[^)]+\)\s*(?:\+\s*['"`](?:…|\.\.\.)|}\s*(?:…|\.\.\.))/;
const ALLOW = /\/\/\s*mend-allow\s+label-legibility\s*:\s*(\S(?:.*\S)?)\s*$/;
const FIX = 'show every label in full (wrap onto reserved lines) or give the full text on focus, on hover and in the accessible name; if truncation is intended, add // mend-allow label-legibility: <reason> on that line';

export function evaluate({ changes }) {
  const failures = [];
  const allowed = [];
  for (const change of changes) {
    if (change.binary || change.status === 'deleted' || !CODE_PATH.test(change.path) || isTestPath(change.path)) continue;
    const lines = (change.headText ?? '').split('\n');
    for (const { line, text } of change.added) {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(text)) continue;
      const context = lines.slice(Math.max(0, line - 6), line).join('\n');
      const rules = [];
      if (HIDDEN.test(text)) rules.push('label-hidden-overlap');
      if (LABEL_CONTEXT.test(context) && (OVERFLOW.test(text) || (ELLIPSIS.test(text) && FIXED_WIDTH.test(context)) || (FIXED_WIDTH.test(text) && ELLIPSIS.test(context)))) rules.push('label-truncated');
      if (SLICED.test(text)) rules.push('label-sliced');
      const reason = text.match(ALLOW)?.[1]?.trim();
      const target = `${change.path}:${line}`;
      for (const rule of rules) {
        if (reason) allowed.push({ target, rule, reason });
        else failures.push({ target, rule, detail: `${target}: ${FIX}` });
      }
    }
  }
  return { pass: failures.length === 0, failures, allowed };
}

export default {
  id: 'label-legibility',
  description: 'New chart and category labels remain legible rather than being hidden or truncated.',
  async run({ repo, baseSha, headSha }) {
    return evaluate({ changes: await collectChanges({ repo, baseSha, headSha }) });
  },
  async runFixture(fixture) {
    return evaluate({ changes: changesFromFiles(fixture.files) });
  },
};
