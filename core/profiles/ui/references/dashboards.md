# Dashboards, KPI tiles and charts

## Applies when

- **Dashboard:** an item combines several summaries, service statuses or reports under
  a shared entity, filter or time range; people monitor, compare or investigate data.
- **KPI tile:** an item presents one aggregate with its label, unit and optional
  comparison, target or status. A compact metric strip is also a KPI component.
- **Chart:** an item encodes measured values over time or categories using marks,
  axes, legends or tooltips. A sparkline embedded in a tile qualifies.
- Apply these rules to the relevant component, not automatically to its entire page.
  Marketing statistics, pricing cards and decorative illustrations are not dashboards.
- Repository design rules and approved exemplars win. This is a fallback and critic
  lens, not permission to replace existing tokens, locale or product semantics.

## References

These three established open-source products were selected for complementary
patterns, not as a universal ranking. Findings below come from public component
source on each repository's `master` branch, not a running application or screenshots.
Links are moving references, not immutable snapshots. Computed CSS, contrast,
browser behaviour and accessibility are **unverified** unless explicitly stated.
Token names are source facts; their pixel equivalents are not assumed.
Descriptions are original; do not transplant source code, UI copy, icons or images.

### U — Umami: responsive KPI groups and metric-specific comparisons

Repo: https://github.com/umami-software/umami
License: MIT, verified in [`LICENSE`](https://github.com/umami-software/umami/blob/master/LICENSE).
Best fit here: a small set of related measures with consistent formatting and
meaningful deltas, rather than unrelated promotional number cards.

Exact component files read (all relative to the repository root):
- [`src/app/(main)/websites/[websiteId]/WebsiteMetricsBar.tsx`](https://github.com/umami-software/umami/blob/master/src/app/%28main%29/websites/%5BwebsiteId%5D/WebsiteMetricsBar.tsx)
- [`src/app/(main)/websites/[websiteId]/WebsiteChart.tsx`](https://github.com/umami-software/umami/blob/master/src/app/%28main%29/websites/%5BwebsiteId%5D/WebsiteChart.tsx)
- [`src/components/metrics/MetricCard.tsx`](https://github.com/umami-software/umami/blob/master/src/components/metrics/MetricCard.tsx)
- [`src/components/metrics/MetricsBar.tsx`](https://github.com/umami-software/umami/blob/master/src/components/metrics/MetricsBar.tsx)
- [`src/components/metrics/ChangeLabel.tsx`](https://github.com/umami-software/umami/blob/master/src/components/metrics/ChangeLabel.tsx)
- [`src/components/metrics/PageviewsChart.tsx`](https://github.com/umami-software/umami/blob/master/src/components/metrics/PageviewsChart.tsx)
- [`src/components/common/LoadingPanel.tsx`](https://github.com/umami-software/umami/blob/master/src/components/common/LoadingPanel.tsx)
- [`src/components/common/Empty.tsx`](https://github.com/umami-software/umami/blob/master/src/components/common/Empty.tsx)
- [`src/components/common/ErrorMessage.tsx`](https://github.com/umami-software/umami/blob/master/src/components/common/ErrorMessage.tsx)

1. **Grouping and size:** the website strip contains **5** metrics; its grid auto-fits
   columns with a **160px** minimum. Cards use horizontal spacing token **6**, vertical
   token **4**, gap **4**, a border and a neutral surface. Labels are bold and values
   use **4xl**; computed font and spacing pixels are **unverified**.
2. **Copy and actions:** one metric label precedes one value and an optional delta;
   there is **no explanatory paragraph** or primary CTA. The reusable card offers
   **0–1** help buttons with an **sm** icon; these website instances supply no help
   content. Exact translated wording, word counts and icon pixels are **unverified**.
3. **Meaningful colour and charts:** deltas use success/error tokens and directional
   arrows; bounce-rate improvement reverses the colour meaning. All-time mode hides
   deltas. The chart is **400px** high, has **2** bar series with **1px** borders and
   adds **2** comparison lines with **2px** strokes. Comparison hues identify data,
   not decorative backgrounds; do not adopt this four-series mode by default.
4. **States:** the metric loader reserves **136px** minimum height. `LoadingPanel`
   replaces content during loading **or refetching** with a dots loader; errors use
   **1** warning icon plus text and **0** actions. The empty component centres muted
   text in at least **70px**, without illustration or action. Empty detection is
   shallow: nested empty chart arrays are not proof of an end-to-end empty state.

### P — Plausible Analytics: dense summaries tied to one time-series view

Repo: https://github.com/plausible/analytics
License: GNU AGPL v3, verified in [`LICENSE.md`](https://github.com/plausible/analytics/blob/master/LICENSE.md).
Best fit here: compact current/previous comparisons with exact time context and
direct investigation of the selected measure.

Exact files read:
- [`assets/js/dashboard/stats/graph/top-stats.js`](https://github.com/plausible/analytics/blob/master/assets/js/dashboard/stats/graph/top-stats.js)
- [`assets/js/dashboard/stats/graph/visitor-graph.tsx`](https://github.com/plausible/analytics/blob/master/assets/js/dashboard/stats/graph/visitor-graph.tsx)
- [`assets/js/dashboard/stats/graph/main-graph.tsx`](https://github.com/plausible/analytics/blob/master/assets/js/dashboard/stats/graph/main-graph.tsx)
- [`assets/js/dashboard/stats/metrics.ts`](https://github.com/plausible/analytics/blob/master/assets/js/dashboard/stats/metrics.ts)
- [`assets/js/dashboard/stats/reports/change-arrow.tsx`](https://github.com/plausible/analytics/blob/master/assets/js/dashboard/stats/reports/change-arrow.tsx)
- [`assets/js/dashboard/error/something-went-wrong.tsx`](https://github.com/plausible/analytics/blob/master/assets/js/dashboard/error/something-went-wrong.tsx)

1. **Density and copy:** metric names are **1–3 English words**, factual rather than
   promotional. Labels use **text-xs**, semibold, uppercase; values use **1.2rem**.
   Cells have **px-4** horizontal padding and **gap-y-1** internal spacing. They are
   **50%** wide below `lg`, then flexible equal-share cells; dividers change with the
   layout. Exact breakpoint and token pixels are **unverified**.
2. **Comparison and actions:** a graphable metric has **1** selection interaction,
   with a neutral selected background. Comparison mode displays **2** values with
   their respective date ranges. Delta arrows use **size-2.5** and an explicit
   **1.5px** stroke; green/red meaning reverses for bounce rate. A pinned chart
   tooltip offers up to **2** explicit actions: annotation and period drill-down.
3. **Chart and adaptation:** the chart is **368px** high, with **16px** top and
   **32px** bottom margins, and **2px** series strokes. Current and comparison data
   use different intensities of one indigo family. Area fills fade from **0.15**
   and **0.05** opacity to zero; these encode series, not purple-blue chrome.
   Width follows a ResizeObserver; tooltip maximum width changes **220→300px** at
   `sm`. Touch taps pin values. Actual touch/browser usability is **unverified**.
4. **States and limits:** loading reserves at least **85px** for summaries and uses
   a centred overlay spinner; realtime silent updates avoid that overlay. The error
   component contains **1** illustration, a heading, technical detail and an optional
   recovery link. This large page-error treatment is **not** a KPI-card default.
   Chart-empty presentation and error-boundary wiring are **unverified** in this scope.

### S — Supabase Studio: operational summaries and small-multiple usage charts

Repo: https://github.com/supabase/supabase
License: Apache-2.0, verified in [`LICENSE`](https://github.com/supabase/supabase/blob/master/LICENSE).
Best fit here: service-specific operational information and compact plots that lead
to investigation, instead of making every service look like a revenue KPI.

Exact component files read:
- [`apps/studio/components/interfaces/ProjectHome/ActivityStats.tsx`](https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/ProjectHome/ActivityStats.tsx)
- [`apps/studio/components/interfaces/ProjectHome/ProjectUsageSection.tsx`](https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/ProjectHome/ProjectUsageSection.tsx)
- [`apps/studio/components/ui/SingleStat.tsx`](https://github.com/supabase/supabase/blob/master/apps/studio/components/ui/SingleStat.tsx)

1. **Operational scale:** activity icons explicitly measure **18px**, stroke **1.5**;
   their bordered neutral containers use **w-16/h-16**, with **gap-4** to the label/value.
   Values reserve at least **34px** height. The grid changes **1→2** columns at the
   `@md` container breakpoint and gap **2→6**. Pixel mappings for tokens are
   **unverified**; the container-query behaviour is explicit in source.
2. **Charts and hierarchy:** up to **4** service charts share **1** interval selector.
   The row receives **280px** minimum width and a **4**-column maximum; cards request
   **h-64**, labels **text-xs**, uppercase monospace, and totals **text-xl**.
   Card titles are **2-word** service/measure labels; activity labels are **1–2 words**.
   Exact heading-token pixels and the row helper's final layout are **unverified**.
3. **Actions and colour:** each activity stat has **0–1** navigation action; each
   service title links to its service, and bars drill into a **±1-minute** log window.
   Surfaces, icons and label hierarchy use neutral semantic tokens. The chart API
   exposes **3** status series, but this caller supplies only request counts and zeros
   for warning/error counts. Do not infer a verified error breakdown or palette:
   internal chart colours are **unverified** because the renderer was not retrieved.
4. **States:** activity values use **h-6/w-24** skeletons; the branch stat distinguishes
   loading, error, absence and unavailable states in place. Usage charts receive
   separate loading, error and empty components: error has **1** warning icon, a
   **5-word** title and **1** explanatory sentence; empty has **1** short period-specific
   message. No recovery button is supplied. Rendered state dimensions are **unverified**.

## Defaults for this type

Shared direction: compact factual hierarchy, grouped measures, scoped interactions,
semantic colour and adaptive layouts. The numeric limits below operationalize that
direction as fallback decisions, **not** claims that every product uses identical
tokens or implements every safeguard. U/P/S identify supporting observations above.

1. **Scope first:** place one entity/time/filter context above the affected group;
   changing it must update every dependent summary and chart. Label exceptions. (U/P/S)
2. **One metric, one hierarchy:** each tile has one label, one dominant value with
   its unit, and at most one comparison/status row; use 1–3-word labels where the
   locale permits, with no generic paragraph or hero heading. (U/P/S)
3. **Bound the overview:** start with 3–5 related summaries; group additional measures
   by task or service instead of enlarging a wall of equal-priority tiles. (U/S)
4. **Compact scale:** reuse the repository scale; absent one, start with 14px labels,
   20–32px values, 16–24px padding and 8–16px gaps. Do not assign a fixed tall height
   to value-only cards; reserve chart space separately. These are fallback choices,
   not measured consensus sizes; U's 4xl value is deliberately not a universal rule.
5. **Limit interactions:** permit 0–1 primary interaction per KPI and at most 2 local
   chart actions; put shared interval selection once above the charts. A plain
   summary must not look clickable when it has no action. (U/P/S)
6. **Use quiet surfaces:** one neutral surface/border treatment per group; colour
   only selection, a named series or a meaningful status. Use zero decorative
   gradients, glows, blobs or emoji. A data-area fade is not a background effect. (U/P/S)
7. **Keep comparisons interpretable:** show current and comparison periods, units
   and direction together. Improvement follows metric semantics, not always growth;
   distinguish percentage points from relative percentages and undefined baselines. (U/P)
8. **Keep plots legible:** begin with 1 main series and at most 1 comparison, then use
   separate service plots for different questions. Give every series a name and unit;
   add further series only with an explicit analytical reason. (P; U/S show alternatives)
9. **Design for width:** wrap KPI groups before labels or values clip; collapse chart
   columns rather than shrinking text. Check at 320px and the approved desktop width;
   keep units and comparison context visible, including in localized copy. (U/P/S)
10. **Keep detail close:** chart inspection must expose time/category and exact value;
    drill-down must retain that scope. Provide a keyboard/touch route to details,
    not hover alone. Source references show investigation patterns, not a verified
    accessibility implementation. (U/P/S)
11. **Make loading local:** reserve the component's intended footprint and use one
    loader or matching skeleton; do not substitute invented values. Loading must
    not erase unrelated healthy panels. (U/P/S)
12. **Separate non-success states:** distinguish empty, error, missing and stale data;
    use at most one state visual, one explanatory sentence and one recovery action.
    Show stale age visibly; never disguise unknowns as zero or a dash. This extends
    the references with this profile's honest-data contract; complete coverage in
    all three products is **unverified**. Label samples and never invent smooth trends.

## Slop markers for this type

| Observable defect | Fix |
| --- | --- |
| One number floating in a hero-sized card | Remove fixed excess height; add only relevant unit/context and align the summary group. |
| Five unrelated accents, glowing cards or gradient headings | Use neutral surfaces and map each remaining colour to a named series/status. |
| Emoji and generic motivational dashboard copy | Remove decoration; name the actual entity, metric or task. |
| Every tile repeats export, filter and help controls | Move shared controls to the group header; keep only scoped interactions. |
| Green upward arrows on failure rate or cost without context | Define beneficial direction per metric and show the comparison period. |
| Decorative sparkline, unlabeled axes or fabricated sample values | Use real labelled data, meaningful axes/units and an explicit sample marker. |
| Nulls become zeros, missing buckets become smooth lines | Preserve missingness; zero-fill only when the data contract proves zero events. |
| Rainbow plot with overlapping unrelated measures | Use a main/comparison pair or service-specific small multiples. |
| Small screen hides labels, units or date context | Reflow the grid and simplify ticks; do not shrink or conceal essential text. |
| Page-sized empty illustration inside each chart | Keep the state in its plot footprint, with one sentence and at most one action. |

## Critic checklist

1. Does each component match its task and the repository's rules before these defaults?
2. Can someone identify each metric, unit, entity and time range without guessing?
3. Are values, deltas and labels ordered clearly, without oversized empty cards or repeated controls?
4. Does every colour/icon communicate data, selection or status, with a non-colour cue where needed?
5. Are comparisons, baselines, missing values, stale ages and samples represented honestly?
6. Do loading, empty and error states remain local, readable and proportionate?
7. At narrow widths, can users read essential labels and inspect chart details by touch and keyboard?
8. Can each finding name a component, an observable defect and a concrete fix rather than personal taste?
