# UI references: marketing, pricing and documentation

## Applies when

- **Marketing landing:** the item asks for a public home, product, feature or campaign page whose job is to explain a product and lead to signup, a demo or another concrete next step.
- **Pricing:** the item asks visitors to compare plans, billing periods, included allowances or usage costs before choosing a plan. Account invoices and subscription administration are not this type.
- **Documentation:** the item asks for guides, installation instructions, API/component reference, examples or documentation search. The primary task is finding and using an answer, not conversion.
- For mixed pages, apply the matching rules per region: a documentation article does not inherit a marketing hero's scale or CTA density.

**Precedence:** the team's design rules, existing tokens and approved references win. This is a fallback and a critic's aid, not permission to replace an established visual identity or weaken checks.

## References

These are three complementary open-source references, selected for the specific strengths below, not a claim that every part of their sites should be imitated.
Evidence is the public component source linked here; no code, product copy, icons or images are reproduced.
Links use the branches read and may change. This is source inspection, not browser or screenshot verification.
Tailwind utility names are the directly observed measurements. Pixel equivalents below assume its standard scale and a 16px root; computed CSS, custom overrides, contrast and rendered wrapping remain **unverified**.

### S — Supabase: product explanation and substantive pricing

Repository: <https://github.com/supabase/supabase>.
License: Apache-2.0, verified in the root [LICENSE](https://github.com/supabase/supabase/blob/master/LICENSE).
Why selected: a compact product-specific hero and plans that explain allowances, overages and restrictions instead of presenting isolated large prices.

Exact source files read:
- [apps/www/app/(home)/_components/Hero.tsx](https://github.com/supabase/supabase/blob/master/apps/www/app/%28home%29/_components/Hero.tsx)
- [apps/www/components/Pricing/PricingPlans.tsx](https://github.com/supabase/supabase/blob/master/apps/www/components/Pricing/PricingPlans.tsx)
- [apps/www/components/Pricing/UpgradePlan.tsx](https://github.com/supabase/supabase/blob/master/apps/www/components/Pricing/UpgradePlan.tsx)
- [packages/shared-data/plans.ts](https://github.com/supabase/supabase/blob/master/packages/shared-data/plans.ts)

Observations:
1. **Hero hierarchy and copy:** 1 heading, 2 block spans, 7 heading words and a 2-sentence explanation naming the database and capabilities. Heading uses `text-4xl sm:text-5xl` (nominally 36/48px). The heading/description grid changes from 1 to 2 columns at `lg`; the outer gap changes from `gap-6` to `lg:gap-8` (24/32px).
2. **Actions and colour:** the hero has exactly 2 CTA links, each with a 3-word label: a primary project action and a secondary sales action. Their gap is `gap-2` (8px). Foreground/muted tokens carry text hierarchy, while the second heading span and primary action use the primary token; no gradient or decorative background is declared in this hero.
3. **Plan comparison:** 4 plans become 1, 2 and 4 columns at base/`lg`/`xl`. Each has 1 main CTA, a 1-sentence description and 6–9 feature entries. Plan names use `text-2xl`; prices use `text-5xl`, with the custom-price tier at `text-4xl`. Check icons are `h-4 w-4` (16px), feature text is explicitly 13px, and rows use `py-2` (8px per side). Only 1 plan gets a 2px emphasis border and recommendation badge. Units and overage rates remain beside the relevant amounts/features.
4. **States:** the upgrade selector has a 3-word no-match message; selected rows use a check, and continuation is disabled before selection. Its footer has 2 actions, cancellation and continuation. The static plan list declares no loading/error UI: asynchronous pricing loading/error presentation is **unverified**, not evidence that it is unnecessary. The selector's fixed 300px popover fit on narrow screens is also **unverified**.

### R — Radix Themes: a product demonstration beside the pitch

Repository: <https://github.com/radix-ui/website>.
License: MIT, verified in the root [LICENSE](https://github.com/radix-ui/website/blob/main/LICENSE).
Why selected: visitors can see what the library produces and reach implementation or a playground without navigating a wall of promotional cards. Borrow the demonstration/CTA structure, not its decorative treatment.

Exact source files read:
- [app/(default)/page.client.tsx](https://github.com/radix-ui/website/blob/main/app/%28default%29/page.client.tsx)
- [components/serif-heading.tsx](https://github.com/radix-ui/website/blob/main/components/serif-heading.tsx)
- [components/themes-hero-layout.tsx](https://github.com/radix-ui/website/blob/main/components/themes-hero-layout.tsx)
- [components/themes-hero-layout.module.css](https://github.com/radix-ui/website/blob/main/components/themes-hero-layout.module.css)

Observations:
1. **Pitch and scale:** the headline is 5 words with 1 explicit line break; supporting copy is 2 sentences about the library and setup. Prose/code/actions are bounded to 500px. Heading sizes are Radix tokens `8` then `9` at `xs`, regular weight, with a font-size adjustment of 1.1; the separate desktop heading overrides the adjustment to 1.3 and line-height to 0.9. Actual rendered heading pixels are **unverified**.
2. **Action hierarchy:** 2 main CTAs follow the code sample, using a solid high-contrast gray button and a soft secondary button. Labels contain 2 and 1 words. The action gap is token `4`; direction changes from column to row at `xs`. The primary arrow is explicitly 14×14px; the secondary icon is 18×18px. A separate announcement link and showcase controls exist; the entire hero is not limited to 2 interactive elements.
3. **Responsive proof:** below 1280px, the layout stacks and the showcase has its own horizontal scroller; at 1280px the main column becomes 560px and sits beside the showcase. The demonstration uses a 1760px base width with breakpoint-dependent scaling. It is marked `aria-hidden`, and examples receive `focusable={false}`: this is illustrative proof, not a substitute for a usable live application. Keep any real interactive demo accessible instead.
4. **Colour and states, with exclusions:** the source declares 6 showcase variants and multicolour radial backgrounds, including indigo/violet/purple/blue; its code sample also contains an emoji. These are **not fallback defaults**. Use a neutral surface and the host product's accent instead. Controls return nothing until the first client effect; no loading/empty/error visual is declared in the inspected hero files. Those asynchronous states and reduced-motion behaviour are **unverified**.

### D — shadcn/ui: answer-first documentation

Repository: <https://github.com/shadcn-ui/ui>.
License: MIT, verified in the root [LICENSE.md](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md).
Why selected: a bounded article column, immediate working examples, local code controls and compact navigation keep documentation distinct from a sales page.

Exact source files read:
- [apps/v4/app/(app)/docs/[[...slug]]/page.tsx](https://github.com/shadcn-ui/ui/blob/main/apps/v4/app/%28app%29/docs/%5B%5B...slug%5D%5D/page.tsx)
- [apps/v4/mdx-components.tsx](https://github.com/shadcn-ui/ui/blob/main/apps/v4/mdx-components.tsx)
- [apps/v4/components/component-preview.tsx](https://github.com/shadcn-ui/ui/blob/main/apps/v4/components/component-preview.tsx)
- [apps/v4/components/command-menu.tsx](https://github.com/shadcn-ui/ui/blob/main/apps/v4/components/command-menu.tsx)
- [apps/v4/content/docs/components/base/button.mdx](https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/components/base/button.mdx)

Observations:
1. **Reading hierarchy and tone:** the article uses `max-w-160` (nominally 640px), `gap-6` (24px), `px-4` below `md`, and `text-3xl` (30px) for its title. The sampled button page has a 1-word title and an 11-word factual description, then an example before installation/usage. Body size is explicitly 1.05rem initially and 15px at `sm`; this is documentation scale, not a landing headline.
2. **Navigation and adaptation:** the header offers up to 2 neighbour links plus a copy-page control hidden below `sm`. Neighbour buttons are `size-8 md:size-7` (32/28px) with an extended-touch-target class. The sticky right-hand contents rail appears only at `xl`; it is not squeezed beside the article on mobile. Code blocks declare local overflow scrolling; code-caption icons use `size-4` (16px).
3. **Colour and local controls:** foreground/muted tokens separate title and description. Documentation tabs use a 2px active bottom border, foreground text and no active shadow, rather than a coloured panel per tab. Code blocks expose a copy control when raw text is available. Search selection combines a border and background, not hue alone.
4. **States:** search shows a `size-4` muted spinner in the input and a short loading message, then a 3-word no-results message in `text-sm` with `py-12` spacing. A missing preview renders 1 muted paragraph containing the requested component identifier, not a celebratory illustration. Missing pages invoke `notFound()`, but the resulting page appearance is **unverified**. A distinct search network-error presentation is **unverified**; do not mistake no results for a failed request.

## Defaults for this type

The shared direction is bounded text, explicit hierarchy, compact actions and responsive separation of content from supporting UI.
The numbers below operationalize that direction; they are fallback targets, not a claim that all three repositories use identical tokens or implement every state.
Bracketed letters identify the relevant evidence. Type-specific rules apply only to that type; accessibility/state safeguards fill the explicitly noted evidence gaps.

1. **Separate the jobs.** Landing: 1 product proposition followed by proof and a next step. Pricing: plan comparison before explanatory FAQ content. Docs: title, purpose, example/instructions before promotional content. Do not insert a signup hero between an article title and its answer. [S, R, D]
2. **Constrain the introduction.** Use 1 visible primary heading and 1 supporting paragraph of at most 2 sentences. For landing copy, name the product category and a concrete task/outcome; target 6–12 heading words and at most 2 rendered lines. Docs titles name the task or component, not a slogan. Rewrite or reflow long translations; never truncate them. [S, R, D]
3. **Use different type scales.** Start landing headings at 36px on small screens and 48px on wide screens; docs titles at 30px; body text at 16px. Use at most 2 competing weights in a text block. Map these to existing tokens rather than importing Radix's display multiplier or shrinking copy to fit. [S, R, D]
4. **Limit conversion choices.** A landing hero gets 1 primary CTA and at most 1 secondary CTA, with 1–3-word action labels and an 8–16px gap. Treat announcement/navigation links as visually subordinate, not extra filled CTAs. Docs may have 2 neighbour links and 1 copy control; they are utilities, not conversion buttons. [S, R, D]
5. **Bound prose, not the whole page.** Cap supporting landing prose near 500px and documentation articles near 640px. Use 16–24px small-screen horizontal padding, 24–32px between major content groups, and 8–16px between related controls. Wide comparison tables and demonstrations may exceed the prose width inside their own region. [S, R, D]
6. **Keep colour semantic.** Start with neutral surfaces, foreground/muted text and at most 1 chromatic brand accent per region. Reuse that accent for primary action, selection or deliberate emphasis; add a label/border/icon when colour communicates state. Status and syntax colours are functional exceptions, not extra decorative accents. [S, D; R's neutral CTA treatment only]
7. **Show specific proof.** Place 1 relevant product view, working example or code sample beside/below the landing proposition; docs examples precede detailed API tables where practical. Explain what the example demonstrates in at most 1 short caption when it is not self-evident. Label sample data and never invent customer logos, testimonials or metrics. [R, D; honesty safeguard]
8. **Make plans comparable.** Start with at most 4 plan columns on wide screens, 2 at an intermediate width and 1 on small screens. Each plan has a name, 1-sentence audience description, price/custom-price label, billing unit, included limits and 1 main CTA. Keep row order consistent and highlight at most 1 recommendation. [S]
9. **Explain the price, not just its number.** Keep units and billing cadence adjacent to every amount; put overage rates and limits beside their features. If a monthly/annual toggle exists, show its selected state and annual commitment explicitly. Use 24px plan names, 36–48px prices and at least 14px readable details as fallback targets; do not copy the source's 13px details blindly. [S; billing-toggle safeguard]
10. **Keep icons subordinate.** Use the existing icon set at 16px for checks, code captions and inline controls; permit 14–18px where a control's established scale requires it. Use at most 1 icon per simple CTA. Icon-only controls require an accessible name; an icon's size is not its touch target. [S, R, D]
11. **Adapt instead of miniaturizing.** At 375px, 768px and 1440px, verify no page-level horizontal overflow, clipped labels or CTA collisions. Stack hero regions and plan columns; move/hide the secondary docs rail without hiding article content. Keep horizontal scrolling local to code, comparison tables or labelled illustrative demos; do not scale down a real interactive application to fit. [S, R, D; test widths are fallback targets]
12. **Make docs navigable.** Provide a labelled search entry in the docs shell, anchored section headings and at most 2 previous/next controls per navigation group. Reserve the right contents rail for widths that leave the article readable; use local copy controls on copyable code. Search and article links must remain keyboard operable. [D]
13. **Keep asynchronous states local and distinct.** For each remote search, calculator, signup or checkout action, specify loading, empty, error and success as applicable. Preserve the affected region during loading; use at most 1 state visual, 1 explanatory sentence and 1 recovery action for empty/error states. Preserve input on failure, prevent duplicate submission and never substitute zero/free/no-results for unavailable data. Static prose needs no fabricated loading state. [S, D; missing-state safeguard]
14. **Verify access, not just appearance.** Give controls visible focus and at least 44×44px touch targets, extending compact visuals where necessary. Check normal text contrast at 4.5:1 and large text at 3:1 in each shipped theme. Verify keyboard traversal, reduced motion and 200% zoom; source tokens alone do not prove these pass. [D's extended targets; accessibility safeguard]

## Slop markers for this type

| Observable defect | Concrete fix |
| --- | --- |
| Purple-blue gradient, glow, decorative blobs or several competing accent colours with no product meaning | Remove the decorative layer; restore neutral surfaces and 1 functional accent. Radix's background is explicitly excluded from this fallback. |
| Emoji in headings, CTA labels, plan badges or state text | Use plain language; use an existing semantic icon only if it adds information. Do not copy emoji from example code into product UI. |
| A hero promise that could describe any product, or 3+ heading lines at target widths | Name the product category and task; shorten to a specific proposition and reflow within the heading budget. |
| 3+ equally prominent hero buttons, or repeated announcement/promotion pills | Keep 1 primary and at most 1 secondary conversion action; demote navigation and remove redundant promotions. |
| Oversized cards containing only a metric, a price or a vague feature title | Pair price with audience, units and limits; pair proof with its source/context. Remove unsupported metrics and unnecessary containers. |
| Every pricing tier is recommended, annual billing is disguised as monthly, or overages are buried | Highlight at most 1 plan, state cadence/commitment beside amounts and expose feature-level limits before selection. |
| Documentation opens with a sales pitch, giant cards or a display-size slogan | Restore a 30px task title, bounded article and immediate example/instructions; keep promotion out of the answer path. |
| A scaled screenshot masquerades as a usable app, or mobile loses pricing details | Label illustrative proof; provide an accessible real example separately. Stack plans and retain labels; scroll only the necessary region. |
| Endless skeleton, empty search after network failure, or error replacing the whole landing | Distinguish loading/no-match/failure; preserve static content and input; provide 1 local recovery action. |
| Text shrunk, clipped, hidden under tooltips or excluded from checks to satisfy a layout | Fix copy and layout at target widths; preserve legibility checks and report unresolved evidence gaps. |

## Critic checklist

1. Is the region correctly classified, and do the team's actual rules take precedence over these fallback values?
2. Can a visitor identify the product/task and next step from 1 heading and at most 2 supporting sentences, without generic promises?
3. Is there 1 primary landing action, at most 1 secondary, and specific, honestly labelled product proof rather than invented credibility?
4. Can a buyer compare every plan's price, unit, commitment, limits and overages before clicking, with at most 1 recommendation?
5. Can a docs reader find an example, navigate sections and copy code without sales content interrupting the task?
6. At small, intermediate and wide widths, do text, controls, plan rows and local scroll regions remain legible without miniaturizing interactive content?
7. Are applicable loading, no-results, error and success states distinct, local and recoverable, and are unverified cases named rather than assumed to pass?
8. Do colour, icons, spacing, focus, contrast and touch targets support the task without excluded decoration, emoji, clipping or weakened checks?
