# Managed Server Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish the current combined custom server and let a mismatched desktop explicitly upgrade a compatible managed server.

**Architecture:** Merge both custom branches first. Use an authenticated management HTTP API independent of business protocol and a signed fixed-origin program distribution, supervised inside the existing container. Preserve immutable runtime and review policy; reject dependency changes.

**Tech Stack:** Node 24, TypeScript, Electron, Python bootstrap, Linux Docker, Ed25519, existing VPS update service.

### Task 0: Integrate the updated GitHub branch

- [x] Merge origin/codex/vps-update-channel (9f783b2) into current dedicated codex/account-monitor-production branch.
- [x] Resolve server/config conflicts keeping passive monitor hooks and the latest native terminal policy/deployment validation.
- [x] Keep all existing navigation, monitor enrollment and Build 3 download behavior; combine new test coverage and renewal deployment assets.
- [x] Run Node 24 tests and TypeScript checks; independently review spec compliance and code quality, then commit the integration (3ff4c5c; 445 tests, 0 failures; isolated Linux Python checks 38 passed).

### Task 1: Signed server contract and supervised upgrade

- [x] Add strict separate Linux server manifest contract and fixed trusted identity without weakening the Windows contract.
- [x] Add authenticated management check/install/status endpoints with idle and maintenance guards independent of protocol mismatch.
- [x] Add staged verification, dependency compatibility, backup, restart health check and rollback supervisor with crash recovery.
- [x] Write failure-first tests for authentication, busy state, hash/signature tampering, traversal, failed health and preservation of new data.
- [x] Spec and quality reviews approved. Node 24 regression: 473 tests, 442 passed, 31 skipped, 0 failures. Focused package checks: 29 passed. Isolated Linux: 27 passed; supervisor startup/readiness/shutdown passed with network disabled, synthetic policy, no account mounts and zero CLI invocations. Commit after these checks.

### Task 2: Desktop mismatch upgrade flow

- [x] Add dedicated main-process check/install/status IPC with fixed paths and certificate-before-token behavior.
- [x] Show “升级配套服务端” for protocol mismatch, confirm exact target, show progress/result, and offer bootstrap instructions for old unsupported servers.
- [x] Keep legacy update IPC blocked; test same-version protocol mismatch and failed upgrades.
- [x] Spec and quality reviews approved frozen tree 10539bd90e43519c9f0da9f83485189088b3cfd8. Independent Node 24 regression: 485 tests, 454 passed, 31 skipped, 0 failures; Chrome UI: 5 passed. Production desktop staging/import smoke, typecheck and formatting passed.

### Task 3: Full packaging, first bootstrap and VPS distribution

- [ ] Package current server source, matching web build, deployment files and signed release metadata without credentials.
- [x] Provide initial Ubuntu installer that snapshots actual configuration and retains account/moderation data with rollback.
- [x] Add explicit VPS Linux archive/index routes and management-center download entries, preserving existing Windows pilot publication.
- [x] Distribution spec, quality and whole-integration reviews approved tree 633d6cb9e49b09efe07b634c51d9d7543dd26aa3. Final Python checks: 18 passed, 1 POSIX skip locally; both new Linux regressions passed, actual Dockerfile/preflight passed with network disabled and zero CLI calls. Fixed extracted directory permissions and safe retry after settled upgrades. New immutable pilot identities: desktop Build 4, server Build 1.
- [ ] Test in isolated Linux containers without provider credentials or provider network calls, then build and publish the new desktop/server pilot releases.
- [ ] Verify public HTTPS index, signatures, artifact hashes, management page and rollback evidence.

### Task 4: Final verification and delivery

- [ ] Run required full regression and independent whole-change review; fix material findings.
- [ ] Record immutable source/release identities, production backup and verification results.
- [ ] State clearly which releases are live and which Ubuntu bootstrap actions still require the user's console.
