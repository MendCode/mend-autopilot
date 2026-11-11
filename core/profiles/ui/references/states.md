# Empty, no-results, not-found and error states

## Applies when

Use this fallback when an item introduces or changes a surface that cannot show its normal content.
The team's design rules, existing components, locale and approved references always take precedence.
Use alongside `../critique-lens.md`; this document does not relax its limits or any checks.

| Type | Recognize it from the item or data contract | Appropriate response |
| --- | --- | --- |
| Empty | A successful, unfiltered collection request returns zero items, or initial setup is incomplete. | Explain what belongs here; offer creation/setup only when permitted. |
| No results | A successful search or filtered request returns zero matches. | Keep the query and filters visible; offer clearing/changing them, not onboarding. |
| Not found | A requested route or individual resource is confirmed missing. | Identify the missing destination and provide one safe way back to a known parent. |
| Error | A request, mutation or render fails; absence of data is not established. | Explain the affected operation and offer a recovery that can actually work. |
| Loading | A request is unresolved, including a pending retry. | Preserve the content region with a skeleton or progress indicator; do not assert absence. |

Permission denial is not an empty collection. A product may intentionally conceal resource existence;
follow that security contract rather than revealing whether an inaccessible item exists.
If previous data survives a failed refresh, retain it with an explicit stale/error indication.

## References

These are selected source-level patterns, not blanket endorsements of every screen in each product.
Repository files below were opened directly through public raw GitHub URLs; links name the exact paths.
Branch links are mutable, not pinned snapshots. No code, UI wording, icons or images are reproduced.
Utility names are source facts. Parenthetical pixel equivalents assume standard Tailwind scales and a
16px root; computed sizes, theme contrast and rendered responsive behavior are **unverified**.
Exact custom dimensions are identified separately. Product-wide accessibility is also **unverified**.

### 1. Cal.diy — spacious first-use emptiness

Repository: https://github.com/calcom/cal.diy.
The queried `calcom/cal.com` repository redirected here; this reference describes Cal.diy, not an
unverified current Cal.com deployment. License: **MIT**, verified in [LICENSE][cal-license].
Selected because its empty-state primitive gives scheduling/setup surfaces a clear, bounded hierarchy
and reduces padding on narrow layouts instead of using a fixed desktop canvas.

Files read:
- [packages/ui/components/empty-screen/EmptyScreen.tsx][cal-empty]
- [packages/ui/components/skeleton/Skeleton.tsx][cal-loading]
- [packages/ui/components/errorBoundary/ErrorBoundary.tsx][cal-error]
- [apps/web/app/not-found.tsx][cal-notfound-server]
- [apps/web/app/notFoundClient.tsx][cal-notfound]

Observations:
1. Empty layout: one centered column, full container width, exact **420px** text maximum;
   `p-7` becomes `lg:p-20` (nominal 28 → 80px). The optional icon has `h-10 w-10`
   (40px), an exact **72px** circular holder and **1.3px** stroke. Border is subtle and dashed by default.
2. Hierarchy: `h2` uses `text-xl` (20px), description `text-sm leading-6` (14/24px).
   Icon-to-heading spacing is `mt-6` (24px), heading-to-description `mt-3` (12px), and
   description-to-action `mb-8` (32px). Text and holder use semantic neutral tokens, not gradients.
   Copy is caller-provided: its word count and tone are **unverified**. There is **one built-in button**;
   the additional raw slot can add more, so the primitive does not enforce a one-action limit.
3. Loading is a separate pulsing, rounded neutral skeleton; the text wrapper also waits for locale readiness.
   The error boundary renders a **three-word** default failure heading and a native details disclosure,
   with **zero recovery buttons** and no explicit heading size. These are distinct from emptiness;
   do not inherit the missing recovery or expose raw exception details in a public-facing implementation.
4. Not-found is route-level: `px-4`, `max-w-xl`, top padding `pt-16 sm:pt-24`, heading
   `text-4xl sm:text-5xl` (nominal 36 → 48px). It has **two resource links plus one home link**,
   with conditional signup links. Most copy is translated and was not resolved: length is **unverified**.
   Borrow the fluid shell, not the oversized heading, multiple destinations or acquisition treatment.

### 2. Supabase Studio — compact, contextual failures

Repository: https://github.com/supabase/supabase.
License: **Apache-2.0**, verified in [LICENSE][sb-license].
Selected for its reusable error vocabulary and container-responsive alert layout: a database operation
failure stays a local operational message instead of becoming a promotional full-page card.

Files read:
- [apps/studio/components/ui/EmptyListState.tsx][sb-empty]
- [apps/studio/components/ui/AlertError.tsx][sb-error]
- [packages/ui-patterns/src/Admonition/Admonition.tsx][sb-admonition]
- [packages/ui-patterns/src/Admonition/AdmonitionIcons.tsx][sb-icons]
- [apps/studio/pages/404.tsx][sb-notfound]

