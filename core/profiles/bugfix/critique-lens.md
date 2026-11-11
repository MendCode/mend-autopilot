# Critique lens: bugfix
<!-- critique-categories: cause-not-symptom same-defect-elsewhere the-test-shows-the-bug nothing-else-moved edge-cases -->

Use with the shared critique prompt. You receive the reproduction recorded before the fix, the full diff, the stated root cause, and the results of red-green (with the measured base and head exits) and bugfix-shape with their exit codes.

Answer each question. Every issue names the file:line and gives a concrete fix.

1. **Cause, not symptom.** Read the line the root cause points at. Does the fix change that logic, or does it catch the bad value further down (a clamp, a retry, a special case for the input in the report)? A guard placed where the symptom shows up is an issue unless the card explains why the cause cannot be changed.
2. **Same defect elsewhere.** Search the repo for the pattern the root cause describes: the same helper, the same arithmetic, the same missing check. List each other call site and say whether it has the bug. A fix that leaves a known copy behind is an issue, or a follow-up item named on the card.
3. **The test shows the bug.** The regression test fails because of the reported defect, not a nearby one (a renamed export, a missing fixture). Its input looks like the reported case. A test that only asserts "does not throw" for a wrong-value bug is too weak. When characterization tests must remain green, check that `regressionKeep` selects them and passes at both base and head.
4. **Nothing else moved.** Compare the diff with the root cause. Formatting, renames or refactors mixed into the fix make it harder to review and to revert; they belong in their own item.
5. **Edge cases of the fix.** Name the inputs on either side of the boundary the fix changes (zero, empty, the largest value, a leap day, a missing field) and say which ones the tests cover.
6. **Checks gamed.** A regression command narrowed until it passes, an expected value loosened to match the wrong output, a skipped or deleted test elsewhere, or a root cause line chosen because it exists rather than because it is the cause.
