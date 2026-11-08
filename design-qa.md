# Attachment tiles visual QA

Source visual truth:

- Light: `C:/Users/benben/AppData/Local/Temp/codex-clipboard-b44d602d-a2e3-4573-bbcd-a74f691030b0.png` (1040×575).
- Dark: `C:/Users/benben/AppData/Local/Temp/codex-clipboard-f8eb48b2-c2b6-40fb-ae4e-29309635c7f4.png` (1038×570).

Implementation evidence under `.local/screenshots/`:

- `attachments-reference-light.png`, `attachments-reference-dark.png`: same four filenames and ready state, 1280×900 CSS viewport, density 1.
- `attachments-reference-row-light.png`, `attachments-reference-row-dark.png`: focused 654×114 row captures.
- `attachments-comparison-light.png`, `attachments-comparison-dark.png`: source card strip above the implementation strip, together in one image at 1:1 pixel density. No scaling applied; compare component geometry rather than the demonstration page's surrounding layout.
- `attachments-native.png`: real Electron composer with an actual file and generated raster image thumbnail.
- `attachments-narrow.png`: 360×740 CSS viewport; ten attachments scroll within the composer.
- `attachments-short-320.png`, `attachments-short-390.png`: long drafts plus an attachment at 320×280 and 390×400; toolbar remains reachable and keyboard focus scrolls input content into view.

## Findings

No actionable P0/P1/P2 visual mismatch in the compared attachment component.

- Typography: existing Segoe UI / Microsoft YaHei retained for UI continuity; 12px filenames and 10px monospace type badges. Labels align to the bottom and truncate without expanding tiles. The source uses a slightly different Latin font, an accepted integration difference.
- Layout: verified 128×96 tile dimensions, 12px corners and 12px spacing. Composer adds 16px horizontal and 14px top inset; the reference is a standalone demonstration. The enclosing composer, project controls and toolbar intentionally retain the existing product layout.
- Colors: existing theme surfaces, borders, muted text and semantic error tokens adapt automatically. Dark tile surfaces follow the application's existing warm neutral palette. Photo controls have opaque theme surfaces for legibility over imagery.
- Image quality: real Electron PNG thumbnail decoded and displayed successfully, with bounded preview size. Images fill the tile with cover cropping; filename remains legible on its own surface. Standard existing file/code/close icons are reused; no raster asset is implied by the reference's file cards.
- Content: actual filenames and semantic type labels; demonstration headings and fake upload controls are excluded from the product UI.
- Interaction/accessibility: chooser, image paste, removal, filename truncation, session switching/reload, attachment-only submission and sent-message cards verified. Preparation uses horizontal entry and a breathing pulse. Reduced motion removes animations; forced colors and keyboard removal tested. Original text remains available to copy/export.
- Errors: actual Electron test recorded no uncaught renderer errors. Failed image preparation remains visible and blocks incomplete submission. Unsupported/unreadable previews fall back to file cards.

## Comparison history

The first visual comparison used matched ready file cards in both themes and found no actionable P0/P1/P2 drift. Functional review separately found and fixed draft hydration/removal races and clipboard cache protection; regression coverage documents these behaviors.

Detail review reproduced further edge cases and added regression coverage. Attachments and long drafts could push send/stop controls outside a 320×280 window; the input content now scrolls above the fixed toolbar, and attachment rows retain their full height. Clipboard/drop images without a filename extension previously missed their preview; tile classification now uses the saved path's basename while preserving the original display name. Dots in parent directories no longer affect extensionless file badges.

Final review reproduced a message-length boundary: a valid 16000-character body became invalid once attachment references were appended. The composer now validates the full message against the existing limit, announces an actionable error and blocks submission without truncating text or removing attachments; the App submission boundary also checks the full message. Regression coverage includes both over-limit recovery and an exactly 16000-character message, delayed chooser session isolation, and rejected thumbnail requests falling back to sendable file cards.

## Implementation checklist

- [x] Matched ready states and focused comparison in both themes.
- [x] Real Electron image preview and complete send flow.
- [x] Narrow horizontal overflow stays inside the row.
- [x] Reduced motion and forced colors keep controls usable.
- [x] Existing product typography, tokens and composer layout retained.

final result: passed

## Main branch integration — 2026-10-25

Merged all ten desktop UI commits through `a062ade` with main's `8cc84d4` elevation update. CSS resolution retains the theme shadow tiers, composer inset focus/drag rings and forced-color fallback alongside the new component and motion tokens.

Integration verification: repository check, TypeScript, full formatting and production build passed (existing Vite chunk-size advisory remains). Full unit run: 489 passed, 34 skipped, zero failures. The 157-case UI run passed 156 cases; its sole failure was the obsolete Electron assertion for path text in the composer. Updated it to verify the selected file's tile, path metadata and remove control with an empty text input; its focused rerun passed. No production behavior was changed for this test correction.

