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
