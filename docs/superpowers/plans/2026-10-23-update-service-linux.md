# Update service Linux acceptance plan

> **For agentic workers:** Use executing-plans inline. This executes the existing update-channel design's Linux acceptance gate.

**Goal:** Verify delivery B's committed runtime archive on the existing VPS without publishing a production update or changing its sites.

**Architecture:** Extract the immutable `50d8e8e` archive and a checksum-verified official Node 24 runtime into a dedicated temporary directory. Run the acceptance harness as a temporary systemd DynamicUser with a private network, readonly sources/runtime and a single writable scratch directory. Start separate loopback Node and Nginx processes inside that namespace with a temporary trusted TLS certificate and signing identity.

**Tech Stack:** Node 24 built-ins, installed Nginx/OpenSSL/systemd, SSH with existing host-key verification.

## 1. Push and read-only preflight

- [x] Push `50d8e8e` to `codex/vps-update-channel` and confirm the remote accepted it.
- [x] Verify existing SSH host key, Linux architecture, disk, installed tools, occupied listeners, Nginx validity and existing gateway health.
- [x] Confirm private network namespace support. Obtain the official Node 24.19.0 linux-x64 SHA256 over verified HTTPS.
- [x] Save a redacted before snapshot (configuration hashes, container identities/start times, service PID, listening addresses and health) to local ignored evidence.

## 2. Isolated integration harness

Create `scripts/verify-update-service-linux.mjs`. It takes the extracted archive directory and a dedicated writable scratch directory, refuses root/non-Linux execution, creates only temporary test credentials and starts only child processes belonging to this run.

- [x] Verify the archive's BUILD-INFO source hashes, standalone module manifest and deployment template. Require an empty private-network route table and deny access to existing application/configuration directories.
- [x] Use OpenSSL to create a temporary localhost certificate. Copy the actual Nginx location template, replacing only the test backend port and artifact directory; validate it with `nginx -t`.
- [x] Exercise HTTPS management page, auth/Origin rejection, valid signed candidate upload/activation, exact metadata, HEAD, full installer hash, 206 Range and 416 overflow. Confirm private/database/candidate URLs cannot be downloaded.
- [x] Exercise failed activation preserving old metadata, retry, concurrent writer exclusion, process termination/restart, signed renewal/promotion/withdrawal and persistent revision/build floors.
- [x] Verify Linux permissions and that no Authorization, token, signing key or request body appears in captured service/Nginx logs. Stop owned children and remove only the harness-created scratch subtree.

## 3. Run, compare and record

- [x] Upload the fixed archive plus harness to a new `/var/tmp/cc-update-acceptance-*` directory. Verify archive SHA256 before extraction. Download the official Node runtime, verify the preflight checksum, extract without changing system PATH or installed packages.
- [x] Run a uniquely named temporary `systemd-run --wait --pipe --collect` service with DynamicUser, PrivateNetwork, ProtectSystem=strict, ProtectHome, NoNewPrivileges, restrictive umask and only the dedicated scratch directory writable. Mask existing GhostAPI/RouteKey data and Docker socket. Set a bounded runtime.
- [x] Confirm the temporary unit and all its processes stopped. Compare the after snapshot with before: existing configurations, container identities/start times, main Nginx PID and listeners unchanged; gateways remain healthy.
- [x] Download redacted evidence, delete only the verified temporary acceptance root, and confirm cleanup. Record exact results and any remaining production gates in `docs/UPDATE-SERVICE-LINUX-ACCEPTANCE.md` and link it from `docs/UPDATE-SERVICE.md`.
- [x] Run appropriate local syntax/format/index/diff checks and commit the harness, plan and acceptance report. Do not enable production service, create production signing credentials, change DNS/TLS, or claim client integration is complete.

## Production boundary

This gate uses the real Linux kernel, systemd and Nginx with temporary localhost TLS. It does not validate the public site's certificate/routing or deploy a production service. Production configuration, offline signing-key ownership, administrator token storage and the Windows client bootstrap remain separate work after this acceptance result.

## Execution result

The immutable 50d8e8e runtime passed the Linux acceptance harness in the temporary DynamicUser/private-network unit (exit 0). Before/after production snapshots matched, both existing gateway health endpoints remained 200/ok, the transient unit and child processes were gone, and the exact temporary root was removed after evidence retrieval. See docs/UPDATE-SERVICE-LINUX-ACCEPTANCE.md for tested behavior, hashes and limits. No production service or client upgrade was enabled.
