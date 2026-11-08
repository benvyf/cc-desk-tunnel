# Native terminal window implementation plan

Goal: Give the reviewed remote Claude terminal a normal movable/resizable desktop window and a direct Terminal button beside Help.

Architecture: The primary renderer continues to own ProxyClient and its authenticated socket. A narrowly allowed about:blank child window displays a React portal containing the existing NativeTerminal. The child receives no desktop preload privileges, credentials or new connection. Its native close notifies the owner so existing terminal cleanup closes the PTY. One terminal window per connection; repeat opens restore/focus it. Browser mode retains embedded terminal. Preserve current busy/session admission.

Base: published Windows Build 18, commit 35705a3bb5e8c0dc90012c64cb288e61cc61ba1f. Existing older checkout and server release changes are preserved separately.

- [x] Add failing main-process tests for narrowly allowed popup, sandbox settings, duplicate focus, owner-close cleanup and child-close notification.
- [x] Implement electron/terminal-window.cjs with a blank unprivileged preload; integrate owner close/focus IPC and skip native titlebar overlay updates for ordinary terminal windows.
- [x] Add DetachedTerminal React portal wrapper, stylesheet/document setup, geometry sizing, error fallback and lifecycle cleanup.
- [x] Add direct Terminal action beside Help using existing session admission; repeat invocation focuses existing popup.
- [x] Verify main-process tests, TypeScript/build, frontend/native terminal regressions and real Electron synthetic terminal keyboard/resize/close flows. Never launch real CLI or moderation requests for validation.
- [x] Review changes, preserve source and produce a desktop build suitable for user review. Keep Linux Build 6 and its moderation unchanged.

Verification: four main-process tests and real Electron dev/file-origin synthetic terminal tests passed. TypeScript and Vite build passed. Review caught missing child edit menu (fixed). File-origin exit test caught portal quit ordering (fixed by destroying terminal windows before primary quit). No real remote CLI or moderation requests. Installer verification follows packaging.
