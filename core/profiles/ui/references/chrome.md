# App chrome: navigation, settings, dialogs and toasts

## Applies when

- **Sidebar:** the item changes persistent destinations, product areas, workspace switching or account navigation beside the main content.
- **Top bar:** the item changes the compact row identifying the current workspace/project, navigation controls or global utilities above the content. Not a marketing hero.
- **Settings:** the item edits saved account, workspace or project configuration, including permissions and destructive operations. Not a KPI dashboard.
- **Dialog:** the item interrupts a page for one bounded decision or short form, with a return to the invoking context. Not a substitute for a multi-page workflow.
- **Toast:** the item reports a transient operation result without blocking the page. Required corrections and unresolved errors also need persistent, local feedback.

Team design rules and approved exemplars override this fallback. Apply only the relevant subtype; do not add a sidebar, modal or toast merely to match a reference.

## References

These are complementary product references, not a claim that every screen in each product is exemplary.
Evidence is directly read public component source on the linked branches, not screenshots or a running-product audit.
Links are moving `master`/`main` links; no immutable revision was captured. Recheck them before requiring pixel fidelity.
Numbers written as Tailwind tokens are verified source declarations. Their conventional pixel equivalents, breakpoint thresholds and computed theme values are **unverified** here; no theme configuration or browser measurement was inspected.
Counts describe the inspected components, not every screen. No implementation code, UI strings, icons or images are reproduced.

### S — Supabase Studio: contextual navigation at small widths

