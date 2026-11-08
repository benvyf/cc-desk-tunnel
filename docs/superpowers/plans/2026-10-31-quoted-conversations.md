# Quoted Conversations Implementation Plan

**Goal:** Add explicit main-thread references and independent, context-preserving sidebar conversations through the existing remote model path.

**Architecture:** Separate quote data from composer text. Serialize explicit references only when sending through existing message.send. Add a server-owned side-conversation snapshot and capability-gated retained subscriptions. Render chat tabs in the existing right sidebar using native Conversation/Composer components.

**Stack:** Existing React/TypeScript client, Zod protocol, SQLite session store, remote Claude SDK only.

- [x] Baseline and isolation: reuse clean linked workspace on codex/quoted-conversations from main; focused unit/type/build baseline.
- [x] Quote domain/drafts: failing tests for serialization/parse/de-duplication/budgets; implement bounded quote model and persistent draft entries. Preserve attachment and queued-message editing behavior.
- [x] Side service: failing store/protocol/WebSocket tests; add server snapshot table and side-session metadata, create without model work, inject boundary/background only at first explicit send, retain/unsubscribe capability and simultaneous streams. Child owns settings/run IDs. Context snapshot is server-only and frozen; fail clearly if over budget.
- [x] Client subscriptions: observe/unobserve side IDs without changing selectedId, restore main+side subscriptions on reconnect/selection, discard stale results on scope changes.
- [x] Quote UX: answer actions + selection toolbar/context menu, independent chips/details/remove, current composer focus and exact source session. Render sent quote messages cleanly and preserve busy queue behavior.
- [x] Sidebar chat: add chat tab kind and safe metadata restore, integrate own Conversation/Composer and model/permission/stop/approval/history; snapshot creation and pending errors scoped by source/workspace, no automatic sends.
- [x] Verification/review: fake server asserts actual target IDs and frozen background, main state unmodified, no send on quote/open, no preview-to-model leak, old-capability behavior. Browser/real Electron interaction and screenshot QA, type/build/model-boundary checks, relevant regressions, independent review and fixes. Document behavior and server update requirement. No automatic merge/push/release for this new work without an instruction covering it.

Commands: Node24 test-main quote/subscription tests; server store/side-conversation tests; npx playwright test quote feature fixtures plus existing conversation/composer/preview regressions; npm run typecheck/build/check; opt-in Electron fixture tests without real model requests.

Verification (2026-10-31):

- Typecheck, production build, remote-model boundary guard, staged repository check and diff whitespace check pass.
- Focused quote/layout/client/native-input/side-service/browser-server unit tests: 41/41 pass.
- UI regression batch: 74/75 initially pass; the old Electron clipboard test expected the retired service-address login field. Updating its selector to the current email field makes it pass. Final quote/conversation-tools run: 17/17 pass, including all 13 quote cases. The other 62 existing UI cases passed in the broader run.
- Real Electron quote test: 1/1 pass against a fake remote. Concurrent main/side streams, child cancellation, native-preview coexistence, missing webpage bridge, no preview-content payload and clean-restart draft/quote restoration are exercised.
- Full npm test: 646 pass, 60 skipped, 1 pre-existing release-history failure. HEAD already declares managed-client Build 24 while managed-protocol-history ends at Windows Build 22; this feature does not change release manifests or fabricate a release.
- Independent backend and client/UI reviews completed. Fixed first-send retry background duplication, fork background preservation, terminal context consumption, cross-peer run controls, context-menu selection capture, empty side model catalog and clipped permission menus. No remaining implementation blocker identified by review. Transient reconnect now shows the connection banner rather than an update requirement.
- Visual QA: light/dark, 390/900/1280 px and enlarged fonts. No real model/API calls, deployment, release, push or merge performed.

UI follow-up review (2026-10-31):

- Replaced the bespoke quote button geometry/hover with the shared small Button tier; retained the existing icon, font, border, radius and focus system. Added an accessible quote-count description and content association; floating tools use the existing raised surface.
- Reproduced and fixed long-selection toolbar overflow, clipped minimum chat floats, compressed composers in short splits, menus leaving their side pane after scrolling, and selection tools remaining open after outside controls or Escape. Chat float minimum height follows interface font size, short side panes scroll, source captions are bounded, and side greetings fit their smaller space. Chat tab hints show titles instead of UUIDs.
- Regression evidence: 52 related UI checks pass; after the final Escape handling, quote/conversation tools pass 20/20. Focused unit tests pass 29/29. Fresh typecheck, production build/model boundary guard, staged repository check, whitespace check and real Electron quote/restart/preview-isolation test all pass. The previously documented release-history baseline failure is unchanged.
- Independent logic and UI reviewers completed another pass. Current-run screenshots and a local review report were inspected; no remaining blocker identified in the reviewed feature. No deployment, push, merge or real model request was performed.

Additional concurrency review (2026-10-31):

- Reproduced a pending-send draft loss: send in a side chat, select that chat in main and edit while its response is delayed; the old completion cleared the newer draft. Draft clearing now compares against the submitted text atomically in the shared draft store. Both main and side send paths use the protection; quote/file cleanup still removes only submitted IDs.
- Added fake delayed-acknowledgement tests for side-to-main and main-to-side navigation. Both preserve newer edits, and 53 related quote, draft, attachment, queue and conversation UI tests pass. Fresh typecheck and whitespace checks pass.
- Independent backend/protocol review reports no new issue and passes 27 focused tests. Independent client review confirms the draft race and its fix; quote/subscription/layout unit tests pass 14/14.
- Full npm test rerun: 645 pass, 60 skipped, 2 failures. One is the known untouched Build 22/24 release-history mismatch. The other is Windows EPERM while cleaning a temporary launcher directory; its complete managed-client test file passes 29/29 on an independent rerun. No release metadata was changed.
- Latest build, client model-boundary guard, staged repository check and real Electron quote/restart/preview-isolation test pass after the draft fix (Electron 1/1, 27.5 seconds). No remaining new blocker identified in the reviewed changes; no real model request, push or merge performed.
