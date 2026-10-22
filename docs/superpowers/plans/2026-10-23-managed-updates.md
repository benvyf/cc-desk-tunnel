# Managed Updates Implementation Plan

> Execute inline using executing-plans. The user has authorized implementation; no production deployment is included.

**Goal:** prevent upstream releases from prompting, downloading or replacing the custom client/server.

**Architecture:** disable online updates at server configuration, WebSocket, Electron IPC and UI boundaries. Docker runs only the fixed image program; future custom Releases are a separate change.

**Tech Stack:** Node 24, TypeScript, React, Electron, Node test runner, Playwright, Bash.

## Tasks

- [x] Install locked dependencies using Node 24 and run existing config/server/release/upgrade tests as baseline.
- [x] Add config regression: native environment with absent, official or custom PROXY_RELEASE_REPO never enables updates. Run `node --test apps/server/test/config.test.ts` and confirm failure, then remove update configuration.
- [x] Add server regression: authenticated `service.update.check` and `service.update.install` return `updates_unavailable`; legacy update options cannot trigger network, ready/update announcements or install. Existing cached installers are not offered. Run relevant server tests red, then remove updater startup and announcements and disable installer endpoint.
- [x] Add desktop regression: default `downloadRelease` rejects before fetch; Electron `service:upgrade`, `update:install`, `release:notes` all reject. Use a small CommonJS policy helper copied by current packaging and tested by Node; retain explicit local fixture download overrides for transport tests. Change fallback release URL to user repository.
- [x] Gate renderer updates and mismatch actions with a constant managed policy; add Playwright regression using forged update/installer announcements. Replace mismatch guidance with administrator installation guidance and point project links to user repository.
- [x] Add Docker entrypoint regression using an isolated temporary script fixture and mocked commands, then remove data-directory program selection so existing `current` cannot override the image.
- [x] Document fixed-commit deployment and retained protocol 20 compatibility requirement. Update release links and CI branch checks.
- [x] Run affected regression suites, project checks, typecheck, format checks, unit tests and frontend build. Review final diff and record platform limitations. Commit on `codex/managed-updates`; do not deploy or publish releases.

## Checks

Run commands with bundled Node v24.19.0 first in PATH. `npm ci` retains lockfile and skips Electron binary download during unit setup. Test network only targets loopback fixtures and never models or production.

The desktop policy must reject IPC before creating temporary directories, fetching, opening service connections or running installers. The server must refuse install even when a peer knows the legacy command schema. Stored update files stay intact but are not executed or advertised. UI hiding alone is insufficient.

## Completion evidence

See [verification record](2026-10-23-managed-updates-verification.md) for test results, the initial intermittent tunnel failure, and untested platform boundaries. The final local commit preserves this implementation without deployment or release publication.
