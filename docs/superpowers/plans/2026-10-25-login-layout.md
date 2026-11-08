# Login layout implementation plan

**Goal:** Apply the approved centered, subtle card layout with no settings or project footer and no standing server-update check on the login page.

**Architecture:** Keep authentication in App and the existing controlled ConnectionForm. LoginPage owns the visual card and native details disclosure for the optional certificate fingerprint. Keep saved fingerprints effective while collapsed. Move the settings-initiated server maintenance flow into a modal so it survives disconnect without becoming part of the login form. Retain local settings through the configured keyboard shortcut.

**Tech Stack:** React, existing CSS tokens and icons, Playwright, Electron.

- [x] Add behavior coverage in `apps/desktop/test/login-page.spec.ts`: optional disclosure, saved fingerprint, removed footer and update check, responsive theme geometry, working keyboard access to local settings.
- [x] Run `npx playwright test login-page.spec.ts` to confirm the missing disclosure/footer removal fails.
- [x] Update `apps/desktop/src/LoginPage.tsx` and `apps/desktop/src/style.css`: centered brand, 448px card, 32px padding, title/subtitle, 44px inputs, disclosure, wrapping options, no footer. Preserve title and accessible field names for existing authentication flows.
- [x] Update `apps/desktop/src/App.tsx`: remove obsolete LoginPage props; show ManagedServerUpgrade only in a settings-initiated modal, close/cancel on dismissal, preserve credentials and activity state; expose pre-login settings via the existing configured shortcut.
- [x] Update affected navigation tests to use the keyboard shortcut and certificate tests to expand the disclosure. Update server-upgrade tests to enter the settings maintenance modal and keep confirmation, cancellation, rollback and current-build coverage.
- [x] Build and run affected UI suites sequentially, typecheck, formatting and diff checks. Capture light/dark desktop and narrow login screenshots; review them with the approved preview. No commit, push, package or deployment in this task.

Validation: 24 core UI checks passed; the final 11 login/maintenance checks passed after the connection guard fix. Broader affected suites passed 67 checks before updating the expected login button height from 40px to 44px; that button check passed in the later core run. Typecheck, build, formatting and whitespace checks passed. Screenshots cover both themes at 1240px and 320px, including 20px interface font.

Second review: reproduced and fixed stale active-run state blocking disconnected maintenance, and added a mismatch-only recovery action that opens About even with disabled or cleared settings shortcuts. Ordinary login retains no settings/project footer or standing maintenance check. Reproduced and fixed the maintenance digest overflowing narrow dialogs and lost keyboard focus after dismissal. Added coverage for keyboard disclosure and collapsed-fingerprint submission, expanded certificate configuration at 320×560 with 20px fonts, cancellation with a late check result, and both themes. All 19 login/maintenance checks and 29 integration checks passed, including Electron authentication, remembered sign-in/automatic login, branding alignment, buttons, fonts, settings and motion. Build, typecheck, full formatting, whitespace and the 550-file repository check passed. Independent static review found no further actionable defects. Service installation and deployment were not exercised.

Disclosure motion follow-up: the user reported a visible jump when toggling advanced options. Frame measurements reproduced a 57.4px shift of the brand, heading and trigger caused by vertical recentering, plus no intermediate height frames. Keep the centered column and anchor its top responsively to the viewport; reuse the existing ThinkingAccordion native-details/Grid 0fr pattern with base-duration easing and opacity. Preserve certificate values, native keyboard toggling, hidden-field inertness, scrolling in short windows and reduced motion. Update the open local design preview to match.

- [x] Add and run a failing geometry/motion regression test before implementation.
- [x] Update only login layout, advanced disclosure wrappers and scoped motion styles.
- [x] Verify opening, closing, rapid reversal, saved certificate loading, keyboard access and reduced motion across themes and short/narrow windows.
- [x] Run relevant login, branding and motion regressions plus build, typecheck, formatting and whitespace checks; visually inspect the updated preview.

Motion validation: the original regression failed with a 57.4375px anchor shift and no intermediate frames in either direction. After the fix, all 43 login, maintenance, branding, button, font and motion tests passed. Build and typecheck passed; the existing large-bundle build advisory remains. The current 5175 preview was updated, reloaded and visually checked with advanced options expanded.

Further motion review: reproduced a clipped certificate focus ring in both themes at 1240px and 320px with 20px fonts. Symmetric 5px inline padding and negative margins now preserve its full outline without changing field width or alignment. Also reproduced delayed native toggle state leaving an opened field inert, and native content-visibility keeping the first opening frame hidden even after inertness was removed. Summary activation now updates React state immediately; the open native subtree becomes visible immediately while closing retains the delayed hide and Grid animation. Added microtask synchronization, immediate Enter/Space-to-Tab, focus-ring clearance/alignment, and frame-by-frame anchor checks including 320×560 and 20px fonts. Independent static review found no additional issues in these fixes. The local preview was updated and checked with immediate Tab entering the certificate field.

Final review validation: all 48 related UI regressions passed, followed by 6 successful repetitions of the immediate Enter/Space-to-Tab cases. Build, typecheck, full formatting, whitespace and the 550-file repository check passed. No commit, push, packaging or service deployment was performed.