The historical Build 2 fixture remains unchanged. Its obsolete assertion freezing current sources and dependencies to that inventory was replaced with a synthetic installed-image compatibility check and rejection of a signed candidate using the historical inventory. The targeted 20 upgrade/supervisor tests and complete unit run passed. Two existing document formatting issues were corrected without content changes.

# Code block and copy visual QA

Source visual truth (normal and copied states, light and dark):

- `C:/Users/benben/AppData/Local/Temp/codex-clipboard-8c20911c-dca9-48d0-a001-0b041b1e4a7d.png`
- `C:/Users/benben/AppData/Local/Temp/codex-clipboard-fec8b0e4-e610-4fc4-b3ad-e02c6561ca5b.png`
- `C:/Users/benben/AppData/Local/Temp/codex-clipboard-5c8bfe5b-8965-4855-a713-1cd8df126f2d.png`
- `C:/Users/benben/AppData/Local/Temp/codex-clipboard-3b406b34-b356-4c18-b640-18cd60a9f70f.png`

Evidence under `.local/screenshots/`:

- `code-block-page-light.png`, `code-block-page-dark.png`: 1280×900 CSS viewport at density 1.
- `code-block-light.png`, `code-block-dark.png`, `code-block-light-copied.png`, `code-block-dark-copied.png`: 672×105 component captures.
- `code-comparison-light.png`, `code-comparison-dark.png`, `code-comparison-light-copied.png`, `code-comparison-dark-copied.png`: reference crop above implementation, at 1:1 density without scaling.
- `code-block-narrow.png`: 320×600 viewport, header wrapping and horizontal code scrolling.

## Findings

- Typography: 13px monospace code with 1.5 line height, 12px monospace header, and aligned language/action icons. Initial 12px code was too small; post-fix comparisons use 13px.
- Layout: 12px corners, 32px minimum header, 16px body inset and a distinct header divider match the component reference. Narrow headers wrap without overlapping the code or actions.
- Colors: dark code surfaces remain consistent in both application themes. Light mode adds a subtle shadow; dark mode keeps the border. Moving `color-scheme: dark` onto the code body corrected the initially missing light-mode shadow. Success and failure feedback use legible semantic colors.
- Icons/assets: reused the existing file-code, copy, check and preview glyphs; no new raster assets. This is an intentional difference from the reference glyph shapes.
- Content: Chinese labels “复制代码” and “已复制” retain product language. Unlabelled blocks display `text`. The surrounding demonstration canvas and headings are excluded from the product UI.
- Interaction: exact source text including trailing newline is copied. Success remains for 2500ms, fades during the last 20%, then restores the copy label without width changes. Repeat clicks restart feedback; stale clipboard promises cannot overwrite the latest result. Failure/retry, independent blocks and unmount cleanup are covered.
- Compatibility/accessibility: streaming and safe SVG preview/source switching remain functional. Keyboard focus remains on the button; accessible feedback updates politely. Reduced motion shows static success until reset. Forced colors preserve borders and focus. Header metadata is excluded from conversation search.
- Errors: focused browser tests collect page errors and recorded none. In-app browser clipboard interaction also showed the success state and returned to the normal state.

## Validation

Six focused browser tests passed. The broader 50-test run passed across code blocks, composer reveal, conversation tools, Electron app smoke, themes and typography. TypeScript and production build passed; the existing Vite chunk-size advisory remains. Independent code review found no actionable issue.

Detail review added keyboard Enter/Space coverage: focus stays on the copy control through success and reset, and reduced-motion feedback remains visible until exactly 2500ms. A second regression covers long language labels and nested SVG controls at 320px. All eight focused tests passed without page errors. Manual layout probes at 240px, 320px and 672px found no document overflow or actions outside the header. TypeScript, formatting and repository checks passed again. No production-code correction was required by this review.

The second detail review found and corrected a slow-clipboard repeat regression: starting a new request cancelled the existing reset before that request settled, leaving the old accessible status stale indefinitely. The previous feedback timer now remains active until the latest clipboard result replaces it. New regressions reproduced the failure for both the default 2000ms control and the code 2500ms control before the fix, then passed after it. They also verify a prolonged pending interval and a full fresh feedback interval after resolution. All ten focused tests passed; independent re-review confirmed the correction and found no remaining actionable issue. Production build, TypeScript, formatting and repository checks passed after the fix.

The complete post-fix regression run passed all 54 tests across code blocks, streaming/composer, conversation tools, Electron app smoke, themes and typography (2.6 minutes).

Final paired comparisons were inspected after typography/shadow corrections and non-hover success captures. No actionable visual mismatch remains in the implemented component; intentional integration differences are documented above.

final result: passed