Observations:
1. Empty list: centered stack with `gap-6` (24px); title and description both `text-sm` (14px),
   separated by `gap-1` (4px), inside `px-5` (20px). One abstract list motif contains **two** dashed
   `h-4 w-32` bars (16 × 128px); **zero actions** are built in. Title/body use foreground/lighter
   foreground tokens. Both strings are supplied by callers: tone and word count are **unverified**.
2. Error: warning semantics, optional subject, optional error detail and recovery guidance;
   the default instruction is **one sentence, 17 words**, or **four words** with support hidden.
   It recommends refresh before escalation in a calm operational tone. Default interaction is **one
   inline support link**, not a retry button; extra actions/children are unrestricted caller slots.
3. Admonition body is `text-sm`, icon/body gap `gap-3` (12px), paragraph spacing `mb-1.5` (6px).
   The warning badge has exact **23px** dimensions and semantic warning colors; its inner glyph fills
   the padded badge, so the standalone SVG's `w-6 h-6` is not its final rendered size.
   Responsive layout stacks content/actions, then uses a row at container `@md`, with `@lg` gap growth;
   exact breakpoint values and inherited title size are **unverified**. Loading was not verified here.
4. Counterexample: the 404 source uses an exact **28rem** background numeral, a **380px fixed-width**
   text group, an emoji heading and delayed reveal after **500ms**, with one main return action.
   Its explanation is **one nine-word sentence**. Retain concise explanation and recovery only;
   do not inherit the decorative numeral, emoji, artificial delay or fixed mobile width.

### 3. Documenso — no-results and failures inside the table

Repository: https://github.com/documenso/documenso.
License: **GNU AGPL v3**, verified in [LICENSE][doc-license]; no enterprise-code license inference.
Selected because its table keeps column context and handles no-results, loading and errors without
introducing a separate hero, illustration or navigation destination.

Files read:
- [packages/ui/primitives/data-table.tsx][doc-data]
- [packages/ui/primitives/table.tsx][doc-table]
- [packages/ui/primitives/skeleton.tsx][doc-loading]

Observations:
1. The fallback occupies **one full-column-span cell**, `h-32` (128px), centered under retained headers.
   Table typography is `text-sm` (14px); headers use `h-12 px-4` (48px high, 16px horizontal inset),
   cells `p-4` (16px). There is **no state icon and no separate heading** competing with column labels.
2. No-results copy is **three words**, neutral and literal; a **two-word** filter-reset control appears
   only when filters and a clearing callback both exist. It uses `mt-1` (4px), `text-sm` and foreground
   color. There are **zero or one actions**, not simultaneous create, retry and support buttons.
3. With no rows, an enabled error wins over an enabled skeleton, which wins over the empty fallback.
   Default error is **one three-word sentence**, in the same 128px cell, with **zero actions**;
   it is too generic for a contextual recovery contract. Skeleton row count is caller-controlled,
   and the primitive uses a muted pulsing fill with rounded corners. Existing rows take precedence
   over both flags: an explicit stale/error notice on retained data is **unverified**, not guaranteed.
4. The table wrapper is full-width with `overflow-auto` by default, rather than a mobile card redesign.
   Cells default to truncation; long/localized state text therefore needs explicit wrapping in an
   adaptation. No state-specific breakpoint exists in these files. Actual narrow-screen fit,
   custom empty-state copy and route-level not-found behavior remain **unverified**.

## Defaults for this type

Shared direction: contextual placement, restrained hierarchy, neutral surfaces and limited recovery.
The numbers below are fallback choices within the observed range, not a claim that all three products
use identical tokens. State-selection, safety and accessibility requirements are acceptance safeguards;
they are not assertions that every reference implements them. Reuse local tokens before adding values.

1. **Choose one truthful state per region.** Distinguish pending, successful-empty, successful-no-results,
   missing-resource and failed-request branches; a rejected request must never render as zero records.
2. **Keep the scope local.** Replace only the affected list/table/panel body; preserve its title, controls
   and navigation. Use a page-level not-found only for a missing route/resource, not zero search matches.
3. **Use one reading stack.** At most one state visual, one heading, one explanatory sentence and one
   recovery action. Inline links count as actions; icons inside controls do not count as state visuals.
4. **Match density.** In tables use the existing body size and a full-span cell around 128px high;
   in standalone panels use a 16–20px heading and 14–16px body. Do not enlarge a heading to fill space.
5. **Keep copy short and specific.** Target 3–8 heading words and at most 20 explanatory words in English;
   name the affected object/operation. Localization may expand, but the heading must fit within two lines
   at supported widths without clipping, ellipsis or shrinking below the app's type scale.
6. **Constrain prose, not the viewport.** Standalone text gets a maximum width around 420px and fluid width;
   keep at least 16px side insets. Verify at 320px and the intended desktop width; no fixed 380px text box.
7. **Use a small spacing scale.** Select existing 4–12px tokens between heading/body and 12–32px before
   the action. Give compact panels 16–28px inset; do not import large-screen 80px padding into tables.
