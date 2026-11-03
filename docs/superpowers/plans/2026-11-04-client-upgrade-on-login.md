# Client Upgrade Notice Implementation Plan

**Goal:** Replace vague version errors with a correct client-upgrade notice before workspace connection, retaining legacy text support.

**Architecture:** Use existing authenticated `/cc-access/v1/connect`, trusted host heartbeat, Electron identity and signed-client controller. Preserve all WebSocket protocol guards and automatic-install restrictions. Reuse Modal for one small notice component; no new update framework or database schema.

**Tech stack:** Existing Node 24/TypeScript, CJS Electron modules, React, Node tests and Playwright.

## 1. Center compatibility gate

Files: `apps/update-service/src/http.ts`, `apps/update-service/test/client-upgrade.test.ts`.

- [x] Write HTTP regression tests with real DesktopAccess/HostUpdates: legacy request to current protocol23 returns426 readable error and structured requiredProtocol; current22 stays allowed; unauthorized user never learns node versions; stale/offline/in-progress state falls back; newer client gets server guidance.
- [x] Run new tests and observe missing behavior.
- [x] After existing workspace authorization and before ticket issuance, validate optional `{build,protocol}` metadata. Missing metadata denotes the deployed email-client protocol22 cohort. Only online, settled heartbeat proves the target version. Return426 directly for mismatch, preserving401/409 semantics and existing tickets.
- [x] Run center HTTP and login/grant tests.

## 2. Main-process metadata and trusted manual download

Files: `electron/{desktop-access,managed-controller,managed-updates,main,preload}.cjs`, related test-main files.

- [x] Test identity comes from injected main-process identity, 426 retains saved login, structured notice survives ticket IPC, cancellation ignores stale responses.
- [x] Send identity on connect; validate upgrade-required responses and preserve them across existing IPC result shape. Do not clear sessions for426.
- [x] Add one signed-controller method to return a manual download link for the required higher protocol using existing verifyIndex/selectUpdate/replay and artifactPath. Default check/download/install remains strict.
- [x] Expose metadata/open actions accepting only required protocol, no URL/path. Recheck signed publication on explicit open and use shell.openExternal only for the computed trusted URL. No installation or service upgrade.
- [x] Test incompatible automatic download stays refused, manual link requires matching protocol/newer build/signature/scope/replay, unavailable publication returns no link.

## 3. Login notice and handshake fallback

Files: `apps/desktop/src/{client,App,desktop.d}.ts[x]`, `ClientUpgradeDialog.tsx`, server.ts and tests.

- [x] Test ProxyClient records notice only for the current preparation, stops reconnects, clears it on new login/disconnect, and preserves old user-facing text.
- [x] Route the structured ticket result through existing preparation failure handling and a single ClientState field. Show Modal with approved copy; fetch signed release metadata, show download only if matching, allow later/close. No duplicate generic error or misleading server-update action.
- [x] Existing server rejection frame/code stays stable; only its text distinguishes older client from older server. Manual connections retain clear text fallback without changing protocol schemas.
- [x] Browser tests cover login/auto-login and workspace selection, available/unavailable release, cancel and matching-protocol normal login.

## 4. Verification and delivery

- [x] Run relevant Node tests, full typecheck/build and browser interaction checks. Review diff against karpathy-guidelines: every production line serves the approved behavior.
- [x] Request an independent focused review; fix material findings and rerun affected checks.
- [ ] Commit tested implementation, generate candidate update-center package and desktop candidate artifacts as supported by existing packaging. No production publication or Ubuntu upgrade in this implementation turn.
- [x] Record exact tests, old-client limitations and rollout order. Existing Build24 can show readable text, not retroactively acquire the new Modal; matching signed client must be published before server cutover.