Repository: [supabase/supabase](https://github.com/supabase/supabase).
License: Apache-2.0, declared in the inspected root [package.json](https://github.com/supabase/supabase/blob/master/package.json).
Why selected: it keeps project/organization scope visible in a compact mobile bar and changes the switcher's interaction model rather than shrinking the desktop popover.

Exact component files read:

- **S1:** [apps/studio/components/layouts/Navigation/NavigationBar/MobileNavigationBar.tsx](https://github.com/supabase/supabase/blob/master/apps/studio/components/layouts/Navigation/NavigationBar/MobileNavigationBar.tsx)
- **S2:** [apps/studio/components/layouts/Navigation/NavigationBar/OrgSelector.tsx](https://github.com/supabase/supabase/blob/master/apps/studio/components/layouts/Navigation/NavigationBar/OrgSelector.tsx)
- **S3:** [apps/studio/components/layouts/Navigation/NavigationBar/OrgSelectorSheet.tsx](https://github.com/supabase/supabase/blob/master/apps/studio/components/layouts/Navigation/NavigationBar/OrgSelectorSheet.tsx)
- **S4:** [apps/studio/components/layouts/Navigation/NavigationBar/StudioMobileSheetNav.tsx](https://github.com/supabase/supabase/blob/master/apps/studio/components/layouts/Navigation/NavigationBar/StudioMobileSheetNav.tsx)

Observations:

1. **Bar and actions (S1):** height token `h-12`, horizontal gaps `gap-2`, left/right padding `pl-2`/`pr-3`; hidden from `md` upward. Scope sits left; account/local-environment control and optional menu sit right: at most 2 right-side controls. Project scope adds 1 connection control. The optional back control is explicitly 30 × 30 px with a 16 px icon and 1.5 stroke width. Surface/border/foreground tokens provide hierarchy, not a hero heading.
2. **Switcher hierarchy and copy (S2):** one organization-name line above one `text-xs` project-count line; name width constrained to 100–250 px. Initial avatar uses `w-8`, count icon `size-3`, disclosure icon `w-4`/`h-4`. Search prompt and no-match message are 2 and 3 English words respectively, operational rather than promotional. Below results are 1 directory action and optionally 1 creation action; neutral surface and foreground tokens dominate.
3. **States (S2):** organization loading replaces the trigger with a 120 px-wide shimmer. Search has an explicit no-match message. More than 7 organizations enables a desktop list height of 210 px. A query-error presentation is **unverified**: this component reads pending/data but does not render a dedicated error branch. Missing project-count data falls back to an absence label; do not infer that unknown data is genuinely empty.
4. **Responsive structure (S2–S4):** desktop uses a start-aligned popover; mobile uses a sheet with explicit height `85dvh` and a `md` maximum of 500 px. Its heading is screen-reader-only; the visible scope label uses `text-xs` and a 16 px icon with 1.5 stroke width. Shared mobile sheet content is selected by navigation context; dismissal clears that context. This is source-level behavior, not verified touch or focus behavior.

### D — Dub: dense navigation and bounded settings sections

Repository: [dubinc/dub.link](https://github.com/dubinc/dub.link), the destination returned for `dubinc/dub` during research.
License: AGPL-3.0-or-later, declared in the inspected root [package.json](https://github.com/dubinc/dub.link/blob/main/package.json).
Why selected: the sidebar separates product-area navigation from local destinations, while ordinary settings use compact, independently actionable sections.

Exact component files read:

- **D1:** [apps/web/ui/layout/sidebar/sidebar-nav.tsx](https://github.com/dubinc/dub.link/blob/main/apps/web/ui/layout/sidebar/sidebar-nav.tsx)
- **D2:** [apps/web/ui/layout/sidebar/app-sidebar-nav.tsx](https://github.com/dubinc/dub.link/blob/main/apps/web/ui/layout/sidebar/app-sidebar-nav.tsx)
- **D3:** [apps/web/ui/layout/main-nav.tsx](https://github.com/dubinc/dub.link/blob/main/apps/web/ui/layout/main-nav.tsx)
- **D4:** [apps/web/ui/layout/settings-layout.tsx](https://github.com/dubinc/dub.link/blob/main/apps/web/ui/layout/settings-layout.tsx)
- **D5:** [apps/web/ui/workspaces/upload-logo.tsx](https://github.com/dubinc/dub.link/blob/main/apps/web/ui/workspaces/upload-logo.tsx)
- **D6:** [apps/web/ui/workspaces/delete-workspace.tsx](https://github.com/dubinc/dub.link/blob/main/apps/web/ui/workspaces/delete-workspace.tsx)
- **D7, counterexample:** [apps/web/ui/workspaces/slack-support-settings-card.tsx](https://github.com/dubinc/dub.link/blob/main/apps/web/ui/workspaces/slack-support-settings-card.tsx)

Observations:

1. **Sidebar density (D1–D2):** explicit widths are 304 px expanded, 64 px for the product rail and 240 px for the area column. Destination rows use `h-8`, `text-sm`, `size-4` icons and `gap-2.5`; rail controls use `size-11` with `size-5` icons. Area headings use `text-lg` semibold. Workspace settings contain 3 named groups with 6, 5 and 1 destinations; their labels are 1–2 words. This organization is worth borrowing, not the exact menu inventory.
2. **Selection and adaptation (D1–D3):** neutral surfaces surround blue active leaf links; selected leaves also gain medium weight. Locked destinations replace their icon with a lock and set `aria-disabled`. Below the CSS `lg` layout, navigation is an off-canvas panel; pathname changes close it, and opening it off desktop locks body scrolling. Inactive area panels are inert. The exact JS/CSS breakpoint alignment is **unverified**.
3. **Settings anatomy (D4–D6):** the layout is a single-column grid with `gap-5`. Logo and deletion sections each have `p-6` bodies, `text-base` semibold headings and `text-sm` muted explanations. The logo heading has 2 words, followed by 2 short explanatory sentences; its footer has 1 save action. Body/footer arrangements stack below `sm`; desktop aligns the save action to the right. Deletion has 1 danger action, a red-tinted footer and a separate confirmation-modal trigger, not a red treatment on every section.
4. **State evidence and rejection (D5–D7):** logo saving passes a loading state to its button, disables unchanged/absent/unauthorized submissions, and emits success or server-error toasts. A missing logo passes null to the upload control; its rendered empty appearance is **unverified**, as are toast placement/duration and network-rejection recovery. D7's support promotion contains multiple purple/pink gradients and blurred blobs: explicitly excluded from this reference's positive direction. Do not transfer it into ordinary settings.

### C — Documenso: task dialogs and restrained result feedback

Repository: [documenso/documenso](https://github.com/documenso/documenso).
License: GNU AGPL v3, verified in [LICENSE](https://github.com/documenso/documenso/blob/main/LICENSE) and the inspected [README.md](https://github.com/documenso/documenso/blob/main/README.md). No claim about separate commercial licensing.
Why selected: its passkey dialog connects an actual asynchronous settings task to a shared dialog, button and toast system, making action hierarchy and feedback traceable beyond a static component demo.

Exact component files read:

- **C1:** [apps/remix/app/components/dialogs/passkey-create-dialog.tsx](https://github.com/documenso/documenso/blob/main/apps/remix/app/components/dialogs/passkey-create-dialog.tsx)
- **C2:** [packages/ui/primitives/dialog.tsx](https://github.com/documenso/documenso/blob/main/packages/ui/primitives/dialog.tsx)
- **C3:** [packages/ui/primitives/toast.tsx](https://github.com/documenso/documenso/blob/main/packages/ui/primitives/toast.tsx)
- **C4:** [packages/ui/primitives/button.tsx](https://github.com/documenso/documenso/blob/main/packages/ui/primitives/button.tsx)

Observations:

1. **Dialog frame (C1–C2):** full width below `sm`, `sm:max-w-lg` above it, `p-6` padding and `gap-4`; title `text-lg` semibold and description `text-sm` muted. The close glyph uses `h-4`/`w-4` and offsets `top-4`/`right-4`. Footer actions stack in reverse column order on small screens, then form a right-aligned row with `space-x-2`. The passkey caller explicitly centers its dialog.
2. **Copy and actions (C1):** one required name field; a 2-word task title and 1-sentence purpose description; 2 one-word footer actions, secondary cancellation and primary continuation, plus the frame's close control. Two further instructional paragraphs explain the OS authenticator handoff. Borrow the bounded task/action structure, not a rule that every dialog needs that much guidance.
3. **Pending and error states (C1, C4):** submission disables the fieldset, blocks ordinary open-state changes and shows a loader in the primary button. Default buttons use `h-10`, `text-sm` and a `h-5`/`w-5` spinner. Errors appear inside the form as a destructive alert; one branch contains a 3-item reason list. Field validation has a local message slot. The form resets after closing; a generic empty-state illustration is not applicable. Runtime cancellation, focus return and long-content overflow remain **unverified**.
4. **Toast feedback (C1, C3):** successful completion requests a 5,000 ms toast containing a 3-word result description and no action, then closes the dialog. The toast viewport is full width at the top on small screens, bottom-right from `sm`, capped explicitly at 420 px from `md`, with `p-4` inset. Toast content uses `text-sm`, `p-6` and `pr-8`; the close glyph is `h-4`/`w-4`. Default surfaces are neutral; destructive toasts use semantic destructive colors. No toast-count limit is verified in these files.

## Defaults for this type

The shared direction is compact hierarchy, local action scope, semantic color and responsive recomposition.
The following 14 rules operationalize that direction. Bracketed IDs identify supporting examples, not unanimous numeric specifications: exact fallback values are recommendations, not measurements shared by all three products.
Accessibility and robustness requirements below must be verified independently; importing a primitive does not prove them.

1. **Scope before utilities:** keep 1 current workspace/project identity at the start of the shell and account/menu controls at the end. Separate product-area navigation from local destinations only when both levels exist. [S1–S2, D1–D2]
2. **Compact shell:** start with a 48 px top bar and a 240 px labeled sidebar; add a 64 px product rail only for genuine area switching. Keep shell content to navigation/context, with 0 hero paragraphs or KPI cards. Adapt dimensions to existing tokens and label length. [S1, D1]
3. **Hierarchy:** use 14 px navigation/body text, 16 px settings-section headings and 18 px dialog/area headings as fallback tokens; at most 2 competing font weights per component. Keep one primary task heading, not a display-sized marketing title. [D1, D5–D6, C2–C3]
4. **Icon rhythm:** use one established icon family; 16 px glyphs beside text and 20 px for standalone navigation. Use an 8 px label gap and 16–24 px section padding. Glyph size is not hit-target size: provide at least 44 × 44 px touch targets without enlarging the glyph. [S1–S3, D1, C2–C4; touch minimum is a fallback safeguard]
5. **Color has a job:** neutral shell/content surfaces, at most 1 interaction accent plus semantic status colors. Mark selection with background/weight and accessible current-location semantics, not color alone. Reserve destructive treatment for destructive controls and errors. [S1–S3, D1, D6, C1–C4]
6. **Literal copy:** aim for 1–3-word navigation/action labels and 1 short purpose sentence per settings section or dialog. Put indispensable security consequences next to the relevant decision; never shorten them into ambiguity. No promotional slogans or emoji. Allow localized text to wrap rather than enforcing English word counts. [S2, D2, D5–D6, C1]
7. **Settings grouping:** give each independently saved section 1 heading, its fields and 1 primary save action in a footer aligned to those fields. Use 20–24 px between sections; separate destructive operations from ordinary saves. Disable unchanged submissions and explain permission restrictions. [D4–D6, C1]
8. **Dialog scope:** one bounded task, 1 primary action and at most 1 secondary footer action, plus a labeled close control. Start with a 512 px desktop maximum, 24 px padding and 16 px gaps; cap height to the available viewport and make long content scroll without hiding actions. [C1–C2; viewport cap is a safeguard, not verified upstream behavior]
9. **Responsive recomposition:** replace the sidebar with a menu-triggered sheet when it no longer fits; stack settings rows and dialog actions rather than shrinking text. Verify at 360 px, 768 px and 1280 px plus 200% zoom; require 0 unreachable controls or page-level horizontal overflow. The breakpoint follows actual fit, not a copied product constant. [S1–S4, D3, D5, C2–C3]
10. **Pending stays local:** preserve shell/section geometry with a trigger-sized placeholder or one in-button spinner. Disable duplicate submission only for the affected task; preserve entered values and restore controls after rejection. Never replace the whole app with a loader for one save. [S2, D5, C1, C4]
11. **Empty is not failed:** distinguish pending, no results, no configured data and failed retrieval. For an applicable empty state use at most 1 visual, 1 explanatory sentence and 1 next action; for a field error put the correction beside that field. Unknown counts must not become zero or an absence claim. [S2, C1; explicit separation corrects the observed evidence gap]
12. **Toast is a receipt:** emit 1 result notification after confirmed completion, not on click. Start with one short sentence, at most 1 optional recovery action plus dismissal, a 420 px desktop width cap and 16 px viewport inset. Start routine success at 5 seconds; unresolved errors need a persistent local explanation, not only a timer. [D5, C1, C3]
13. **Overlay accessibility:** reuse the established dialog/sheet/toast primitives; verify an accessible name for every icon-only control, focus containment and return for dialogs, keyboard dismissal when safe, and non-focus-stealing toast announcements. Test at least keyboard opening, completion, cancellation and failure. [S1, S3–S4, D1, C2–C3; behavioral verification required]
14. **Disclose, do not lose:** preserve full destination names, dialog titles and error messages at supported widths; wrap or offer an accessible full-text expansion instead of shrinking the font. Long lists scroll inside their own region while scope and dismissal stay reachable. [S2–S3, D1, C2; title truncation is not endorsed]

## Slop markers for this type

| Observable defect | Concrete fix |
| --- | --- |
| Purple/blue promotional gradients, blurred blobs or glows behind routine settings; a different accent for each destination | Remove decoration; use neutral surfaces, one selection accent and semantic status colors. D7 is a counterexample, not permission. |
| Oversized welcome heading, generic hero copy or number-only cards consume the shell/settings viewport | Replace them with one compact scope/task heading; move actual metrics to the appropriate content view. |
| Emoji navigation, mixed icon families or large icon tiles competing with labels | Reuse one established family at 16/20 px; remove icons that convey no meaning. |
| Every setting is a spacious card with multiple competing calls to action | Group related fields, use 16–24 px padding and one save action per independent transaction. |
| Entire settings page is red because one operation is destructive | Isolate the danger section; explain consequences and request confirmation only for that action. |
| Desktop sidebar compressed into unreadable mobile labels, or a modal footer outside the viewport | Switch to a sheet/stacked layout; constrain scroll regions and keep actions reachable. |
| Success toast before the response, repeated receipts, or server errors vanish while input remains invalid | Wait for confirmed completion; deduplicate the operation result; retain actionable errors in the form. |
| Shimmer lasts forever, an unknown count looks empty, or a failed save leaves a disabled button | Add explicit failure/retry handling and restore controls; keep unknown, empty and pending distinct. |
| Dialog title ellipsized, dismissal discoverable only on hover, or tooltip substitutes for an essential label | Wrap the title, expose an accessible dismissal control and keep essential text available. C2's truncation and C3's desktop hover-close treatment are not defaults. |

## Critic checklist

1. Is this actually shell/settings/dialog/toast work, and do repository rules or an approved exemplar override any proposed default?
2. Can a person identify current scope and destination without opening another menu, with a distinct active state and readable localized labels?
3. Are heading, icon and spacing tokens consistent with the selected reference, and is there only one primary action per transaction?
4. At 360/768/1280 px and 200% zoom, are all destinations, fields, dialog actions and dismissals reachable without clipped text or page overflow?
5. Have pending, empty, unauthorized and failure paths been demonstrated where applicable, without turning unknown data into a plausible value or losing edits?
6. Do keyboard focus, accessible names, safe dismissal and toast announcements work in the integrated interface, rather than merely being inferred from imports?
7. Are results reported only after confirmation, with persistent correction guidance for unresolved errors and no duplicate notifications?
8. Is every decorative element or extra action justified by the task, and are source facts, fallback recommendations and unverified behavior clearly distinguished?
