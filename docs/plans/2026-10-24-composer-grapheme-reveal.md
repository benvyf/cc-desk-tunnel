# Composer and grapheme reveal

Implement the two supplied visual references inside the existing client. The screenshots describe the requested effect; their labels do not establish Claude's internal implementation.

## Selected design

- Keep the composer's 20px radius and native textarea auto-growth. Add two named shadow layers, with deeper values on focus within, interpolated with existing motion tokens. Retain keyboard, IME, attachments, send/stop controls and short-window sizing.
- Use a quiet blue-grey, 20px user bubble aligned to the right. Assistant replies remain open prose with existing branding and message actions.
- Reveal appended prose as complete Unicode graphemes with a 6px-to-zero blur over 90ms, staggered by 30ms. Preserve natural inline wrapping, selection and text content. Completed/history/replaced content stays immediate; code, math, tables and tool output stay immediate.
- Use Intl.Segmenter and a CSS animation, with no timers or token queue. Bound each render to 24 animated graphemes across all prose leaves; cap delay at 180ms. Excess burst text renders immediately. Settled prefixes become ordinary text on the next append. A grapheme that extends across chunk boundaries must remain intact.
- Reduced-motion disables blur, animation and shadow interpolation immediately. Support light/dark themes and narrow/short viewports. Do not add dependencies or change backend streaming.

## Implementation and verification

1. Add browser regressions for Unicode-safe reveal, bounded bursts, actual blur/timing, line wrapping, reduced motion, and existing composer auto-growth/focus geometry. Confirm missing behavior before implementation.
2. Update the small streaming rehype transform and the targeted theme/composer/message CSS. Reuse existing Markdown and motion infrastructure.
3. Run motion, typography, theme, conversation copy/search/follow and long-transcript regressions; inspect desktop/mobile light/dark captures. Run TypeScript, changed-file formatting, repository checks and production build.
4. Request an independent code review, resolve actionable findings and record verification. Leave the changes available for review; commit/push requires the user's next instruction for this scope.

## Review and verification

- The three new browser cases failed against the old implementation: missing second shadow layer and missing grapheme reveal. They pass with the new implementation, including actual painted inline blur, Unicode sequences, selection text, unchanged English/Chinese/Arabic wrapping, reduced motion, and the shared 24-node budget across many Markdown leaves.
- Reproduced a width-only sizing gap: a 90px draft stayed 90px after narrowing the window. Composer now observes its border-box width and fits the current draft after width changes. A cancelable animation frame keeps height writes outside ResizeObserver delivery; the window-error regression failed before that adjustment and passes afterward.
- Updated one existing typography assertion to match bounded burst animation: all 12 coalesced paragraphs render immediately, while at most 24 graphemes animate. Search and completion checks remain in place.
- Final related UI suite: 46 passed, covering composer, motion, typography, themes, search/copy, scrolling, reply actions and 400-step conversations. The final run contains no ResizeObserver errors.
- Production Electron smoke, existing composer growth and draft persistence/restart checks: 3 passed. Validation used local simulated services.
- TypeScript, changed-file Prettier, production build and repository checks passed. The build retains its existing warning about chunks larger than 500kB.
- Inspected desktop and narrow light/dark screenshots plus the paused blur-start capture. An independent review approved the final implementation after the observer correction. Changes remain uncommitted.

## Detail review follow-up

- Reproduced a whitespace allocation issue: 10,000 consecutive spaces followed by two visible characters created 10,002 children in one reveal container. Whitespace now stays in complete text slices, bounding both animated spans and intervening text nodes while preserving every character. The new browser regression failed before the fix and passes afterward.
- Reproduced replay after changing the system motion preference: disabling then re-enabling motion started animations on two previously displayed characters. Live RichText now observes that preference, renders without segmentation while reduced motion is active, and resets the reveal boundary when the preference changes. Static history does not subscribe to preference changes. The regression failed before the fix and passes afterward.
- Independent follow-up review found no further actionable issues in either fix. Twenty isolated Unicode, whitespace and source-offset probes retained the original text and bounded node counts. A separate React SSR probe with 100,000 spaces went from 100,001 container children to two; this is an allocation check, not a browser frame-rate benchmark.
- Fast streaming retains the selected policy: each new batch renders immediately and settles the preceding batch rather than queuing model output behind animations. The 24-grapheme and 180ms delay limits remain in place.
- Fresh verification after both fixes: all 48 related UI cases and three production Electron/composer/draft cases passed. TypeScript, changed-file formatting and production build passed; the existing chunk-size warning remains. The 400-step run opened in 77ms/453ms and typed at 4.9ms/27.6ms per key in standard/expanded modes in this local run.

## Second full review

- Added browser coverage for stopped/completed replies resuming without animating history, replacement snapshots staying immediate, a surrogate pair split between chunks, and an HTML entity whose Markdown source length changes as it completes. All eight composer/reveal cases passed in the focused run.
- Instrumented actual media-query subscriptions in the browser: static history adds none; eight stream/completion cycles hold exactly one while live and release it on completion; unmounting a live reply also releases it.
- Added keyboard-event regression coverage: a composing Enter does not send, Shift+Enter inserts a newline, and ordinary Enter sends once and clears the draft. This checks the input handler, not a hardware IME candidate window.
- A fresh independent review found no additional actionable source issues. Isolated probes passed 164 Markdown offset/text-preservation cases and 21 UTF-16 split checks across ZWJ emoji, combining marks, modifiers and flags, while keeping the 24-span budget. No production source changed during this pass.
- The expanded regression run passed all 109 tests in 4.2 minutes, including production Electron smoke/restart, composer, motion, typography, themes, conversation tools/following, long transcripts, request interruption, settings, slash commands and turn statistics. Services were local simulations; the run reported no failures or ResizeObserver loop errors.
- Fresh TypeScript, production build, changed-file Prettier, whitespace checks and repository checks passed. Repository checks covered 485 files through a temporary index containing the current changes, including new files; the real index was left unchanged. The existing production chunk-size warning remains. Changes are uncommitted and unpushed.
