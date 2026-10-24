# Code block and copy implementation plan

Goal: apply the supplied code-container references and 2.5-second success fade to Markdown code blocks.

Design: reuse RichText's pre renderer and the shared CopyButton with an opt-in code variant. Add a 32px header with a file glyph, language label (text for unlabelled blocks), and copy/SVG actions. Keep the reference's dark code canvas in both themes; use a light-theme shadow and a dark-theme border. Use existing icons and Chinese product labels. Preserve raw code, horizontal scrolling, SVG preview/source switching, and streaming.

- [x] Add a runnable RichText fixture and browser tests in `apps/desktop/test/code-block.spec.ts`: exact code copy, language labels, no header overlap, success at 2.5 seconds, repeated clicks, failure/retry, independent blocks, streaming updates, SVG source, narrow layout and reduced motion.
- [x] Confirm new structural/timing tests fail before implementation.
- [x] Update `RichText.tsx` to render a header and opt into the code copy feedback. Update `copy.tsx` with bounded feedback timers and stale/unmounted-request protection. Other copy controls keep their existing feedback duration.
- [x] Update `style.css` with named code colors, 12px corners, monospace header/body, fixed-width layered feedback and the 2500ms fade; disable the fade under reduced motion and retain forced-color focus visibility.
- [x] Run focused browser tests, then Markdown/streaming/conversation/theme regressions, TypeScript, build and formatting/repository checks. Request an independent review.
- [x] Compare screenshots in both themes and copied state with the supplied reference images in one comparison artifact. Record evidence in `design-qa.md`.

Changes remain uncommitted until the user requests submission.
