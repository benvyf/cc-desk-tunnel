# Multi-device Development Implementation Plan

> For agentic workers: use executing-plans task by task; use a focused subagent for shared SSH project dialogs and independent review.

**Goal:** Implement the approved multi-device development design: visible terminal creation, unified local/SSH projects, and independent chat/terminal sessions.

**Architecture:** Keep the existing ProxyClient, SSH target manager, session identity and terminal popup. Add a small project identity/source helper and a shared project opening dialog, reuse SSH IPC and directory validation, and replace navigation-level terminal locks with session ownership checks. Each module stays within its existing responsibility.

**Tech Stack:** React/TypeScript, Electron, xterm, ssh2, Node test runner and Playwright.

## Tasks and verification

- [x] 1. Baseline and project identity: add `src/developmentProjects.ts` and `test-main/development-projects.test.ts`. Verify `projectKey(scope, deviceId, path)` isolates identical paths, local preference keys remain compatible, and latest source is deterministic with active source priority. Run failing tests before implementation, then typecheck and Node tests.
- [x] 2. Shared project opening: add `OpenProjectDialog.tsx` and `useSshTargets.ts`. Reuse SSH connect/save/directories/openProject and local folder selection. Props specify initial device/path, forceNew, local-open callback, successful remote-session callback and close. Cover offline connect, password/key, new target, directory errors, cancel and late results. First create failing UI fixtures/scenarios, then implement. No changes to provider/model network boundaries.
- [x] 3. Terminal creation: modify `TerminalWindow.tsx`, use a focused selector component if needed, and add dedicated UI scenarios. Add split new button; group known sessions by device/path, max five recent, search, explicit configuration source, other project dialog, multi-device label identity. Keep legacy project-create entry and history separate. Track occupied session IDs including unknown/disconnected states through workspace handle, and guard show(id) against active chat runs.
- [x] 4. Unified sidebar: modify `Sidebar.tsx` with optional SSH targets, scope, remote create/menu callbacks. Keep local preference keys, scope remote keys, show saved empty/offline SSH projects in project area, remove duplicates from elsewhere, preserve local order and pin/fold/name state. Allow navigation/new sessions while unrelated terminal runs; search includes device/name/path. Verify same path across devices, empty saved project, keyboard and folded statuses.
- [x] 5. App integration and per-session ownership: modify `App.tsx`. Subscribe to SSH targets, wire project dialog and SSH creation, use scoped remote project menu preferences, clarify project menu as move action, expose device identity. Keep terminal mounted through navigation; track occupied sessions via callback; apply session-specific send/configure/delete/move/resume/open guards. Keep whole-application update/disconnect checks global. Test active terminal A with chat B, same-session refusal through every launch entry, retained drafts, navigation without move, and reconnect uncertainty.
- [x] 6. Validation and review: run directly relevant Node and UI suites, typecheck, frontend build, model boundary, formatting and git diff checks. Capture dark/light and 1280/1000/800/480 views plus real Electron. Reuse isolated two-Linux-host lab only after inspecting live process state and runner isolation. Map A1–A15 in an evidence document; report actual limits. Independently review requirements and lifecycle correctness, fix reproducible issues and rerun affected checks.

## Commands

- `node --test apps/desktop/test-main/development-projects.test.ts`
- `node --test apps/desktop/test-main/terminal-window.test.mjs apps/desktop/test-main/ssh-target-adapter.test.mjs apps/desktop/test-main/ssh-target-pool.test.mjs`
- `npm run typecheck`
- `npm run build`
- `node scripts/check-model-boundary.mjs`
- `npx playwright test apps/desktop/test/multi-device-development.spec.ts apps/desktop/test/terminal-window.spec.ts apps/desktop/test/terminal-workspace.spec.ts apps/desktop/test/ssh-settings.spec.ts`
- `npx prettier --check` on changed code/docs, then `git diff --check`.

Use project Node 24 for final checks. Native dependencies and Electron must match the isolated worktree. Preserve the original ui/motion checkout and all its uncommitted edits. No installer publication or production deployment is part of this implementation request.

## Completion evidence

See `docs/MULTI-DEVICE-DEVELOPMENT.md` and `docs/evidence/multi-device-development-verification.json`. The all-Node run retains its independently reproduced Docker baseline failure and a separately passing rerun of the Windows cleanup case. No deployment or publication performed.
