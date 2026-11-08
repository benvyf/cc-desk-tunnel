# Double Escape Stop Implementation Plan

**Goal:** Add the user-approved Harness-style 500ms double-Escape stop shortcut.

**Architecture:** A bounded sequence helper and scoped React hook reuse existing stop functions. One scope per visible conversation, stable listeners while eligible, capture ownership before local controls and accept only unconsumed bubbling keys. Existing settings components expose a fixed shortcut hint.

**Tech Stack:** Existing React/TypeScript, Node unit tests, Playwright fake remote fixtures and Electron.

- [x] Reuse isolated worktree, create codex/double-escape-stop from main; inspect existing stop, menu, approval and shortcut handling.
- [x] Write failing timing and UI routing tests; implement the sequence and scoped listener hook.
- [x] Connect main and side stop scopes; show fixed shortcut under the existing shortcut settings and accessible button description.
- [x] Verify timeout, repeated/composing/modified keys, focus/pointer/blur and local consumption reset, menu/approval/terminal isolation, connection/run identity change and no cross-session cancellation.
- [x] Run focused and existing regressions, type/build/model-boundary checks, independent review and real Electron verification. Document limitations; no automatic commit/push/merge for this new feature.

Verification: 59 UI regressions, 51 focused unit tests, typecheck and production build/model-boundary guard pass. The real Electron quote integration now uses double Escape to stop the side run, confirms the first press does not cancel, leaves the main run/draft unchanged and still validates restart/preview isolation; it passes with a fake remote only. The settings screenshot was inspected and matches the existing setting-row, card, typography and key hint styles.

Independent review identified two issues, both reproduced with failing regression tests before fixing: IME events may omit isComposing, so composition lifecycle and keyCode229 are guarded; and an old passive listener can outlive a run/eligibility commit, so capture and accept both validate latest key and eligibility. No remaining concrete issue was identified by review. No real model request, deployment, push or merge was performed. Real hardware IME/OS variations remain outside the fake-event tests.

Follow-up review: reproduced local popup ownership crossing conversation boundaries. Main/side find, slash and context menus now only own their actual focused regions; role-bearing descendants of the terminal picker follow the same local ownership. Genuine global/modal popovers retain priority. Six bidirectional conversation tests preserve the owner's panel/run and stop only the focused opposite conversation; a nested terminal-picker regression verifies its listbox cannot claim another conversation. A failed-cancellation test confirms the existing error is displayed, drafts remain and retry requires a fresh pair. Each confirmed ownership defect was demonstrated by a failing test before correction. Independent re-review found no remaining definite issue.

Final follow-up verification: 67 UI regressions, 51 focused unit tests, current-build real Electron double-Escape/side isolation/restart test, typecheck, production build/model-boundary guard, staged repository and whitespace checks pass. No visual styling or model/network path changes were introduced by the review fixes. Changes remain uncommitted on codex/double-escape-stop.

Further lifecycle review reproduced lost IME ownership across a run key change or an eligibility disable/enable cycle. Composition tracking is now mounted for the component lifetime independently of active keyboard handling; disabled intervals still observe start/end, focus ownership and blur. Three browser fixture regressions cover run change, start while disabled and end while disabled; the two lost-ownership cases failed before the fix. Stop button accessibility text is omitted when the shortcut toggle, approval state or terminal state makes double Escape unavailable. Independent hook re-review and a fake effect harness confirm ownership survives transitions and clears on end without retaining the old sequence.

Latest verification after the lifecycle fix: 70 UI regressions, 51 focused unit tests, current-build real Electron double-Escape stop/side isolation/restart test, typecheck, production build/model-boundary guard, staged repository and whitespace checks all pass. Keyboard listeners stay stable while typing; no polling or new model/API/preview bridge is introduced. Independent re-review found no remaining concrete issue in the reviewed paths. Changes are still uncommitted and unpublished.
