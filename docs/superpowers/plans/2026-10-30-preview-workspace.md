# Preview Workspace Implementation Plan

**Goal:** Complete the five client-only sidebar capabilities with no model access interface or automatic preview transfer.

**Architecture:** Extend the existing Electron preview file/browser controllers, local React workspace hook and CC SPACE sidebar. Use bounded lazy local filesystem APIs, persisted validated layout metadata, local PDF rendering and local Office conversion. Browser views are addressed by pane so simultaneous views do not hide one another.

**Tech Stack:** Electron, Node fs.watch, React, TypeScript, PDF.js, bundled LibreOffice Kit.

- [x] Baseline: isolated branch from origin/main; run preview unit tests and typecheck/build before changes.
- [x] Files and watchers: implement preview list/watch APIs in electron/preview-workspace.cjs, test real temp directories including symlink escape and atomic replacement; add preload/types/lifecycle cleanup. Tree component renders lazy accessible rows, refreshes on metadata events, opens only user-selected files.
- [x] Layout: create previewLayout.ts pure validated layout helpers. Tests cover duplicate open, move/reorder, split, float/dock, close empty pane, bounded deserialize, account/session separation. Update preview.ts to persist only metadata and require explicit activation of restored executable content.
- [x] Documents: local PDF.js canvas viewer with pages/zoom/cancellation. Local Office-to-PDF controller with bounded input/output, unique profile/output directory, disabled macros/link updates, cancellation/timeout and cleanup. Test real fixture conversion and PDF rendering; missing-runtime errors stay actionable.
- [x] Panes: extract reusable PreviewPane and PreviewContent from sidebar; wire tree, pane-specific native views, split, drag/drop/reorder, floating rectangle/move/resize, keyboard equivalents and responsive CSS using existing tokens.
- [x] Network isolation: deny cross-origin requests for static HTML, SVG and PDF; remote Markdown images inert. Keep existing explicit local website entry isolated from file sessions. Test redirects, fetch, images, WebSocket and restored-page deferral with real loopback probes.
- [x] Integration: expand preview UI fixture and real Electron tests for all features, simultaneous views, watch cleanup, restart restore and no model protocol traffic. Verify light/dark/narrow screenshots, typecheck/build/format and targeted regression tests. Update PREVIEW-SIDEBAR.md with current behavior, conversion prerequisite and test evidence.

Run commands from this worktree: `node --test apps/desktop/test-main/preview-*.test.mjs`, `npm run typecheck`, `npm run build`, `npx playwright test apps/desktop/test/preview-sidebar.spec.ts`. Run real Electron with `CC_PREVIEW_ELECTRON_TEST=1` and a dedicated test profile. Do not publish or merge without user instruction.


## Verification evidence

- Node 24 desktop regression suite: no failures (conditional native/network suites are reported as skipped in this run and the preview-specific gates are executed separately).
- Browser UI: 17 passed, including actual PDF ink, drag reorder/move, float clamp after owner-window resize, workspace resource cleanup, HTML alias deferral and metadata restoration.
- Actual Electron: full preview chain passed, including tree changes, automatic refresh, PDF and Office UI, native simultaneous panes, terminal windows, cleanup, same-profile process restart and explicit activation of restored HTML. No message.send occurred.
- Office gates: 9 passed, covering six real document formats, external-image loopback refusal, queue/cancellation/limits, and native conversion from the staged ASAR package with physical workers/engine.
- Typecheck, production build, changed-file formatting, diff whitespace checks and repository check executed before delivery. UI screenshots reviewed for light/dark desktop and narrow large-font layouts.
- Separate code review found and verified fixes for shared watcher migration, workspace view cleanup, HTML alias activation, floating occlusion and viewport resizing.

Delivery retains `codex/preview-workspace`; no merge, upload or production release.
