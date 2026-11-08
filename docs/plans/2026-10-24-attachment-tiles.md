# Attachment tiles

Implement the supplied Claude attachment references inside the existing composer, preserving the
local-file execution channel. No network upload is implied by a local preparation indicator.

1. Add behavioral browser tests for visible filenames instead of paths, attachment-only submission,
   removal, pending/error states, session isolation, restored drafts and reduced motion.
2. Extend the existing per-session draft store with attachment metadata. Read old string drafts;
   persist paths and names, never image data. Keep asynchronous additions tied to their original
   session and never resurrect removed attachments. Clear only attachments actually sent.
3. Add a bounded asynchronous Electron thumbnail bridge. Unsupported or unreadable images retain
   a file tile. Clipboard save errors remain visible and prevent accidental incomplete submission.
4. Render 128×96 tiles with 12px corners, 12px gaps, existing icons, theme tokens, horizontal entry
   animation and preparation pulse. Respect reduced motion and forced colors. Allow horizontal
   scrolling on narrow screens and keep removal keyboard accessible.
5. Integrate chooser, clipboard and drop with the structured draft. Serialize ready paths only at
   normal message submission; explicit slash actions leave attachment drafts intact.
6. Run focused and related Playwright tests, inspect light/dark/narrow screenshots, request an
   independent code review, fix findings, then typecheck, build, format and repository checks.

Changes stay uncommitted until the user requests submission.
