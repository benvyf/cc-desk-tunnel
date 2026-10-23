# Managed Server Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish the current combined custom server and let a mismatched desktop explicitly upgrade a compatible managed server.

**Architecture:** Merge both custom branches first. Use an authenticated management HTTP API independent of business protocol and a signed fixed-origin program distribution, supervised inside the existing container. Preserve immutable runtime and review policy; reject dependency changes.

**Tech Stack:** Node 24, TypeScript, Electron, Python bootstrap, Linux Docker, Ed25519, existing VPS update service.

### Task 0: Integrate the updated GitHub branch

- [ ] Merge origin/codex/vps-update-channel (9f783b2) into current dedicated codex/account-monitor-production branch.
- [ ] Resolve server/config conflicts keeping passive monitor hooks and the latest native terminal policy/deployment validation.
- [ ] Keep all existing navigation, monitor enrollment and Build 3 download behavior; combine new test coverage and renewal deployment assets.
- [ ] Run Node 24 tests and TypeScript checks; independently review spec compliance and code quality, then commit the integration.

### Task 1: Signed server contract and supervised upgrade

- [ ] Add strict separate Linux server manifest contract and fixed trusted identity without weakening the Windows contract.
- [ ] Add authenticated management check/install/status endpoints with idle and maintenance guards independent of protocol mismatch.
- [ ] Add staged verification, dependency compatibility, backup, restart health check and rollback supervisor with crash recovery.
- [ ] Write failure-first tests for authentication, busy state, hash/signature tampering, traversal, failed health and preservation of new data.
- [ ] Review and commit after focused tests.

### Task 2: Desktop mismatch upgrade flow

- [ ] Add dedicated main-process check/install/status IPC with fixed paths and certificate-before-token behavior.
- [ ] Show “升级配套服务端” for protocol mismatch, confirm exact target, show progress/result, and offer bootstrap instructions for old unsupported servers.
- [ ] Keep legacy update IPC blocked; test same-version protocol mismatch and failed upgrades.
- [ ] Review and commit after focused tests and frontend build.

### Task 3: Full packaging, first bootstrap and VPS distribution

- [ ] Package current server source, matching web build, deployment files and signed release metadata without credentials.
- [ ] Provide initial Ubuntu installer that snapshots actual configuration and retains account/moderation data with rollback.
- [ ] Add explicit VPS Linux archive/index routes and management-center download entries, preserving existing Windows pilot publication.
- [ ] Test in isolated Linux containers without provider credentials or provider network calls, then build and publish the new desktop/server pilot releases.
- [ ] Verify public HTTPS index, signatures, artifact hashes, management page and rollback evidence.

### Task 4: Final verification and delivery

- [ ] Run required full regression and independent whole-change review; fix material findings.
- [ ] Record immutable source/release identities, production backup and verification results.
- [ ] State clearly which releases are live and which Ubuntu bootstrap actions still require the user's console.
