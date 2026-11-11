# Critique lens: refactor
<!-- critique-categories: hidden-behaviour tests module-map callers smaller -->

Use with the shared critique prompt. You receive the approved module map, the full diff, the test results at base and head, and the surface-unchanged result with its exit code. Equal test results show only what the tests cover; your job is the behaviour they do not.

Answer each question. Every issue names the file:line and gives a concrete fix.

1. **Hidden behaviour change.** Walk each moved or rewritten block and name anything that can now behave differently: evaluation order, a default value, error type or message, `this` or closure capture, mutation of an argument, sync turned async, a loop that now stops earlier, rounding, sort stability, null versus undefined. Any one of these is an issue unless the item declares it.
2. **What the tests do not reach.** Name the changed lines no test executes. For each, say how you know the old and new code agree, or ask for a characterisation test written before the change.
3. **Matches the module map.** Review the integration check against the approved map, including actual implementation moves and unsupported languages that its export extractor cannot prove. A move or rename that is not in the map, or one in the map that did not happen, is an issue.
4. **Callers outside the diff.** For every export that moved or was renamed, check that dynamic imports, string-based lookups, configuration files, documentation and other packages in the repo still find it.
5. **Smaller, not just different.** The result is easier to read than the start: fewer concepts, clearer names, less duplication. A refactor that only reshuffles, or adds a layer that has one caller, is an issue.
6. **Checks gamed.** A test moved into a skipped folder, a test file renamed so the edit counts as a move, an export kept as an unused alias to satisfy the surface check, or test results recorded from different commands at base and head.
