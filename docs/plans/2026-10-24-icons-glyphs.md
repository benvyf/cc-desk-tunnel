# Icons & Glyphs

Apply the user's selected icon reference to the existing desktop client. The screenshot is visual reference, not evidence of Claude's internal implementation.

## Selected design

- Use Phosphor 2.1.10 SVGs with a 256 × 256 coordinate system. Generate a static subset with `node scripts/generate-desktop-icons.mjs`; `--check` verifies reproducibility. Only used regular glyphs and navigation bold variants ship. Phosphor remains a development dependency. Preserve its MIT notice in the generated source and build.
- Use regular glyphs by default and actual bold glyphs for selected page/settings navigation. No duotone or CSS stroke simulation.
- Use five size tokens: XS 12, SM 16, MD 20, LG 24, XL 32 pixels. Inline icons align at −0.125em; flex controls retain centered alignment.
- Use the Claude radial Spark for the existing thinking indicator. Preserve the product's terminal identity and GitHub mark. Keep stop/send actions, colors, accessibility labels, copy confirmation and loading animations.
- Scope icon styling to application icons. Preserve KaTeX stretchy SVGs, context rings and usage charts.
- Ship the complete attribution at `public/assets/THIRD_PARTY_NOTICES.txt`, so both Electron packages and the production Web static route retain access to it, including installations with a custom URL path.

## Implementation and verification

1. Add a central typed icon adapter, migrate existing imports and remove Lucide.
2. Normalize contextual dimensions to the five tokens, update send/source glyphs and navigation weights.
3. Exercise selected navigation, icon sizing, decorative semantics and spinner behavior in browser tests. Retain formula/chart and copy-feedback regression coverage.
4. Run type checking, production build, focused UI regressions, formatting and independent review. Inspect light/dark desktop/narrow screenshots and bundle impact.

Spark vector source: https://github.com/simple-icons/simple-icons/blob/develop/icons/claude.svg (Simple Icons, CC0; Claude trademark belongs to Anthropic). Use only as the existing Claude thinking indicator, not as CC Desk Tunnel branding.
