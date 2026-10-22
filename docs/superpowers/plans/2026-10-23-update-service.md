# Update service implementation plan

> **For agentic workers:** Use executing-plans inline; use requesting-code-review for independent review at completion.

**Goal:** Complete delivery B of the approved VPS update-channel architecture: isolated publication storage, authenticated management page/API and Linux deployment artifacts.

**Architecture:** Node 24 HTTP + built-in SQLite, with atomic active-index transactions and immutable filesystem artifacts. The service binds loopback; Nginx serves HTTPS and static installer Range responses. Signing keys stay offline.

**Tech Stack:** TypeScript, node:sqlite/crypto/http/fs, vanilla HTML/CSS/JS, node:test, systemd/Nginx samples. No new workspace or npm runtime dependency.

## 1. Durable publication store

Files: `apps/update-service/src/store.ts`, `apps/update-service/test/store.test.ts`.

- [x] Write real filesystem/SQLite tests. API: `UpdateStore.open(dataDir, trustedKeys, actor)`, `createCandidate(envelope)`, `upload(id, readable)`, `activate(id)`, `removeCandidate(id)`, `status()`, `channel(name)`, `close()`.
- [x] Verify red with `node --test apps/update-service/test/store.test.ts`; implement strict signed input, 8-candidate cap, streamed size/hash, persistent cross-channel build identities, monotonic revisions, exclusive writer lock and atomic DB activation/audit. Test observed output bytes against `verifyIndex` rather than mocks.
- [x] Exercise tampering, partial/overlong uploads, existing conflicting artifacts, failed activation/retry, renewal, promotion, withdrawal, second writer and restart persistence; run store tests green.

## 2. Authenticated HTTP and management webpage

Files: `apps/update-service/src/http.ts`, `config.ts`, `main.ts`, `web/index.html`, `web/app.js`, `web/style.css`, `test/http.test.ts`.

- [x] Write loopback integration tests: valid token + exact Origin can create/upload/activate; missing/incorrect credentials, Origin, Content-Type and illegal paths cannot mutate. Public metadata is exact signed bytes and GET/HEAD only. No public API exposes private files.
- [x] Run tests red, implement explicit routes, body bounds/timeouts, strict configuration, hashed token comparison, failed-auth limits and security headers.
- [x] Implement token-in-memory page with file inputs and text-only rendering, no arbitrary URL/path or signing action. Validate actual page workflow in browser with temporary keys/data; do not use production credentials.
- [x] Add test glob to root `npm test` so new service tests remain in routine verification.

## 3. Packaging, documentation and review

Files: `scripts/package-update-service.mjs`, `deploy/update-service/cc-update-service.service`, `nginx.conf.example`, `config.example.json`, `docs/UPDATE-SERVICE.md`, links in managed-update docs.

- [x] Provide dedicated unprivileged service/data/config paths, loopback-only listener, Nginx exact routes and readonly public files. Document external token creation without committing secrets, pinned public keys, backup/recovery, reserved build behavior and expiry renewal.
- [x] Package allowlisted runtime files only, without npm installation, existing service files or private config. Record clean source commit and verify archive contents after local commit.
- [x] Run focused tests, typecheck, full suite, formatting, frontend build, index secret/link check and diff checks. Request independent review and fix material findings.
- [x] Commit reviewed implementation locally. Delivery A was pushed first at user request; this step does not imply production deployment. Record real Linux HTTPS/Range/systemd testing as outstanding until a Linux test host is available.

## Verification record (2026-10-23)

- Full suite: 347 tests, 316 passed, 31 skipped, 0 failed (72.55 seconds). The browser test is opt-in.
- Final focused run with CC_UPDATE_UI_TEST=1: all 15 tests passed, including real Edge HTTPS workflow, desktop/mobile layout and archive allowlist checks.
- Typecheck, repository formatting and desktop production build passed. Build retained existing bundle-size/performance notices.
- Independent review passed after fixing durable file/ancestor-directory synchronization and preserving per-channel build floors across withdrawal. Process-kill writer-lock recovery is covered.
- Final staged-index secret/link checks and source-archive smoke verification are completion gates. The archive records its committed source revision; standalone smoke evidence accompanies the generated artifact outside tracked sources.
- Production is unchanged. Linux systemd isolation, real Nginx HTTPS/HEAD/Range, Linux filesystem durability/permissions and VPS deployment remain outstanding. Delivery C (client integration) is separate.
