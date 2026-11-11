# Forms, validation and authentication

## Applies when

- **Forms:** an item creates or edits a record, profile, setting or preference through labelled
  inputs and a submit/save action, whether on a page, in a dialog or in a drawer.
- **Validation:** an item changes required fields, constraints, helper text, error placement,
  submission feedback, disabled controls or recovery from a rejected request.
- **Authentication:** an item covers sign-in, registration, provider selection, password recovery,
  email verification, passkeys or a second-factor challenge. Treat each step as its own task.
- These are fallback references and a critic's lens, not a replacement design system.
  Existing team rules, tokens, approved assets, locale and neighbouring screens take precedence.
  Do not apply a narrow auth shell to a complex editor or invent authentication methods.

## References

Evidence is public component source, not screenshots or live interaction tests. File paths below
are the exact files opened; links use the branches read. Recorded branch heads are provenance,
not proof that every fetch was an atomic snapshot. No code, UI wording, icons or images are copied.
Utility names are evidence: parenthesized px values for standard Tailwind utilities are nominal
conversions at a 16px root, **unverified as computed CSS**; theme overrides were not audited.
Explicit bracketed px values and numeric props are source values. Visual quality is a reasoned
selection of particular patterns, not a claim that every screen in these products is exemplary.

### S — Supabase Studio: focused credentials and reusable field hierarchy

Repo: https://github.com/supabase/supabase
License: **Apache-2.0**, confirmed by the repository's [LICENSE metadata][s-license].
Branch read: `master`; head recorded: `86db293ec4aaacc43727661c966e632ed914adbf`.
Choose it for a compact credential flow and consistent label/control/message composition.

Exact files read:
- [apps/studio/pages/sign-in.tsx][s-page]
- [apps/studio/components/interfaces/SignIn/SignInForm.tsx][s-form]
- [apps/studio/components/interfaces/SignIn/SignInOptions.tsx][s-options]
- [apps/studio/components/interfaces/SignIn/ForgotPasswordWizard.tsx][s-reset]
- [apps/studio/components/layouts/SignInLayout/SignInLayout.tsx][s-layout]
- [packages/ui-patterns/src/form/FormItemLayout/FormItemLayout.tsx][s-item]
- [packages/ui-patterns/src/form/Layout/FormLayout.tsx][s-field]
- [packages/ui/src/components/Button/Button.tsx][s-button]
- [packages/ui/src/components/shadcn/ui/input.tsx][s-input]
- [packages/ui/src/lib/constants.ts][s-size]

1. **Composition and responsiveness:** 2 credential fields in 1 column, `gap-4` (16px);
   field labels sit above controls with `gap-2` (8px), errors below with `mt-2` (8px).
   The shell explicitly uses 330px width, then 384px at `sm`; the testimonial aside is hidden
   until `xl`. The standard heading uses `lg:text-3xl` (30px), with `text-sm` supporting text.
2. **Actions and tone:** 1 full-width credential submit, 1 password reveal control and 1 recovery
   link adjacent to the password label; registration sits below the form. Provider actions are
   configuration-dependent, not a fixed count. The standard heading has 2 words, its subheading
   5, and submit 2: brief, task-oriented copy rather than a promotional paragraph.
3. **Controls and colour:** the submit's large variant explicitly sets 42px height and 20px
   spinner/icon shells; the default tiny reveal button has a 14px icon shell. Primary-solid
   tokens emphasize submit; labels use foreground, secondary copy lighter foreground, and field
   errors destructive tokens. The button includes a subtle surface gradient, not a hero backdrop.
4. **States:** submit loading disables the button and adds a spinner; credentials also disable.
   Schema errors are placed under fields; authentication failures use a toast or top alert.
   Initially empty credentials have placeholders, not an illustrated empty state. Recovery changes
   from 1 email field to 1 six-digit code field, an account-neutral notice and 1 submit action.

**Limits / counterexamples:** narrow-viewport fit is unverified; 330px plus shell padding can
exceed a 320px viewport. Do not copy that fixed-width constraint. Some auth failure toasts are
long; use the field hierarchy, not their verbosity. Actual colour values and contrast are unverified.

### D — Documenso: ordinary editing plus staged authentication

