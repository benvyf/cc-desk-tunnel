# Local history cache P1 implementation

Specification: output/ui-redesign/34-local-history-cache.md v2.1 and the user's owner clarification.

1. Add `electron/history-cache.cjs` and real temporary-directory tests. Hash secret-free owner strings in the main process; isolate owner directories, serialize each session's asynchronous writes, validate JSONL, trim whole runs, and enforce cross-owner LRU/90-day expiry. Verify append/rewrite/corruption, isolation, retention, limits and concurrency with Node tests before committing.
2. Add typed IPC through main/preload and `desktop.d.ts`. Cache operations bind to their owner generation so delayed work cannot cross identities. Add an explicit protected-session IPC for LRU; `retain` continues to mean ready-list reconciliation. Clear/usage cover all owners in the profile.
3. Add client tests before changing `client.ts`: hydration precedes subscription, races discard stale reads, authoritative snapshots dominate, only synced histories persist, timeout/reconnect cannot introduce gaps, invalid cursors retry once, browser paths avoid IPC. Batch streamed writes for one second, flush before unload; cache failures never block networking.
4. Wire reliable access-service email and nodeId through App; manual/local owners follow v2.1. Add owner tests including missing email and rotating ticket addresses. Add the default-on prefs setting and disk usage/clear UI; disabling cancels queued persistence and clears all owner copies.
5. Add Playwright coverage using actual disk cache with delayed WebSocket snapshots: application restart, three-second synchronization, bottom following, reading-position preservation, disabling and original loading path. Measure select-to-state with 2000 events and main-process synchronous spans, recording evidence in client-log and docs.
6. Run `npm run check`, `npm test`, `npm run typecheck`, `npm run format:check` and relevant `npm run test:ui` under Node 24. Update `docs/LOCAL-HISTORY-CACHE.md` and `DEVELOPMENT-HANDOFF.md`, commit small verified steps, and audit all P1 requirements. Do not push, merge or publish.

Use the already approved design; execute in this chat. Preserve the original ui/motion checkout. Server and protocol files stay unchanged (protocol 24).
