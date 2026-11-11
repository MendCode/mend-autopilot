# Critique lens: ui

When the repository declares design rules (`designRules` in the `token-scale` result), read that file: those rules are the lens and override these defaults wherever they conflict.

Use with the shared critique prompt. You receive the approved preview, crops of the integrated screen (each at most 1600 px on the long side), the exemplars the owner cited, the full diff and the ui-rubric, token-scale and preview-diff results with their exit codes. You do not receive one full-page screenshot; if that is all you got, say so and score nothing.

Answer each question. Every issue names the component id or file:line and gives a concrete fix.

For visual work, preferences of taste are advisory and the human decides them. Focus findings on observable defects such as cut text, clipped decoration, oversized notices, off-scale values, broken states and poor contrast, rather than preferring minimalism for its own sake. The gate separately blocks open or disputed blocker/should findings, a head below the threshold, a worse comparison against the base or an exemplar in any category, and gamed checks. An improvement in one category cannot offset a regression in another.

When crops are attached, score each numbered category below in the shared table; answer Checks gamed on the separate gaming line.

1. **Exemplars.** Does the result look like it belongs next to the exemplars the owner cited? Name the specific difference (spacing, type scale, colour use, density), not a general impression.
2. **Hierarchy.** Is there one obvious thing to read first in each component? Count the elements that compete for it.
3. **Copy.** Read every visible string. Cut words that repeat the label, explain the obvious, or could appear unchanged in another product. Labels use the repo locale and its voice. Echoing the user's own input, such as an emphasized search term in an empty or error state, is a strength.
4. **Fidelity.** Compare against the approved preview, not against your own taste. Block order, relative size and copy that changed without a recorded reason is an issue even when the new version looks fine.
5. **Honest data.** Missing or stale values are shown as missing or stale, with their age, never as a dash, a zero or a plausible number. Sample data is labelled as sample data.
6. **Fit.** Text that is cut off, wraps badly or overflows at the target width; touch targets that are too small; contrast that only works on one theme.
   Review any `label-legibility` allowances and their reasons against the actual label experience.
7. **States.** Loading, empty, error and stale states exist where the data can be in them, and look like part of the same component.
8. **Typography.** Sizes and weights come from the scale the exemplars use; numbers that line up in columns use tabular figures; no more than two weights compete inside one component.
9. **Iconography.** Icons come from the set the repo already uses, at its sizes and stroke, and each one says something its label does not. An icon used only as decoration is an issue.
10. **Colour.** Colour carries meaning the way the exemplars use it (status, emphasis, selection) and not as decoration; text and icons reach readable contrast on every theme the repo ships.
11. **Consistency.** Spacing, radius, borders and shadows match neighbouring components on the same screen; a value that appears nowhere else in the repo needs a reason.
12. **Spacing.** Are gaps and density consistent with the approved preview, exemplars and neighbouring components, without crowding or wasted space?
13. **Alignment.** Do shared edges and baselines align with the approved preview and neighbouring components?
14. **Slop.** Look for each observable defect and apply its concrete fix:
    - An empty, error or not-found state with more than one illustration or icon, more than one sentence of explanation before the action, or more than one action: reduce it to at most one visual, one short explanatory sentence and one action. Icons inside controls, such as a button arrow or input icon, do not count as state visuals.
    - An alert, banner or summary taking more than about a third of its component's height, or repeating per-field errors: shorten it to a compact summary and keep field-specific explanations next to their fields.
    - Text longer than its designed space, including a heading wrapping into three or more lines or text that is cut: shorten the copy or reserve enough space at the target widths; do not hide it or shrink it below the app's type scale.
    - Decoration clipped by its container, such as a circle, glow or shadow cut at an edge: give it enough inset or space, correct the clipping boundary, or remove the decoration.
    - One well-made custom illustration is a strength, not slop, when it uses the app's palette and stroke style, is fully visible at every target width and remains proportionate to the state. A crude, off-palette or clipped illustration is worse than none: improve it, reuse an approved asset or remove it. An inline illustration outside the app's colours and stroke style, or drawn more heavily than its icons: reuse an approved asset or match the existing palette, stroke weight and visual weight.
    - A value used nowhere else in the app without a reason (see `token-scale`): reuse the nearest appropriate token or record a specific intended token and its reason in `ui.scaleAllow`; review every allowance against the repository's design rules.
15. **Checks gamed.** Did the change satisfy the rubric in a way a person would still reject: text shrunk under a tooltip, a hero number split into two, a stale marker hidden off-screen, rubric thresholds loosened in `.mend/quality.json`, components excluded from the snapshot selector?
