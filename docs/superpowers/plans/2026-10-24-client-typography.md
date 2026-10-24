# Client Typography & Alignment Implementation Plan

> **For agentic workers:** Execute this plan inline with executing-plans. The user approved the design and requested execution on 2026-10-24.

**Goal:** Apply the supplied typography references to the existing CC client and verify actual text layout and expansion behavior.

**Architecture:** Keep the existing React components, theme, Markdown memoization, lazy folds and local timer updates. Use CSS typography tokens and scoped wrapping rules; extract only the ordinary run notice into a small component with overflow detection and an accessible expansion button.

**Tech Stack:** React 19, TypeScript, Vite, Playwright, Node 24.

## Task 1: Establish a reproducible baseline

- [x] Use the existing `codex/account-monitor-production` feature checkout; no new worktree is needed for this clean, dedicated checkout.
- [x] Run the existing transcript-view and long-transcript Playwright tests with the bundled Node 24 runtime, `PLAYWRIGHT_CHANNEL=chrome`, and the isolated simulation server in `playwright.config.ts`.
- [x] Capture baseline desktop and narrow screenshots using deterministic synthetic session events in the typography fixture.

## Task 2: Specify and implement text expansion

Files: `apps/desktop/test/typography.spec.ts`, `apps/desktop/test/transcript-view.spec.ts`, `apps/desktop/src/RunNotice.tsx`, `apps/desktop/src/Conversation.tsx`, `apps/desktop/src/transcriptView.ts`.

- [x] Add browser regressions for a two-line thinking preview with subsequent source lines, keyboard expansion, long/short/error notices, resizing, search expansion and full-text copying.
- [x] Run the new tests before implementation and confirm that missing preview content / expansion controls fail.
- [x] Replace the single-line helper with a plain-text preview that keeps all meaningful lines; remove Markdown line prefixes and emphasis markers without changing the stored thought or copy content. Update the view-mode description.
- [x] Render ordinary run notices through `RunNotice`; use `useId`, `aria-controls`, `aria-expanded` and a button outside the text region. Measure overflow after text changes and with `ResizeObserver`, comparing the text's scroll height with three computed line heights. Keep errors fully visible and respect `SearchExpanded`.
- [x] Preserve existing `Fold` mounting behavior, approval forcing and search behavior.

## Task 3: Apply typography and alignment

File: `apps/desktop/src/style.css` and the message rendering in `Conversation.tsx`.

- [x] Add reusable body/title/caption size and line-height tokens while retaining page-title hierarchy.
- [x] Add the `-0.125em` SVG baseline default and a smaller caption offset; retain flex centering, existing transforms and component icon sizes. Explicit prose icon rules may use `1em` without affecting the application icon system.
- [x] Apply balanced wrapping to multiline headings and pretty wrapping to static prose. Mark assistant text from an unfinished turn as streaming and use ordinary wrapping throughout that message.
- [x] Use `overflow-wrap: anywhere; word-break: normal` in text containers, fix the empty-project path, and preserve code/terminal/table scrolling.
- [x] Extend tabular numbers to clocks, tool durations, search counts, context figures, quotas and badges.
- [x] Clamp thinking previews to two lines and normal run notices to three, preserving one-line sidebar titles. Keep the thought label and chevron aligned to its first line.

## Task 4: Verify and review

- [x] Run targeted UI regressions, the existing 400-step performance checks, conversation search/follow, reply/footer, live status, approvals and layout checks as applicable.
- [x] Run TypeScript, client build, changed-file formatting, Node regression suite and `git diff --check`. Run the index check with the changed files included in its inspection and leave user-facing changes unstaged on completion.
- [x] Inspect actual desktop/narrow screenshots with long Chinese/English prose, model IDs and paths. Compare the unchanged baseline and final 400-step timings without claiming a speedup from one run.
- [x] Review the diff, fix actionable issues, update the design with actual results and report the limits of browser simulation validation.
