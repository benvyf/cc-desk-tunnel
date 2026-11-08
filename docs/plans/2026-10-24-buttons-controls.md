# Buttons & Controls

Apply the supplied light/dark Claude references to existing application controls.

- Primary: terracotta fill, light label, slightly darker solid colour so small text reaches 4.5:1 contrast. Preserve the existing clay accent used elsewhere.
- Secondary: neutral outline and transparent resting background. Ghost: transparent background/border and muted label. Both use the theme hover surface.
- Button sizes: XS 24px, SM 28px, MD 32px (default), LG 40px. Preserve existing general control tokens, switches and contextual icon sizes.
- Share a typed native Button API and optional IconButton size. Keep legacy class-based controls working. Use explicit submit semantics when migrating forms.
- Apply LG to login, MD to dialog actions, SM to account actions, XS to compact schedule actions, and Ghost to shortcut reset. Keep destructive actions distinct.
- Allow labels to wrap and controls to grow; retain keyboard focus, disabled behaviour and reduced-motion feedback.

## Execution and validation

1. Add browser regressions for geometry, variants, contrast, keyboard/form behaviour and narrow labels; establish failure before implementation.
2. Implement shared styles/API and representative real-screen usage.
3. Check actual login/dialog/settings flows and capture light/dark and narrow controls.
4. Request independent code review and address actionable findings.
5. Run relevant browser regressions, TypeScript, build, formatting, diff and repository checks. Leave changes uncommitted until requested.

## Verification

- The new browser fixture failed before implementation because the shared Button API was absent. After implementation all five focused tests pass in Chrome.
- Verified all three variants at 24/28/32/40px and square icon buttons in light/dark themes. Primary uses white text/icons with approximately 4.81:1 contrast at rest and 6.15:1 on hover; the original brand clay with white would only reach 3.12:1. Brand accent tokens remain unchanged.
- Verified default button versus explicit form submission, native Enter/Space, disabled action suppression and skipped Tab focus, and visible keyboard outlines. Long unbroken labels wrap and grow without overflow at 320px.
- Verified actual login LG, dialog MD cancellation/Enter submission, account SM and logs navigation at 320px, shortcut Ghost reset, and schedule XS confirmation/deletion at 320px in both themes. Inspected gallery and real-page captures; screenshots disable finite transitions to show settled colours and dialog geometry.
- Independent implementation and follow-up test reviews found no actionable defects. The initial review identified missing contextual coverage, addressed by the real account/shortcut/schedule test.
- The related 79-test suite passed: app, buttons, connections, icons, layout, managed upgrades, motion, settings, themes, typography and browser access. After adding contextual coverage and stable captures, all five button tests passed again. These counts overlap.
- TypeScript, production build, formatting and diff checks passed. Build retains the existing warning for a minified chunk over 500kB. Repository validation covers 490 files using a temporary index; the real Git index is preserved.

## Detail review

- A second independent review checked surrounding legacy styles, icon size precedence, login geometry, native attributes, form semantics and accessibility. No actionable implementation defects were found.
- Added two browser regressions for system theme changes, explicit themes against the opposite system preference, all three variants under reduced motion, icon centring, press/release restoration, disabled hover/press appearance, and long labels at 200% zoom. The release assertion compares against the actual resting scale (`none` is the browser's valid untransformed state).
- The expanded button suite has seven tests. All 24 combined button, icon, motion and theme regressions passed; TypeScript and production build passed again. No application code changes were needed during this review.

## Final integrity review

- A fresh independent review found no actionable defects in the final implementation or its coverage. Rechecked legacy selectors and native controls across actual pages, form submit/cancel behaviour, disabled/focus states, label wrapping and icon geometry.
- Rechecked settled light/dark gallery, login and narrow schedule captures. Computed contrast: primary 4.81:1, primary hover 6.15:1, ghost labels 5.40:1 light / 7.09:1 dark, focus rings 5.99:1 light / 5.85:1 dark against page surfaces.
- All 82 tests in the full related browser suite passed, including all seven current button tests. TypeScript, production build, formatting and diff checks passed again. The existing bundle-size warning remains. No application changes were required in this round.
