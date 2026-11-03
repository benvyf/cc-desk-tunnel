# Resilient Host Updates Implementation Plan

> Execute inline using executing-plans; request an independent code review before completion.

**Goal:** Implement the approved staged upgrade flow while preserving tasks, data and rollback resources.

**Architecture:** Keep the existing signed host channel and both existing upgrade transactions. Add capacity and idle checks around base-image preparation, an explicitly host-authorized ordinary-update route that stages before maintenance, and actionable phase output. Existing nodes adopt the packaged updater through their enrollment installer.

**Tech Stack:** Python 3.12+, Node 24, TypeScript, Docker Engine, existing SQLite journals.

## Baseline

- [x] Recover production files from `/opt/cc-update-service` and verify every BUILD-INFO SHA256 before importing.
- [x] Isolate development on `codex/resilient-host-updates` at `.local/resilient-host-updates`.
- [x] Run managed HTTP, admission, supervisor and upgrade-command baseline tests with the bundled Node 24 runtime.

## Task 1: Capacity and safe base migration

Files: `scripts/install-cc-space-037.py`, `scripts/upgrade-runtime-base.py`, `scripts/test_resilient_runtime_upgrade.py`.

- [x] Write failing tests for separate backup/recovery filesystems, exact insufficient-byte reporting, early busy refusal, post-build prune and final pre-stop capacity recheck.
- [x] Run `python -m unittest discover -s scripts -p test_resilient_runtime_upgrade.py -v` and confirm the missing behavior fails.
- [x] Implement self-contained space/idle checks in the legacy cutover script so generated offline rollback remains independent. Base migration cleans only builder caches before and after preparing the candidate, verifies the candidate before pruning and checks space again before pause/stop.
- [x] Test old-service preservation, candidate reuse, cache-cleanup failure, backup failure, and unchanged rollback behavior. Run existing terminal/message Python tests on Linux for fcntl and root filesystem coverage.

## Task 2: Host-only ordinary-update admission

Files: `apps/server/src/{managed-server-http,managed-server-child,managed-server-supervisor,managed-server-main,server}.ts`, server tests.

- [x] Write failing HTTP and real-WebSocket tests: idle peers can be disconnected only by full service-token localhost host maintenance; desktop tickets and nonlocal requests cannot invoke it; existing strict install stays strict.
- [x] Stage the release before entering maintenance; synchronously block admission and recheck tasks/terminals/persistent active runs before closing idle sockets. Preparation failure leaves sockets alive. Busy-after-staging cancels the prepared handoff immediately.
- [x] Add cancellation to the supervisor IPC contract; verify owner checks and handoff lease behavior. Add ordinary backup/recovery capacity checks before staging completion and before stopping the child.
- [x] Run Node 24 managed server HTTP/admission/supervisor and process tests.

## Task 3: Host orchestration and bounded download retries

Files: `apps/update-service/web/{host-updater-agent.py,server-upgrade.cjs}`, Python/Node updater tests, base migration.

- [x] Write failing tests for host-only command selection, three-attempt transient download retry, nonretryable signature/digest failure, interrupted-job reconciliation, and exact target verification.
- [x] Add host mode to the existing command without changing the strict manual command default. Never retry install/cutover. Reconcile interrupted jobs only when the persisted target identity and actual committed identity match.
- [x] Keep exact Build/protocol/hash verification and explicit old-service/restoration log output.
- [x] Run focused Python tests and actual HTTP command tests; verify no repeated install requests.

## Task 4: Packaging, center copy and adoption

Files: `scripts/package-update-service.mjs`, `apps/update-service/src/host-updater-package.ts`, updater installer, `web/{node-updates.js,index.html,server-download.js}`, documentation and tests.

- [x] Include all recovered host-channel files in the packaging manifest; keep embedded helper hashes consistent.
- [x] Test generated installer contents and replacement/rejection paths. Preserve existing enrollment credential behavior; do not add root remote-command or self-update features.
- [x] Update progress and confirmation text to describe automatic idle disconnection and task/terminal requirements. Document one-time re-enrollment for existing nodes, legacy-server capability limits, actual rollback evidence, and supported-node scope.
- [x] Run package/runtime inventory, update-service HTTP/UI and host enrollment tests, formatting and TypeScript checks.

## Task 5: Review and delivery

- [x] Request independent review of the final diff against the approved spec; fix material findings and rerun affected checks.
- [ ] Commit the tested code and produce the update-service archive from the clean checkout, verifying its manifest and installer.
- [x] Prepare reviewable deployment/adoption artifacts and explicit status. Keep node business upgrades user-confirmed and do not upgrade other machines.
- [x] Report implementation, checks, and any remaining live rollout requirement accurately.