Repo: https://github.com/documenso/documenso
License: **AGPL-3.0**, confirmed by the repository's [LICENSE metadata][d-license].
Branch read: `main`; head recorded: `fdd0337bdd8f6afac64faf97113c65ed2dd0e2a2`.
Choose it for the same form grammar across profile editing, credentials and a second-factor step.

Exact files read:
- [apps/remix/app/routes/_unauthenticated+/signin.tsx][d-page]
- [apps/remix/app/routes/_unauthenticated+/_layout.tsx][d-layout]
- [apps/remix/app/routes/_unauthenticated+/check-email.tsx][d-email]
- [apps/remix/app/components/forms/signin.tsx][d-form]
- [apps/remix/app/components/forms/profile.tsx][d-profile]
- [packages/ui/primitives/button.tsx][d-button]
- [packages/ui/primitives/input.tsx][d-input]
- [packages/ui/primitives/form/form.tsx][d-field]

1. **Scale and layout:** auth uses `w-screen max-w-lg` (nominal 512px cap), outer `px-4`
   (16px) and card `p-6` (24px). The heading is `text-2xl` (24px), description `text-sm`
   (14px), field gaps `gap-y-4` (16px). Inputs are `h-10` (40px), auth buttons `h-11`
   (44px), provider icons 16–20px nominal. Input text changes from 16px to 14px at `md`.
2. **Hierarchy and tone:** 1 credential submit, 1 passkey action and up to 3 configured provider
   buttons; alternatives are outlined, not competing primary fills. Recovery and registration
   are links. Heading: 5 words; welcome sentence: 9; submit: 2. The profile has 2 editable
   values (name/signature), 1 disabled email field and 1 trailing-edge save action.
3. **Validation and pending:** each editable field has a message slot; errors use `text-xs`
   destructive text (12px nominal), and invalid inputs get a 2px destructive ring. Controls
   receive `aria-invalid` and message IDs. Pending disables the fieldset; the button shows a
   20px nominal spinner and a changed label. Server failures use destructive toasts.
4. **Progression and completion:** the second-factor dialog appears only after the server requests
   it: 6 code slots or 1 backup-code field, 1 method switch and 1 submit. Initially empty fields
   remain ordinary inputs. The reset-email completion screen has 0 illustrations, 1 explanatory
   paragraph and 1 return action; its English paragraph has 20 words and avoids confirming an account.

**Limits / counterexamples:** the shared auth backdrop uses a masked image, and the welcome
sentence is generic; neither is a fallback default. The completion heading is `text-4xl`, unlike
the smaller sign-in heading. Mobile clipping, focus management and contrast are unverified at runtime.

### F — Formbricks: mobile-aware auth and explicit inline validation

Repo: https://github.com/formbricks/formbricks
License: **AGPLv3 for the inspected auth/UI files**, per [LICENSE][f-license]. This is open-core:
`apps/web/modules/ee` has separate terms; selected SDK/survey packages use MIT. Imported enterprise
SSO/2FA components were not inspected and are not treated here as verified open-source exemplars.
Branch read: `main`; head recorded: `fa0546bda2f53c3e39440dd6cc240c191e1dda10`.
Choose it for fluid auth containment, mobile input sizing and localized, field-local error slots.

Exact files read:
- [apps/web/modules/auth/login/components/login-form.tsx][f-form]
- [apps/web/modules/auth/components/form-wrapper.tsx][f-layout]
- [apps/web/modules/auth/forgot-password/email-sent/page.tsx][f-email]
- [apps/web/modules/ui/components/button/index.tsx][f-button]
- [apps/web/modules/ui/components/input/index.tsx][f-input]
- [apps/web/modules/ui/components/form/index.tsx][f-field]

1. **Responsive shell:** `min-h-dvh`, full width, outer padding 16px horizontal/32px vertical,
   increasing to 24px/48px at `sm` nominally. Card: `w-full max-w-sm` (384px cap), padding
   24px then 32px. Heading: `text-xl` (20px), semibold; form/field spacing: `space-y-2` (8px).
2. **Controls and actions:** inputs are `h-10` (40px) with 16px text, then 14px at `sm`.
   Email action: `h-11 sm:h-9` (44px then 36px), full width; 1 action first reveals the
   2 credential fields, then submits them. Recovery is beside/below the password group;
   registration is separated by `mt-9` (36px). SSO action count is unverified in the imported component.
