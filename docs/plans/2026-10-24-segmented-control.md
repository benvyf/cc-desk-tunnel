# Sliding segmented controls

Implement the supplied light/dark capsule design in the existing desktop client.

- Share one controlled component across connection modes, usage ranges/metrics, reverse-proxy software, and transcript view mode. Preserve button/radio semantics and existing state handling.
- Track: 36px high, 2px inset, 999px radius. Equal-width options and a neutral sliding selection use the same CSS geometry, including fractional widths. Resize observation only keeps the selected option inside its scrollport; no measurement drives the animation.
- Default four-option width is 420px. Below 254px, decorative icons disappear and spacing shrinks. Long/dynamic option sets scroll inside the track without clipping labels or widening the page.
- Support arrows, Home/End, disabled options, visible keyboard focus and reduced motion. Radio groups have one tab stop. Geometry remains correct when closed details opens; resize observation reveals the selected option.
- Preserve a visible selected capsule and contrasting focus ring in Windows forced colors, using system colors. Changing reduced motion during a slide cancels it immediately.
- First add browser regressions, then implement/integrate, inspect light/dark and narrow screenshots, independently review, and run related tests, TypeScript, build, formatting and repository checks.
- Leave this scope uncommitted until the user requests submission.