# User message time, copy and edit QA

Source visual truth: `C:/Users/benben/AppData/Local/Temp/codex-clipboard-642ad3af-a3aa-429f-8695-d188615a9441.png` (126×48 pixels).

Implementation evidence under `.local/screenshots/`:

- `user-controls-iab.png`: actual local app, 1280×720 viewport at density 1; finished user message with time/copy/edit, after keyboard-independent copy and edit/resend were exercised in the in-app browser.
- `user-controls-light.png`, `user-controls-dark.png`: 722×75 user message captures from the 1280×900 browser test at density 1.
- `user-controls-narrow.png`: 234×75 user message in a 320×600 viewport.
- `user-controls-comparison.png`: source above the same-size rightmost 126×48 implementation crop, no scaling. Theme transitions are disabled for the evidence capture so intermediate colors are excluded.

Findings:

- Typography: 12px muted, tabular time matches the compact reference hierarchy. Today shows HH:mm; older messages retain their date context, and the full timestamp stays available in the title. Assistant date labels remain unchanged.
- Layout: the row stays right-aligned below the bubble, in time/copy/edit order. Both controls have 24px square targets with 16px vector glyphs, retaining the existing control/icon tokens. Narrow view has no document overflow; historical messages can be scrolled into view to reach their controls.
- Colors: existing warm neutral app tokens adapt in both themes; the source's slightly lighter charcoal background is an intentional application palette difference. Copy and edit hover/focus states retain established tokens.
- Assets: established Copy, Check and Pencil library glyphs remain crisp. No raster asset or decorative image is needed for this row. The source's rounded copy hover surface is represented by the existing hover treatment rather than a persistent fill.
- Content: time and icon-only controls follow the reference, with Chinese accessible names and descriptive titles. Delivery status remains quiet on confirmed messages and visible when unsettled; this existing delivery information is additional to the cropped reference.
- Behavior: copying remains available while thinking or awaiting approval. All active run states hide edit; completed, cancelled and failed states restore it. Editing uses the existing fork-before-message flow and restores original text and attachments; the original session remains intact. The existing backend restriction on native messages appended within a run is preserved, so those joined messages remain copyable but cannot be fork points.
- Errors: in-app browser console reported no errors. Independent review identified three existing integration gaps exposed by this feature: editing did not focus the composer, a delayed fork could override subsequent navigation, and compact timestamps stayed undated after midnight. Each was reproduced with a failing regression and fixed. Editing now focuses once when the input is enabled, with the caret at the end; navigation changes cancel automatic opening/focus while preserving the forked draft; local-midnight and window-focus refresh keep dates current without idle polling. A second read-only review found no remaining actionable issue in these fixes.

Verification: seven footer tests, real stop-then-edit and existing edit/resend app flows, real Electron attachment restoration, conversation tools and typography were exercised in the 38-case run. Thirty-seven passed initially; one existing other-device list test was disturbed by the simultaneous manual preview connection, then passed in isolation after that connection was closed. The final screenshot-capture test passed again after disabling theme transitions. Message-time unit test, production build, TypeScript, formatting and repository checks passed. Existing Vite chunk-size advisory remains.

Review verification: the final combined app, real Electron attachments, composer/streaming, conversation tools and footer run passed all 36 tests (2.7 minutes), including keyboard edit/caret placement, delayed response after navigating away and back, stop-then-edit, attachment-only focus, local midnight and window-resume dates. Message-time unit test, TypeScript, production build, formatting, repository validation and diff whitespace checks also passed. Changes remain uncommitted.

Second review: reproduced one additional focus race by delaying the fork's history snapshot and matching response in their original order. A reader could open conversation search while the composer was disabled, then history completion stole focus. The composer now checks the current focused element before applying the one-shot edit focus and consumes the request even when another control keeps focus. The regression verifies continued typing stays in search, the original draft remains intact, and closing search never replays autofocus. Normal keyboard edit, stop/edit and delayed-navigation flows still pass. Midnight and window-resume tests now cover both finished and running questions; the React Compiler did not prevent date refresh in either case. Independent read-only re-review found no new actionable issue in the fix.

Second review verification: six focused edit/date cases passed, followed by all 46 attachment, real Electron, composer/streaming, conversation-tools, footer and typography regressions (1.6 minutes). All 21 client/message-time unit tests, TypeScript, production build, formatting, repository validation and whitespace checks passed. Fresh light, dark and 320px-wide footer captures were inspected with no clipping or alignment defect. Changes remain uncommitted.

Implementation checklist:

- [x] Always-visible time/copy/edit row in both themes and narrow view.
- [x] No edit during active runs; edit returns after every terminal state.
- [x] Keyboard copy, raw text and attachment edit restoration verified.
- [x] Source/implementation paired comparison and real in-app interaction inspected.

final result: passed