8. **Make visuals optional.** Prefer none for table no-results; otherwise use one meaningful app icon
   around 24–40px. A holder is not another illustration. Never add a giant 404 numeral or decorative blobs.
9. **Use semantic color.** Neutral surface/title/body for empty and no-results; at most one status hue
   for failure plus the existing action color. Zero decorative gradients, glows, emoji or rainbow accents.
10. **Make the action match the cause.** Empty → authorized create/setup; no-results → clear relevant
    constraints; not-found → known parent; transient error → retry. Use zero actions if none is useful;
    never add a nonfunctional button to satisfy a template or retry a mutation unsafely.
11. **Keep waiting distinct.** Reuse a neutral skeleton shaped like the expected content, or one progress
    indicator. On retry, mark/disable that control while pending; do not flash empty copy or fabricate data.
12. **Preserve recovery and legibility.** Keep search input and unsaved form data after failure; retain
    stale data with an explicit notice when available. Wrap state text, expose keyboard focus and a
    programmatic status/error message, and test both shipped themes; color alone cannot identify failure.

## Slop markers for this type

| Observable defect | Fix |
| --- | --- |
| A dashboard empty state looks like a marketing hero or oversized KPI card. | Return it to the affected region; use the 14–20px hierarchy and one concrete next step. |
| Multiple illustrations, emoji, purple-blue gradients, glows or decorative blobs. | Remove decoration; retain at most one meaningful visual using the app's palette and stroke. |
| Create, retry, documentation and support all compete inside one state. | Choose the recovery matching the cause; keep general navigation outside the state. |
| A failed fetch claims the collection is empty, or loading flashes no-results. | Separate request status from collection length; render absence only after success. |
| Search failure resets the query, or no-results suggests first-time setup. | Preserve controls and input; describe the current constraints and offer one relevant reset. |
| Huge 404 typography, signup pitch or delayed reveal obscures recovery. | Use a modest missing-resource heading and one immediate, safe parent link. |
| A fixed-width box overflows, or cell truncation hides the explanation. | Use fluid width, max-width and wrapping; test long input and localized strings at 320px. |
| Raw exceptions, repeated field errors or a paragraph wall fill the panel. | Show one safe operational sentence; keep field errors by fields and diagnostics out of public copy. |
| A generic failure sentence has no usable next step. | Name the failed operation and add one supported recovery, without inventing a cause or retry promise. |

## Critic checklist

1. Can pending, empty, filtered-empty, missing, denied and failed outcomes be distinguished truthfully?
2. Does the state preserve the original region, headers, query and recoverable user work?
3. Is there at most one visual, one heading, one explanatory sentence and one useful recovery action?
4. Are type, spacing, icon weight and semantic colors consistent with this product rather than a hero template?
5. Does the action address the actual cause, respect permissions and avoid duplicate/unsafe mutations?
6. At 320px, desktop width and with long localized text, is everything readable, unclipped and keyboard-usable?
7. Were loading/retry, stale data and both shipped themes checked, with unverified behavior stated explicitly?

[cal-license]: https://github.com/calcom/cal.diy/blob/main/LICENSE
[cal-empty]: https://github.com/calcom/cal.diy/blob/main/packages/ui/components/empty-screen/EmptyScreen.tsx
[cal-loading]: https://github.com/calcom/cal.diy/blob/main/packages/ui/components/skeleton/Skeleton.tsx
[cal-error]: https://github.com/calcom/cal.diy/blob/main/packages/ui/components/errorBoundary/ErrorBoundary.tsx
[cal-notfound-server]: https://github.com/calcom/cal.diy/blob/main/apps/web/app/not-found.tsx
[cal-notfound]: https://github.com/calcom/cal.diy/blob/main/apps/web/app/notFoundClient.tsx
[sb-license]: https://github.com/supabase/supabase/blob/master/LICENSE
[sb-empty]: https://github.com/supabase/supabase/blob/master/apps/studio/components/ui/EmptyListState.tsx
[sb-error]: https://github.com/supabase/supabase/blob/master/apps/studio/components/ui/AlertError.tsx
[sb-admonition]: https://github.com/supabase/supabase/blob/master/packages/ui-patterns/src/Admonition/Admonition.tsx
[sb-icons]: https://github.com/supabase/supabase/blob/master/packages/ui-patterns/src/Admonition/AdmonitionIcons.tsx
[sb-notfound]: https://github.com/supabase/supabase/blob/master/apps/studio/pages/404.tsx
[doc-license]: https://github.com/documenso/documenso/blob/main/LICENSE
[doc-data]: https://github.com/documenso/documenso/blob/main/packages/ui/primitives/data-table.tsx
[doc-table]: https://github.com/documenso/documenso/blob/main/packages/ui/primitives/table.tsx
[doc-loading]: https://github.com/documenso/documenso/blob/main/packages/ui/primitives/skeleton.tsx
