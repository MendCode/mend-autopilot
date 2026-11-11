# Tables, lists, search, filters and pagination

## Applies when

- **Data table:** an item compares records through repeated fields, column headings, sorting, selection or row actions: invoices, members, documents, database records.
- **List:** the primary task is identifying/opening one entity; each repeated row has a name and secondary metadata rather than a cross-column comparison. Prefer a semantic list to a fake table.
- **Search:** typed text narrows records or available filter options. Distinguish collection search, option search and a global command launcher; they have different scopes.
- **Filters:** discrete properties, statuses, owners, dates or operators constrain a collection; active constraints must remain discoverable and reversible.
- **Pagination:** results arrive in bounded pages or cursors. Counts, navigation and page size belong to the collection, not a promotional dashboard summary.
- Combine these patterns when appropriate. An editable database grid needs greater density and stronger cell interaction than a document inbox; do not impose identical row heights on both.

Repository design rules and approved references take precedence. These are fallback patterns and a critic's lens, not permission to replace an established design system.

## References

Evidence is direct reading of public component source, not a running-product visual review.
Utility classes below are source facts; parent styles, custom theme scales and root font size were not exhaustively inspected.
Where useful, nominal pixel equivalents assume the standard Tailwind scale and a 16px root; computed pixels and numeric breakpoint widths are **unverified**.
Page-heading sizes are **unverified** in all three samples: the inspected components do not establish the surrounding page title.
No source code, product copy, icons or images are reproduced here.

### 1. Dub — list browsing and compact filtering

**Why selected:** its link collection exposes both compact and loose list density, contextual bulk actions and searchable facets; its shared table provides a complementary dense comparison pattern.

