# Critique lens: generic
<!-- critique-categories: scope evidence derivation floor trust stale copy -->

Apply this lens to every item, beside the lens of its other profiles.

1. **Goal.** Does the change do what the item's goal says, and only that? Read the goal sentence, then the diff. Name any file or behaviour the goal did not ask for. Name any part of the goal the diff does not reach.
2. **Claims backed.** Is every claim on the card backed? For each "passes", "verified" or "unchanged" on the card, find the command, log or artifact that shows it. A claim with nothing behind it is an issue, even when it is probably true.
3. **Were the checks gamed?** Look for tests that were loosened, narrowed or skipped; expected values copied from the new output; thresholds moved; errors caught and dropped; a check that can no longer fail. If you see any, it is an issue whatever the score.
4. **Single derivation.** Is anything derived twice? A total, rate, count or status computed in two places will drift. One place computes; the others read.
5. **Sink floor.** Can a consumable value go below its floor? Balances, stock, quotas, seats, credits: every decrement needs a check or a clamp, and the check must be on the same path as the write.
6. **Trust boundary.** Does trust-bearing state come from the client? A role, price, balance or quota the server accepts from the request instead of reading it itself is an issue.
7. **Honest data.** Is stale or missing data shown honestly? A value that could not be refreshed is labelled stale with its age, not replaced by a dash, a zero or the last good number shown as current.
8. **Locale.** Is the copy in the repo's language and voice? Labels, messages and docs follow the locale and tone of the surrounding code, not the language of the brief.

Each issue you report names the file and line, says what is wrong in one sentence, and gives a concrete fix. "Consider improving" is not a fix.