3. **Colour and errors:** white card, slate text/borders, semantic primary submit; errors use
   red labels and `text-error` messages. Each credential error is under its input with
   `role="alert"`; controls receive invalid state and message IDs. OAuth callback failures
   produce 1 alert above the fields, while request errors produce toasts.
4. **Loading, blank and completion:** loading disables submit and centers a nominal 16px spinner
   over the retained-but-invisible label, preserving width. Credentials start empty or with a
   supplied email. Reset-email completion contains 2 text paragraphs and 1 return component,
   with no state illustration. Copy is translation-key driven: exact visible lengths and tone
   are **unverified** because locale resources were not read.

**Limits / counterexamples:** actual backdrop colour and shadow strength are unverified. Button
label truncation and an invisible loading label are not defaults; verify readable names and status
announcements. The form description ID differs from the control's referenced description ID in
the inspected primitive; do not infer complete accessibility from the presence of ARIA attributes.

## Defaults for this type

Shared direction: narrow task scope, repeated fields, one submit and local feedback. Budgets are fallback synthesis, not identical values in all 3 repos; tags identify support. Use existing tokens first.
Accessibility and viewport checks are acceptance requirements, not assertions that the references passed them.

1. **One reading path:** stack short-form fields in 1 column with labels above controls. Keep label, input and message on the same leading edge; never separate them into decorative cards. [S/D/F]
2. **Bounded auth shell:** use full available width with a 384–512px maximum and at least 16px outer gutters. At 320px, shrink within gutters rather than retaining a fixed minimum. [S/D/F]
3. **Measured rhythm:** select an existing 8–16px field gap and 8px label/control gap; use 24–32px card padding where needed. Do not add a card around every field. [S/D/F]
4. **Task-sized type:** auth title 20–30px, 1 heading and at most 1 short introductory sentence; aim for 2–6 title words and 1–3 action words, allowing locale expansion. [S/D/F sizing; S/D copy]
5. **Compact controls:** choose an existing input height in the observed 34–40px range and auth submit height in the 36–44px range; prefer 44px touch targets and 16px mobile input text. Functional icons stay 14–20px; their hit areas need not equal glyph size. [S/D/F]
6. **One primary submit per active step:** put it after fields; use full width in short auth forms and a trailing-edge save in editing forms. Provider/method alternatives stay secondary; display only configured methods, never cap them arbitrarily and remove access. [S/D/F; D profile]
7. **Separate recovery:** keep 1 password-recovery link with the password group and registration outside the credential fields. Do not style these links as additional primary submits. [S/D/F]
8. **Field-local errors:** render at most 1 actionable message directly below each invalid field, linked to that control; distinguish missing/invalid input from request failure. An optional form-level alert summarizes a request problem without repeating every field message. [S/D/F]
9. **Semantic colour:** use neutral surfaces/text, 1 primary action treatment, and status colours only for corresponding states. Every error also has text; colour alone is insufficient. [S/D/F]
10. **Pending stays in place:** disable repeat submission and show 1 spinner in the active action; retain its footprint and an accessible action/status name. Preserve entered values after failure unless the security contract requires clearing a sensitive value. [S/D/F]
11. **Blank is not failure:** initially empty fields keep labels and optional examples, with 0 missing-data illustrations. After submission, validate real constraints and preserve the form; do not replace correctable input with a full-page error. [S/D/F]
12. **Progressive, honest completion:** reveal a second-factor step only when required; show 1 active method, its submit and a secondary recovery route. Recovery confirmation must not reveal whether an account exists; use 1 concise explanation and 1 next action. [S/D/F]

## Slop markers for this type

- Purple-blue hero gradients, glows, blobs or emoji around credentials: remove them; use the
  product surface and one restrained action treatment. A provider mark is functional, not decoration.
- A large generic hero above two fields: replace it with the task heading and at most 1 sentence.
- Five accent colours or equally filled provider/save/cancel actions: keep 1 primary treatment,
  neutral alternatives and semantic status colours; retain all genuinely supported auth methods.
- Oversized cards, a badge/counter per field or fake progress statistics: remove the wrapper or
  metric; use one field stack. Show a step count only when the workflow has real defined steps.
- Placeholder-only labels, icon-only errors or toast-only field validation: add persistent labels
  and associated inline text. Do not hide messages in tooltips or shrink text to force a fit.
