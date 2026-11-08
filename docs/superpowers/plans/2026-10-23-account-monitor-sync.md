# Account monitor sync implementation plan

**Goal:** Mirror existing Ubuntu CC account readings to the VPS without additional Claude requests.

**Architecture:** A bounded background reporter observes existing server events. The update service authenticates per-node writes, persists validated snapshots, and exposes them only to its existing administrator. No desktop protocol changes are needed.

**Tech stack:** Node 24, TypeScript, SQLite, existing vanilla JS management page, node:test and Playwright.

- [x] Shared contract: `packages/protocol/src/account-monitor.ts`; reject unknown fields, invalid dates/numbers and credential-like arbitrary payloads. Test through receiver requests.
- [x] Reporter: `apps/server/src/account-monitor.ts`, config and event wiring in `config.ts` / `server.ts`. Real HTTP tests cover projection, deduplication, retry and nonblocking replacement. Implemented `observe(payload, sessionId, sourceId)`, process identity binding and `close()` with no Claude dependencies.
- [x] Receiver: `apps/update-service/src/monitor.ts`, config and HTTP routes. Requests assert `401/403/400` on wrong identity, browser Origin and malformed input; old data does not replace fresh data and restart preserves snapshots. Implemented node-bound `POST /cc-updates/admin/api/monitor/report` and authenticated `GET /cc-updates/admin/api/monitor`.
- [x] UI and packaging: cached node/account quota, reset times, latest session usage and freshness in existing management page; runtime files and operator instructions included. Real browser acceptance covers actual synthetic node report, read-only refresh, logout and mobile layout.
- [x] Verify: focused tests 14 passed; Node 24 full regression 361 tests, 330 passed, 31 platform/opt-in skips, zero failures. Typecheck and opt-in real browser acceptance passed. Event wiring reviewed: no new Claude calls. Deployment boundary recorded in `docs/ACCOUNT-MONITOR.md`.

All requests in new tests target local fixtures. Do not read or copy Claude credentials or probe the live account during verification.
