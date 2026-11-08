# Session defaults and smooth effort slider

**Goal:** Persist a model and effort for manually created sessions, and make the existing effort capsule follow the pointer continuously.

**Design:** Add a local `sessionDefaults` preference in General settings. Use the connected service's advertised model catalog; preserve saved choices while offline and offer the native default. Defaults apply to ordinary desktop/browser sessions and new project sessions, using the existing create/configure requests before opening the new session. The existing busy guard keeps sending disabled until setup completes. Existing sessions, forks and scheduled task overrides retain their settings. Unsupported advertised model/effort combinations fall back to native defaults without changing saved preferences. No protocol or server upgrade is required.

The slider retains its 30px capsule geometry and theme tokens. A continuous native range controls local preview while dragging; release snaps to a supported effort and submits once. Keyboard navigation moves one supported level. Cancellation, model changes and unmount do not submit; delayed or failed configuration restores the authoritative value without overwriting newer interactions. Reduced motion and forced colors remain usable.

**Tech:** React, existing shared preferences, protocol 20 requests, Playwright and Node tests.

- [x] Add failing tests for preference validation/compatibility and for continuous drag, commit timing, keyboard and cancellation.
- [x] Add General settings controls, preference persistence and apply defaults to manual session creation. Verify persistence, existing-session isolation and pending-configuration input blocking with a simulated WebSocket service.
- [x] Extract an effort slider with continuous preview and discrete commit; preserve native semantics and existing appearance.
- [x] Run focused tests and related settings/model/composer regressions, typecheck, formatting, repository validation and production build. Inspect both themes and a narrow viewport.

Implementation is limited to client code and regressions; packaging/publication is a separate user action.

Review and validation: independent review identified a mismatch between live and history-loaded model catalogs; initialization now uses the same catalog as settings. An Escape-during-drag regression exposed an exit-animation commit; hidden/inert sliders and Escape now cancel pending input. Focused browser tests cover continuous motion, release outside, keyboard cancellation, pending-save position, failed-save recovery, preferences after reload, existing-session isolation, input blocking, creation despite configuration failure and unsupported saved defaults from a snapshot catalog. Five focused and 31 related browser tests passed. Unit suite: 491 passed, 34 skipped, zero failures. Typecheck, repository checks, formatting and production build passed (existing Vite chunk-size advisory). Both themes were visually inspected at 320px and desktop width; forced colors and reduced motion were exercised.

Second detail review: no additional production defects were found. Added browser ordinary-session coverage and a Windows Electron smoke test using an isolated profile and a local WebSocket fixture. These verify saved defaults, preserving the created `auto` permission mode, no input before initialization, and no workspace-removal IPC when configuration fails. Keyboard coverage now asserts focus is retained after saving, so consecutive key operations do not need to refocus the slider. Seven focused tests passed, including Electron; typecheck and production build passed again.

Final defaults/slider review: added coverage for advertised effort-level changes during a drag and real Electron preference synchronization between two windows. Nine focused tests passed. Independent static review found no additional actionable defects.

Full model names: the user additionally requested versioned conversation labels such as `Opus 5.5`. A shared display helper derives the version from the advertised resolved Claude model ID when the SDK supplies only a family label. Conversation controls, model options and default-model settings use it without changing submitted model IDs. Complete/custom labels and context-size suffixes are retained, dated legacy IDs are supported, and a different model family's fallback cannot supply the version. A 320px screenshot was visually checked. Eleven related UI tests and four focused unit tests passed; typecheck, repository checks, formatting, diff whitespace validation and the latest production build passed (existing chunk-size advisory).

Latest full unit run: 492 passed, 34 skipped, one failure in the existing SSH test `large output and input pass unchanged` (received 50,229,248 of 50,331,648 expected bytes). Rerunning the tunnel test file passed all 11 tests, including that individual test. No tunnel implementation or test was changed for this UI task; the initial full-suite failure remains recorded rather than claiming a clean full run.