- An error banner taller than roughly one third of its form, or duplicated errors: shorten the
  summary and put corrections beside the responsible fields; retain essential recovery instructions.
- Disabled submit with no explanation, endless spinner or cleared values after a network failure:
  expose the reason/status, allow retry after failure and retain safe user input.
- Clipped CTA text, fixed-width mobile overflow or decorative panels consuming phone space:
  let content wrap, shrink the shell, remove nonessential decoration and retest the affected widths.

## Critic checklist

1. Which form/auth/validation subtype applies, and were team rules checked before these defaults?
2. Is there 1 clear submit per active step, with configured alternatives and recovery easy to find?
3. Do labels, controls and messages share edges, consistent gaps and an existing readable type scale?
4. Can a keyboard/screen-reader user identify every input and its error, see focus, submit and
   recover? Verify actual ID associations and announced pending/error states, not ARIA presence alone.
5. Do blank, invalid, pending, server-error and successful states preserve context, avoid duplicate
   requests and give the correct next action without exposing account existence?
6. At 320px, a wider phone and desktop, and with zoom/long translations, are controls and messages
   readable without horizontal overflow, truncation or a keyboard-obscured action?
7. Does colour convey action/status without decorative competition, with contrast verified in every
   shipped theme? Which claims remain source-only or unverified rather than visually demonstrated?

[s-license]: https://api.github.com/repos/supabase/supabase/license
[s-page]: https://github.com/supabase/supabase/blob/master/apps/studio/pages/sign-in.tsx
[s-form]: https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/SignIn/SignInForm.tsx
[s-options]: https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/SignIn/SignInOptions.tsx
[s-reset]: https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/SignIn/ForgotPasswordWizard.tsx
[s-layout]: https://github.com/supabase/supabase/blob/master/apps/studio/components/layouts/SignInLayout/SignInLayout.tsx
[s-item]: https://github.com/supabase/supabase/blob/master/packages/ui-patterns/src/form/FormItemLayout/FormItemLayout.tsx
[s-field]: https://github.com/supabase/supabase/blob/master/packages/ui-patterns/src/form/Layout/FormLayout.tsx
[s-button]: https://github.com/supabase/supabase/blob/master/packages/ui/src/components/Button/Button.tsx
[s-input]: https://github.com/supabase/supabase/blob/master/packages/ui/src/components/shadcn/ui/input.tsx
[s-size]: https://github.com/supabase/supabase/blob/master/packages/ui/src/lib/constants.ts
[d-license]: https://api.github.com/repos/documenso/documenso/license
[d-page]: https://github.com/documenso/documenso/blob/main/apps/remix/app/routes/_unauthenticated+/signin.tsx
[d-layout]: https://github.com/documenso/documenso/blob/main/apps/remix/app/routes/_unauthenticated+/_layout.tsx
[d-email]: https://github.com/documenso/documenso/blob/main/apps/remix/app/routes/_unauthenticated+/check-email.tsx
[d-form]: https://github.com/documenso/documenso/blob/main/apps/remix/app/components/forms/signin.tsx
[d-profile]: https://github.com/documenso/documenso/blob/main/apps/remix/app/components/forms/profile.tsx
[d-button]: https://github.com/documenso/documenso/blob/main/packages/ui/primitives/button.tsx
[d-input]: https://github.com/documenso/documenso/blob/main/packages/ui/primitives/input.tsx
[d-field]: https://github.com/documenso/documenso/blob/main/packages/ui/primitives/form/form.tsx
[f-license]: https://github.com/formbricks/formbricks/blob/main/LICENSE
[f-form]: https://github.com/formbricks/formbricks/blob/main/apps/web/modules/auth/login/components/login-form.tsx
[f-layout]: https://github.com/formbricks/formbricks/blob/main/apps/web/modules/auth/components/form-wrapper.tsx
[f-email]: https://github.com/formbricks/formbricks/blob/main/apps/web/modules/auth/forgot-password/email-sent/page.tsx
[f-button]: https://github.com/formbricks/formbricks/blob/main/apps/web/modules/ui/components/button/index.tsx
[f-input]: https://github.com/formbricks/formbricks/blob/main/apps/web/modules/ui/components/input/index.tsx
[f-field]: https://github.com/formbricks/formbricks/blob/main/apps/web/modules/ui/components/form/index.tsx
