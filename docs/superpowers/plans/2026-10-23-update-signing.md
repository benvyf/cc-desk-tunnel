# Update signing implementation plan

> **For agentic workers:** Use executing-plans to implement the following tasks in this session. The signed VPS channel design is already approved; no deployment is part of this delivery.

**Goal:** Implement delivery A: a shared signed-index contract and an offline administrator signing CLI.

**Architecture:** A Node-only TypeScript module owns strict wire validation, Ed25519 signing/verification and pure revision/build decisions. A separate CLI streams artifact hashing and checks the specified clean source checkout before producing a new index with exclusive file creation. Neither is wired into Electron, the server or VPS.

**Tech Stack:** Node 24, node:crypto, node:test, TypeScript; no new dependencies.

## Task 1 — Signed contract

- Create `packages/managed-updates/src/index.ts` with `validatePayload`, `signIndex`, `verifyIndex`, `selectUpdate` and `artifactPath`.
- Create `apps/desktop/test-main/update-contract.test.mjs` using runtime-generated Ed25519 keys, explicit test time and independently signed malformed payloads.
- [x] Write tests for the documented signature bytes, tampering, schema/encoding/size/time limits, immutable revision, build monotonicity, empty withdrawal and protocol mismatch.
- [x] Run `node --test apps/desktop/test-main/update-contract.test.mjs` and confirm the missing-module failure; implement the module and rerun until passing.
- Verification example: `selectUpdate(verifyIndex(bytes, keys, now), identity, previous)` must return an available same-version/higher-build release; changing any signed byte must throw.

## Task 2 — Offline publishing tool

- Create `scripts/sign-managed-update.mjs`; input is an unsigned payload JSON with `release.size` and `release.sha256` omitted. Required arguments: `--input`, `--key-id`, `--private-key`, `--out`; published state also requires `--source` and `--artifact`.
- Create `apps/desktop/test-main/update-publisher.test.mjs` with subprocess tests and temporary Git repositories/keys. Fixture source includes desktop package version and protocol constant, committed using a local test identity.
- [x] Write failing tests for published/empty output, actual streamed size/hash, source identity, dirty source, private key location/type, strict arguments and no overwrite.
- [x] Run `node --test apps/desktop/test-main/update-publisher.test.mjs`; implement only the CLI required to satisfy those tests and the approved design.
- Source checks use `git rev-parse HEAD`, `git status --porcelain --untracked-files=normal`, desktop package version and `PROTOCOL_VERSION`. The source commit is an assertion checked against that tree, not proof that arbitrary input EXE was built from it; document that boundary until the packaging delivery embeds build identity.
- Key paths resolve through realpath and must be outside both the source checkout and output directory. Never copy a key, generate a production key, upload or log key contents. CLI errors use fixed messages.

## Task 3 — Documentation and verification

- Create `docs/UPDATE-SIGNING.md` with JSON examples, exact commands, continuation/revocation rules and the delivery boundary. Link it from `docs/MANAGED-UPDATES.md`.
- [x] Run focused tests, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`; format only changed code files.
- [x] Request independent code review per requesting-code-review; resolve material findings and run affected checks again.
- [x] Stage only intended files, run `npm run check` (checks Git index) and `git diff --cached --check`; record results in this plan and make a local commit. Do not push or deploy as part of this request.

## Verification record — 2026-10-23

- Node v24.19.0. Red phase: contract import failed because the module did not exist; CLI published/empty integration tests failed because the script did not exist. Both passed after implementation.
- Full suite: 330 tests, 300 passed, 30 platform/environment skips, zero failures, 72.2 seconds. This run included the initial 11 new tests and existing retired-update regressions.
- After review, added two focused test groups for raw signed bytes/invalid UTF-8 and output directory alias/file size limits, plus explicit source-version, tracked/staged dirty-tree and keyId substitution coverage. Final focused run: 13 passed, zero failures. No production implementation changed after the full suite.
- TypeScript, full Prettier check and frontend build passed. Build retains the existing >500 kB chunk-size advisory.
- Git-index check passed for 265 files (secrets, ignored private paths, JSON, workspace manifests and documentation links); `git diff --cached --check` passed.
- Independent reviewer `/root/review_managed_updates`: no P1/P2 findings. Clarified observed-candidate versus installed-build semantics in the approved design to preserve retry behavior; no new feature scope added.
- No private key fixtures or signed indexes tracked. Tests generated only ephemeral keys in OS temp directories and removed them. No network publishing, production keys, VPS changes, client installation or online-update activation.
