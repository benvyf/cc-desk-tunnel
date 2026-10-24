# Motion Tokens

Apply the motion design discussed with the user, including their follow-up request to animate streaming replies. The supplied image is a design reference, not proof of Claude's internal implementation.

## Selected design

- Define `--cds-dur-fast/snap/base/sheet/slow` as 60/120/200/300/450 ms and the three easing curves from the reference in the existing stylesheet.
- Use explicit color properties for button feedback, snap timing for navigation and switches, base timing for floating surfaces, and sheet timing for sidebars. Do not add an animation library or `transition: all`.
- Retain floating surfaces through their exit animation in a small `Presence` component. Mark exiting content inert and hidden from assistive technology immediately. Wait for actual finite CSS animations, cancel stale completion when reopened, and remove immediately when reduced motion disables animations.
- Fade popups without changing their positioning transforms. Animate dialogs and their backdrop. Preserve native dialog focus handling.
- Keep sidebars mounted so search, scroll and fold state survive. Update the desktop grid once; animate only sidebar opacity and an independent translation, keeping the navigation rail above it. Collapsed sidebars become inert immediately. On narrow screens animate the overlay sidebar and shade in both directions.
- Streaming replies reveal only newly appended ordinary Markdown text using a 120 ms opacity animation. Render text immediately, preserve prior text opacity, and keep code, formulas, tables and tool output immediate. Do not queue tokens, animate height, or introduce per-character nodes or timers. Static history and completed replies have no reveal animation.
- Respect `prefers-reduced-motion` for all new motion and existing status loops. A live preference change must also finish a pending exit.

## Implementation plan

1. Add browser regressions in `apps/desktop/test/motion.spec.ts`: menu exit/inertness and rapid reopen, sidebar state retention on desktop/mobile, streaming prefix stability and Markdown integrity, reduced motion. Run them against the existing app to establish missing behavior.
2. Add `apps/desktop/src/Presence.tsx`, integrate the shared menu and dialog call sites plus composer and status popups. Keep native positioning and event handlers intact. Exercise exits and interruption with real browser animations.
3. Add the shared CSS tokens and component assignments in `style.css`; pass collapsed state to the chat, settings and schedule sidebars. Keep layout widths and conversation follow logic unchanged.
4. Add a small rehype transform in `streaming.ts`, used only by live `RichText`. Use source positions and unchanged-prefix detection to wrap appended prose; skip escaped/rewritten partial leaves and structured content. Key each reveal span by its source range so subsequent chunks animate independently.
5. Verify the new regressions, existing icons/theme/typography/popover/tool/long-conversation regressions, TypeScript, formatting, build and repository checks. Inspect desktop/mobile and light/dark screenshots and run Electron against the built UI.

## Review criteria

- Dismissed surfaces cannot receive keyboard/pointer input or remain accessible during their visual exit.
- Reopening during exit cannot be undone by an earlier animation completion.
- No popup transform used for viewport fitting is overwritten by animation.
- Streams append immediately, old prose remains fully opaque, copying yields the complete reply, and long conversations still follow correctly or respect manual scroll-up.
- Reduced motion removes spatial/fade motion without leaving stale dialogs, overlays or hidden focus targets.

## Review fixes

- Release native modality as soon as closing starts; render an inert visual exit with a noninteractive backdrop so the next input is accepted immediately. Capture the dialog in layout-effect cleanup to preserve focus restoration.
- Apply explicit maximum dimensions and scrolling to both open dialogs and exit ghosts; keep geometry stable on a short, narrow viewport.
- Keep the sidebar's resting translation `none`, so fixed session tooltips retain viewport coordinates after the slide.
- Keep standalone login-page settings interactive independently of the connected workspace's sidebar toggle.
- Leave selection behavior during React text updates unchanged from the baseline; an isolated Chrome comparison found no added selection regression.

## Verification evidence

- The 73-case browser suite passed 71 cases; two dialog geometry assertions differed by less than 0.001 CSS pixels. After changing equality to a 0.005-pixel tolerance, all 19 motion/typography cases passed, including both dialog regressions and real streaming integration.
- The production Electron smoke passed, including sandbox settings, menus, native project selection, dialogs, approvals and connection shutdown.
- TypeScript, changed-source Prettier, `git diff --check`, and the repository's 479-file check passed. The production build passed with its existing large-chunk warning.
- Inspected light/dark mobile drawers, the production Electron screenshot, and desktop/narrow typography captures. Updated the capture test to wait for the mobile sidebar exit before taking its screenshot; that capture test passed again.
- Validation used local simulated services; no live model or remote execution was required. Changes remain uncommitted.

## Detail review follow-up

- Reproduced a usage-card exit jump: `usePopover` recalculated placement on close while Presence retained the card, removing `below` and moving the fading card. Positioning now runs only while open. The new browser regression failed before this fix and passes after it.
- Expanded coverage for native dialog reopen during an unfinished exit, typed value/focus surviving the old exit deadline, inline-code/table exclusions, and revealing only the latest appended prose suffix.
- Reviewed 48 related browser cases: 47 passed in the broad run; the remaining case had an incorrect assumption that native dialogs initially focus the input instead of the preceding close button. Corrected the test to focus/type explicitly, then reran all eight motion cases successfully. TypeScript, changed-source formatting, repository checks and production build passed. The existing build chunk-size warning remains.
- Independent review found no additional actionable defects in the final change.

## Second full review

- A fresh independent source review found no further actionable product regressions. This pass changed tests only.
- Expanded the UI run to 100 cases, including effort dragging, slash commands, layout/project operations, settings, reply footers, browser access and long transcripts. 98 passed; the other two were stale assertions already contradicted by HEAD: standalone settings include About, and managed Electron uses its dedicated updater instead of the legacy notes button. Updated those assertions to check the current behavior.
- Added checks that an expanded project list and its nonzero scroll position survive sidebar close/reopen. Added 60 frame-paced streaming updates, complete-text verification and a bounded reveal-node count.
- The five targeted cases all passed afterward: both corrected cases, both strengthened cases, and the production Electron sandbox/connection smoke. Other cases passed in the expanded run.
- Fresh production build, TypeScript, changed-source formatting, `git diff --check` and the 479-file repository check passed. The build retains its existing chunk-size warning. Long-transcript measurements were 67 ms to open / 7.4 ms per key in standard mode and 495 ms / 27.7 ms in expanded mode in this local run.
