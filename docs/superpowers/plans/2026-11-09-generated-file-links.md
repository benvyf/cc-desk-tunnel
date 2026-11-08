# Generated file links implementation plan

**Goal:** Make inline references to generated files open the existing sidebar from latest main.

**Architecture:** Keep ordinary Markdown links and preview routing. Resolve turn-local successful write/edit targets, and verify explicit file references or directory-qualified filenames through the existing desktop inspectPath API. Leave ambiguous references and code blocks inert.

**Tech stack:** React, react-markdown remark AST, Node test runner, Playwright.

- [x] Add regression tests for successful mutation targets, Windows paths, split directory/filename references, ambiguous names, failed calls and code blocks; run them before implementing.
- [x] Add fileMentions.ts for turn-local paths and a remark plugin that annotates inline code with candidate paths. Add an inline-code renderer that checks candidates with inspectPath and emits existing data-link anchors only for a unique existing file. Supply successful paths to the closing answer from Conversation.tsx.
- [x] Add a UI fixture using the real Conversation and preview callback; click Chinese DOCX/PDF references and assert the full path reaches the sidebar opener. Verify unknown files, ambiguous names, commands, code blocks and ordinary Markdown links.
- [x] Run focused Node tests, Playwright regression, TypeScript and desktop build. Review the final diff for scope and report the branch and validation.
