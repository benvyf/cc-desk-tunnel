# Mature NSIS Differential Integration Plan

> Execute with subagent-driven-development and TDD. User approved the method in UPDATER-FRAMEWORK-EVALUATION.md on 2026-11-08.

**Goal:** In-app updates prefer pinned electron-updater installer reconstruction; website downloads remain complete EXEs. Keep v1 Ed25519 build selection, protocol gating, locks and NSIS installation.

**Architecture:** Domain-separated signed immutable descriptor binds complete installer SHA256/SHA512 and gzip-JSON-v2 blockmap hash/size. Independently scoped cache stores an installer/map/descriptor triple by build+hash, promoted only for the running confirmed identity. A strict Electron request adapter supplies Range, redirect, timeout and cancellation controls around GenericDifferentialDownloader6.8.10. Reconstructed partials are isolated and deleted before full fallback; complete SHA256 is rechecked by existing installation flow.

## 1. Descriptor and publication contract

Files: new electron/managed-differential-contract.cjs; new scripts/publish-managed-differential.mjs; focused contract/publication tests.

- [x] Write failing signature/binding/map-bounds tests and run them.
- [x] Implement signDescriptor, verifyDescriptor(full release), verifyBaselineDescriptor(embedded identity), decodeBlockmap and safe artifact coordinate paths. Scope current v1 unchanged; no arbitrary URL supplied by renderer.
- [x] Publisher verifies clean source, signed v1 installer tuple, public artifact bytes, key ownership and map shape; emits immutable blockmap then descriptor with exclusive/idempotent writes. Test wrong source/key, map/installer corruption, conflicts and secrecy.

## 2. Mature engine adapter

Files: new managed-differential.cjs and development engine shim; engine tests; pin desktop electron-updater6.8.10.

- [x] RED tests normal reconstruction, ignored Range, bad content ranges/bodies, stalled cancellation and no redirects.
- [x] Implement runDifferential({oldFile,newFile,newUrl,oldBlockMap,newBlockMap,size,sha512,signal,onProgress,createRequest}) and estimateDifferential using the actual library, never own copy algorithm. Track active requests and explicitly reject failures after headers. No partial can be executable/ready before validation.
- [x] Bundle only required engine into packaged CJS; verify packaged module can load without development dependencies and has pinned version.

## 3. Cache/network/controller integration

Files: new managed-differential-cache.cjs; modify managed-network.cjs, managed-controller.cjs, managed-updates.cjs; controller/cache/network tests.

- [x] RED tests first full bootstrap, confirmed cache adoption, same-appVersion/higher-Build differential, bad/missing cache fallback, cancellation no fallback, partial isolation and cleanup protection.
- [x] Add bounded descriptor/blockmap fetches, same-origin public artifact paths. Adopt ready.exe or stock NSIS installer cache only when matching signed current identity descriptor and complete hash. Pointer atomically switches to complete immutable triple; do not overwrite old files while download/install is unconfirmed.
- [x] Download prefers valid cache+descriptor. Fallback removes only differential partial then uses existing full download. Check assembled size/SHA256 before ready.exe; retain current withdrawal/protocol/activity checks and original launchInstaller.
- [x] Lazy baseline adoption before next download avoids startup network blocking. Keep last confirmed cache; replace cache only after startup identity confirmation. Unknown or unavailable metadata leaves original full updater usable.

## 4. Packaging, proof and delivery

Files: package-desktop.mjs, engine build entry, managed-update UI state only if necessary; docs and evidence; managed build34 metadata.

- [x] Run focused tests, all test-main, managed update UI, tsc, prettier and repository checks. Spec/security review and fix findings.
- [x] Build real delta-capable candidate installer; actual EXE smoke and packaged engine differential with local HTTPS. Verify complete installer target bytes and original profile isolation; no daily installation/model calls.
- [x] Record measured byte/timing limits and bootstrap behavior; commit code/docs. Existing self-written file-update candidate stays unmerged. Production publish is separate from this integration request.