- Repository: <https://github.com/dubinc/dub.link> (the former `dubinc/dub` URL redirects here).
- License read: [`LICENSE.md`](https://github.com/dubinc/dub.link/blob/main/LICENSE.md), AGPLv3 outside the explicitly listed enterprise directories; the samples below are outside those directories. Do not describe every part of the repository as AGPL.
- Source branch read: `main`; branch head observed during research: `6b463b4bdd9ed2fd9aa416f67b5b77d317b1471e`. Files were fetched by branch, not an atomic checkout.
- Exact component paths read, relative to that repository:
  - [`packages/ui/src/table/table.tsx`](https://github.com/dubinc/dub.link/blob/main/packages/ui/src/table/table.tsx)
  - [`packages/ui/src/card-list/card-list.tsx`](https://github.com/dubinc/dub.link/blob/main/packages/ui/src/card-list/card-list.tsx)
  - [`packages/ui/src/filter/filter-select.tsx`](https://github.com/dubinc/dub.link/blob/main/packages/ui/src/filter/filter-select.tsx)
  - [`packages/ui/src/filter/filter-list.tsx`](https://github.com/dubinc/dub.link/blob/main/packages/ui/src/filter/filter-list.tsx)
  - [`apps/web/ui/links/links-container.tsx`](https://github.com/dubinc/dub.link/blob/main/apps/web/ui/links/links-container.tsx)
  - [`apps/web/ui/links/links-toolbar.tsx`](https://github.com/dubinc/dub.link/blob/main/apps/web/ui/links/links-toolbar.tsx)
  - [`apps/web/ui/links/use-link-filters.tsx`](https://github.com/dubinc/dub.link/blob/main/apps/web/ui/links/use-link-filters.tsx)

1. **Density and hierarchy:** table selection/menu widths are explicitly **48/40px**. Ordinary cells use `text-sm`, `leading-6`, `py-2.5`, usually `px-4`; headers add medium weight, not oversized type. Sort glyphs use `h-3 w-3` (nominal **12px**). Lists switch between **0** gap and `gap-4` (nominal **16px**); this is a density choice, not a mandatory card-per-record layout.
2. **Search and filters:** the trigger is `h-10` with `size-4` icons (nominal **40/16px**). The link filter model defines **3** facets with one-word English labels. Option search for asynchronous tags is debounced **500ms**; this is not evidence of collection-search timing. Single-select closes; multi-select stays open. Active pills wrap with `gap-y-2`; each has a removal control and the group has one clearing action. Neutral surfaces, dark selection checks and a count badge carry hierarchy without ornamental accents.
3. **Actions and adaptation:** the shared table has **2** page-navigation buttons, `h-7`, separated by `gap-2`, plus a visible range/total. It scrolls horizontally inside its wrapper and supports pinned columns. The link toolbar switches from pagination to **5** bulk operations after selection; below `sm` it exposes **2** extra controls for creation/selection. The toolbar reserves **90px** below the list so fixed controls do not simply cover its end. These are observed implementations, not universal action counts.
4. **States and tone:** the list uses **12** initial placeholder rows, **50%** opacity while refreshing, and a dedicated error callout. It distinguishes an untouched empty collection from filtered emptiness using **3-word** headings; explanations are **1–2** sentences. The table instead uses a **50%** overlay with spinner and an inline empty/error slot; its fallback empty message is **4 words** with the default resource. The list's animated illustration and additional help link are not a fallback recommendation; their rendered footprint and accessibility are **unverified**.

### 2. Documenso — document tables and status facets

**Why selected:** its document table separates document identity, workflow status and contextual actions; shared pagination and facets make a strong reference for business records rather than editable spreadsheets.

- Repository: <https://github.com/documenso/documenso>.
- License read: [`LICENSE`](https://github.com/documenso/documenso/blob/main/LICENSE), GNU AGPL version 3. This is a root-license observation, not a legal audit of all subdirectories.
- Source branch read: `main`; branch head observed: `fdd0337bdd8f6afac64faf97113c65ed2dd0e2a2`; branch fetches are not an atomic checkout.
- Exact component paths read:
  - [`apps/remix/app/components/tables/documents-table.tsx`](https://github.com/documenso/documenso/blob/main/apps/remix/app/components/tables/documents-table.tsx)
  - [`apps/remix/app/components/tables/documents-table-status-filter.tsx`](https://github.com/documenso/documenso/blob/main/apps/remix/app/components/tables/documents-table-status-filter.tsx)
  - [`apps/remix/app/components/general/filter-pill.tsx`](https://github.com/documenso/documenso/blob/main/apps/remix/app/components/general/filter-pill.tsx)
  - [`apps/remix/app/components/general/document/document-status.tsx`](https://github.com/documenso/documenso/blob/main/apps/remix/app/components/general/document/document-status.tsx)
  - [`packages/ui/primitives/table.tsx`](https://github.com/documenso/documenso/blob/main/packages/ui/primitives/table.tsx)
  - [`packages/ui/primitives/data-table.tsx`](https://github.com/documenso/documenso/blob/main/packages/ui/primitives/data-table.tsx)
  - [`packages/ui/primitives/data-table-pagination.tsx`](https://github.com/documenso/documenso/blob/main/packages/ui/primitives/data-table-pagination.tsx)

1. **Geometry and copy:** the document table declares **6** columns before optional selection; all **6** English headings are one word. Status width is **140px**, selection **40px**. Shared headers use `h-12 px-4`; cells use `p-4`; both inherit `text-sm` (nominal **48px** header, **16px** padding, **14px** type). The action cell composes **1** contextual action and **1** dropdown with `gap-x-4`, rather than displaying every operation.
2. **Colour and filters:** status has a one-word label plus a `h-4 w-4` icon and `mr-2` gap (nominal **16/8px**). Colour is on the icon, not the entire row; multiple hues encode distinct workflow states rather than decorative accents. The status selector defines **7** choices before organisation-specific exclusion. Filter pills change from dashed to solid borders when active; multi-select shows at most **2** values plus an overflow count, with **1** clearing row. Option search is optional inside the **w-52** popover, not evidence of collection search.
3. **Pagination and responsive behaviour:** **5** page-size options span **10–50** records. Navigation has **4** buttons on `lg`, **2** below it; controls are `h-8 w-8` with `h-4 w-4` icons (nominal **32/16px**) and screen-reader labels. Groups wrap with `gap-y-4`. Table content scrolls within its own wrapper. Document titles have **10rem** maximum width, increasing to **20rem** at `md`; owner/recipient links expose full text via a title attribute. Touch access to truncated titles is **unverified**, so do not treat that attribute as sufficient.
4. **States and transitions:** the document table requests **5** skeleton rows; pagination transitions use a **50%** background overlay and `h-8 w-8` spinner. With no data, the shared primitive has separate error/loading/empty branches; error and empty occupy a `h-32` spanning cell (nominal **128px**). Their default messages are **3 words** each; filtered emptiness can expose **1** clearing action when its props are supplied. The document caller does not supply those props. Changing the status clears the page parameter. A generic error without recovery and existing-data precedence over error are limitations, not recommended behaviour.

### 3. Supabase Studio — dense database grids

**Why selected:** it preserves database context through structured filtering, selection and bounded pagination, and differentiates empty tables, empty filtered results and out-of-range pages.

- Repository: <https://github.com/supabase/supabase>.
- License read: [`LICENSE`](https://github.com/supabase/supabase/blob/master/LICENSE), Apache-2.0; no code or assets are being imported.
- Source branch read: `master`; branch head observed: `86db293ec4aaacc43727661c966e632ed914adbf`; branch fetches are not an atomic checkout.
- Exact component paths read:
  - [`apps/studio/components/interfaces/TableGridEditor/TableGridEditor.tsx`](https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/TableGridEditor/TableGridEditor.tsx)
  - [`apps/studio/components/grid/SupabaseGrid.tsx`](https://github.com/supabase/supabase/blob/master/apps/studio/components/grid/SupabaseGrid.tsx)
  - [`apps/studio/components/grid/components/header/Header.tsx`](https://github.com/supabase/supabase/blob/master/apps/studio/components/grid/components/header/Header.tsx)
  - [`apps/studio/components/grid/components/header/filter/FilterPopoverNew.tsx`](https://github.com/supabase/supabase/blob/master/apps/studio/components/grid/components/header/filter/FilterPopoverNew.tsx)
  - [`apps/studio/components/grid/components/grid/Grid.tsx`](https://github.com/supabase/supabase/blob/master/apps/studio/components/grid/components/grid/Grid.tsx)
  - [`apps/studio/components/grid/components/grid/GridError.tsx`](https://github.com/supabase/supabase/blob/master/apps/studio/components/grid/components/grid/GridError.tsx)
  - [`apps/studio/components/grid/components/footer/Footer.tsx`](https://github.com/supabase/supabase/blob/master/apps/studio/components/grid/components/footer/Footer.tsx)
  - [`apps/studio/components/grid/components/footer/pagination/Pagination.tsx`](https://github.com/supabase/supabase/blob/master/apps/studio/components/grid/components/footer/pagination/Pagination.tsx)

1. **Toolbar and density:** the header uses `md:min-h-10` and `gap-2` (nominal **40/8px**) with neutral light/dark surfaces. The filter's refresh icon is `h-4 w-4`; its input explicitly uses `text-xs`. Selection replaces ordinary header content with **2** export/copy menus, conditionally a table-wide selection control and **1** destructive action. The two menu labels are one word; deletion identifies the affected quantity. Actual cell/row heights and complete unselected action counts are **unverified** because their downstream definitions were not read.
2. **Filters and adaptation:** structured edits remain local until **1** apply operation commits them; invalid incomplete conditions are rejected. The date panel has an explicit **300px** width and **2** actions. The header wraps; mobile moves sorting/actions to a second horizontally scrollable strip rather than shrinking type. Filter input focus temporarily suppresses desktop secondary actions. This is a structured filter builder, not verified plain-text row search. Its optional AI-generation path is not required by this reference.
3. **Pagination and honest counts:** **2** directional controls surround a page input; **3** size options are **100/500/1000**, appropriate to a database tool, not a document-inbox default. Input widths use `w-12` for ordinary tables, `w-10` for foreign tables. Changing filters or page size resets to page **1**. Estimated totals are explicitly labelled and exact-count retrieval can require confirmation. Count loading and count failure have distinct controls; a foreign table omits a fabricated total. Narrow-screen footer fit is **unverified**.
4. **States and tone:** skeleton/error content is positioned below the header at `top-9` (nominal **36px**). **3** empty conditions have distinct handling: no records, filtered-out records, and an empty later page. Each actionable variant exposes **1** relevant recovery operation. The basic empty-table message is **4 words**; explanations use task-specific prose, not marketing. Error branches address filter/sort/permission problems and can expose technical detail; the detail chevron is explicitly **14px**. Previous rows are retained during refetch. Some diagnostic prose is longer than a compact empty state and should be progressively disclosed.

## Defaults for this type

The agreement is on structure and behaviour, not identical tokens. The following **12** fallback rules operationalize recurring patterns; exact suggested ranges are synthesis, not claims that all three products use them. Evidence coverage is stated where a pattern is narrower.

1. **One collection region:** render records in one table/grid or semantic list, with shared alignment and separators; use **0** ornamental summary cards between controls and results. All three prioritize repeated records over decoration.
2. **Compact type hierarchy:** use the existing small body token for cells, filters and pagination; absent tokens, start with **14px** body and **12px** secondary metadata, at most **2** weights per row. Keep header labels short and medium-weight, not page-sized. Dub/Documenso use `text-sm`; Studio uses small text for controls/states. Do not shrink labels to conceal overflow.
3. **Consistent rhythm:** align headers with their cells; choose **one** horizontal padding token per content column and an **8–16px** control-group gap from the local scale. Numeric fields share an alignment edge. Reference spacing varies by density; do not copy Documenso's padding into every database cell.
4. **Purposeful colour:** keep surfaces and separators neutral; every non-neutral colour must map to a named status, selection, focus, progress or destructive operation. Include a text/icon/state cue: **0** colour-only status meanings. Semantic status palettes may contain multiple hues; decorative accent palettes may not.
5. **Scoped search:** give each search input **1** explicit scope—records or facet options—and place option search above its options. Do not silently use option-search text as collection search. Searchable option menus are verified in Dub/Documenso; Studio demonstrates the distinct structured-query case. Collection-search debounce and matching semantics across all three are **unverified**; specify them before implementation rather than inventing consensus.
6. **Visible constraints:** show applied constraints as editable pills/fields, with **1** removal affordance per constraint and a clearing path for the set. Keep single-select and multi-select behaviour distinct. Dub/Documenso expose selections; Studio keeps the applied filter group in its bar.
7. **Reset the result window:** after a committed filter change, return to page **1** or the first cursor; do not carry an invalid later page into a smaller result set. This transition is explicit in all three inspected filter/pagination flows. Do not present draft structured filters as already applied.
8. **Contextual operations:** group row operations in **1** trailing action region or grid context menu; show bulk operations only in a selected-record context. Preserve a visible selection indication and count where bulk actions operate. Documenso's **1** action plus **1** menu is a useful starting point, not a limit on database-tool functionality.
9. **One pagination region:** place navigation below the collection with at least **2** directional controls, current position and the available count information. Disable impossible navigation; distinguish visible count, total and estimate. Use **10–50** page-size choices for ordinary business records only as a starting range; Studio's **100–1000** is a deliberate dense-grid exception.
10. **Loading is not empty:** reserve the collection's geometry with row-shaped skeletons or retain rows with a localized progress treatment. Show **0** empty-success messages while loading. All three have explicit loading branches; retained rows must not be presented as fresh results for newly applied criteria.
11. **Separate empty and failure:** provide distinct loading, successful-zero and error states within the collection. Keep the initial explanation to **1** short sentence and at most **1** recovery action; place technical diagnostics behind disclosure. The separation is shared; the sentence/action cap is this profile's fallback, not a measured invariant of every reference.
12. **Adapt controls, not legibility:** let control groups wrap or move to **1** extra strip; preserve a locally scrollable table when columns cannot fit. Keep at least the **2** directional pagination controls reachable. Dub/Documenso show table overflow and smaller-screen control changes; Studio shows header reflow. Verify the actual minimum target width instead of assuming source classes prove mobile usability.

## Slop markers for this type

| Observable defect | Concrete fix |
| --- | --- |
| Purple-blue gradient header, glow, decorative blob or emoji prefix on routine rows | Remove decorative layers; use the repository's neutral table surface and functional icon set. Keep colour tied to documented meanings. |
| Giant card per scalar field, hero-sized count or promotional headline above operational records | Return to aligned rows; put the result count beside pagination and use a short entity heading. |
| Five differently coloured filter buttons with no semantic distinction | Use one neutral control treatment; distinguish active constraints with selected styling, readable values and a removal control. |
| Search only finds current-page rows but visually promises collection-wide results | Search the intended dataset or explicitly label page-only scope; reset pagination when the committed query changes. |
| Empty result after applying a filter offers only creation | Keep the query/filters visible and offer one relevant clearing/editing action; reserve creation for genuinely empty collections. |
| Failure rendered as zero rows or an unknown total rendered as zero | Show an error/unknown state; keep retries or diagnostics local and label estimates explicitly. |
| Every row displays all secondary operations | Keep the frequent operation and one overflow entry point; show bulk actions after selection, with their scope and quantity. |
| Many animated placeholder cards or a celebratory empty-state illustration dominates the grid | Match the expected rows, preserve the shell, and use at most one proportionate state visual; no decorative loading theatre. |
| Filter changes retain page 9, making matching records appear absent | Reset to the first page/cursor on committed changes; handle deletion of the last row on a page too. |
| A full-width page scrollbar, covered last row or tiny mobile labels | Contain table overflow, reserve space for fixed controls, wrap the toolbar and test the smallest target width. |
| Truncated identifiers are distinguishable only by hovering | Provide a keyboard- and touch-accessible full-value/detail path; do not hide distinguishing text or reduce font size. |
| Tiny icon equals tiny hit target; hover is the only action affordance | Keep the glyph small but give its control adequate spacing/target size, an accessible name and visible keyboard focus. |

## Critic checklist

1. Does this item need cross-column comparison, a navigable list or cell editing, and is the chosen density justified by that task rather than a generic dashboard template?
2. Can a person identify each record and compare fields without clipped distinguishing text, misaligned numbers, oversized headings or decorative colour competition?
3. Is search scope explicit, are active filters visible/removable, and do committed changes reset pagination without silently losing unrelated state?
4. Are row and bulk actions contextual, named and reachable by keyboard/touch, with selection scope clear before destructive operations?
5. Are first/last-page controls correct, counts honest, page-size changes stable and fixed pagination unable to obscure the final row?
6. Do initial loading, refresh, genuine empty, filtered empty, later-page empty and failure have truthful, distinct presentations and appropriate recovery?
7. At the smallest target width and each shipped theme, do controls reflow, tables scroll locally, focus remain visible and text retain its readable scale?
8. Which judgments have source evidence, which have integrated visual/interaction evidence, and which remain explicitly unverified? Do not award visual or accessibility acceptance from source inspection alone.
