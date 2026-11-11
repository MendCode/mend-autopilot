// A write route for an action people can repeat for gain (redeem, claim, send, transfer...) has a bound:
// a rate limit, an idempotency key, a uniqueness guard or a cap. Otherwise the card's uncertain field
// must name the route and say why no bound is needed.
import { changesFromFiles, collectChanges, isTestPath } from '../../../checks/changes.mjs';
import { readCard, uncertainNotes } from '../../../checks/repo-read.mjs';
import { hasMarker, isWrite, routeKey, touchedRoutes } from './routes.mjs';

export const DEFAULT_REPEAT_WORDS = [
  'redeem', 'claim', 'send', 'invite', 'reset', 'verify', 'vote', 'like', 'apply', 'purchase', 'checkout', 'pay', 'transfer',
  'withdraw', 'signup', 'register', 'login', 'otp', 'sms', 'email', 'coupon', 'bonus', 'reward', 'refund', 'referral',
  'redemption',
];
export const DEFAULT_BOUND_MARKERS = [
  'rateLimit', 'ratelimit', 'RateLimit', 'rate_limit', 'throttle', 'Throttle', 'limiter', 'Limiter', 'idempotency', 'Idempotency',
  'idempotent', 'onConflict', 'ON CONFLICT', 'upsert', 'unique', 'alreadyClaimed', 'already_claimed', 'maxAttempts',
  'max_attempts', 'cooldown', 'perUserCap', 'quota',
];

function tokensOf(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The repeatable verb named by the route path or its first handler lines, matched as a whole word or plural. */
function repeatWord(route, words) {
  const tokens = new Set(tokensOf(`${route.path}\n${route.body.split('\n').slice(0, 3).join('\n')}`));
  return words.find((word) => tokens.has(word) || tokens.has(`${word}s`) || tokens.has(`${word}es`)) ?? null;
}

function justified(route, notes) {
  return notes.some((note) => note.includes(route.path));
}

export function evaluate({ changes, card, config }) {
  const words = [...DEFAULT_REPEAT_WORDS, ...(config?.repeatWords ?? [])].map((word) => word.toLowerCase());
  const markers = [...DEFAULT_BOUND_MARKERS, ...(config?.boundMarkers ?? [])];
  const notes = uncertainNotes(card);
  const failures = [];
  const sources = changes.filter((change) => !change.binary && change.status !== 'deleted' && !isTestPath(change.path));
  for (const route of touchedRoutes(sources).filter(isWrite)) {
    const word = repeatWord(route, words);
    if (!word || hasMarker(route.body, markers) || justified(route, notes)) continue;
    failures.push({
      target: `${route.file}:${route.line}`,
      rule: 'repeat-unbounded',
      detail: `${routeKey(route)} is a repeatable "${word}" action with no rate limit, idempotency, uniqueness guard or cap, and the card's uncertain field does not explain why`,
    });
  }
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'repeat-abuse',
  needsCard: true,
  description: 'A repeatable write action has a rate limit, idempotency, uniqueness guard or cap, or the card says why it needs none.',
  async run({ repo, item, baseSha, headSha, config, card }) {
    const changes = await collectChanges({ repo, baseSha, headSha });
    return evaluate({ changes, card: await readCard({ repo, item, card }), config });
  },
  async runFixture(fixture) {
    return evaluate({ changes: changesFromFiles(fixture.files), card: fixture.card, config: fixture.config });
  },
};
