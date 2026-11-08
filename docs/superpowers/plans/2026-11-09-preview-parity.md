# Spreadsheet preview and source highlighting

Approved scope: add read-only XLS/XLSX/CSV/TSV table viewing with sheet switching, row/column headers and scrolling, plus source syntax colors. Preserve existing sidebar, PDF/Office rendering, line navigation, copying and file permissions.

Use SheetJS 0.20.3, as deepseek-harness does for legacy spreadsheets, in a lazy Web Worker for all four formats. Use saved formatted values, preserve CSV identifiers, never evaluate formulas or render authored HTML. Bound bytes, worksheet area, sheet count and parse time; render only visible rows. Unknown or corrupt data gets a clear preview error and existing system-open action.

Use highlight.js tokens with the CSS Custom Highlight API over the existing single source text node. This preserves Range-based line positioning and native selection. Unsupported languages or large sources keep plain code. Share document-local highlight sets across multiple preview panes and remove owned ranges on cleanup.

- [x] Add failing parser, file-routing and syntax token tests with real XLS/XLSX bytes and quoted CSV/TSV.
- [x] Implement bounded spreadsheet parser, worker, table view and existing preview integration.
- [x] Implement syntax range colors without changing code text DOM or line geometry.
- [x] Verify spreadsheet switching, huge/sparse inputs, formula/HTML text, source copy/navigation, theme, scroll and multiple panes. Run Node 24 tests, UI tests, typecheck and production build; independently review the final diff.
