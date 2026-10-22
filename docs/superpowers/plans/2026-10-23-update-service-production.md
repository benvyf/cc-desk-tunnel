# Update service production deployment plan

> **For agentic workers:** Use executing-plans inline. The user authorized the next production-service/signing-identity step after Linux acceptance; continue the approved update-channel architecture.

**Goal:** Deploy delivery B at the existing `api.ghostapi.org` HTTPS origin with independent signing/admin identities, empty signed channels and verified rollback.

**Architecture:** Deploy the Linux-accepted `50d8e8e` runtime unchanged to `/opt/cc-update-service`, official checksum-verified Node 24 to `/opt/cc-update-runtime`, dedicated `ccupdates` user/data/config and hardened systemd unit. Add one location include to the existing HTTPS server after backing it up. Existing gateways, containers and CC nodes remain separate.

**Tech Stack:** Existing SSH/OpenSSL/Nginx/systemd, Node 24 built-ins, Windows ACLs, existing offline signer.

## 1. Preflight and identities

- [x] Verify existing hostname/TLS/health, chosen HTTPS server routing, unused loopback port 8817, absent deployment paths/user/unit/snippet and actual Nginx worker identity (`www-data`).
- [x] Create `C:/Users/benben/.cc-update-admin` outside the source/release trees, restrict ACL to this user's SID and SYSTEM before writing secrets, refuse overwriting an existing signing identity or token.
- [x] Generate Ed25519 signing identity `managed-2026-10-23` and a separate 32-byte Base64URL admin token locally. Verify sign/verify and ACLs; keep private key/token local. Prepare public service config containing only pinned public key and token SHA256.
- [x] Record the public deployment profile at `deploy/update-service/production-public.json`, excluding private key/token/hash. Sign initial pilot/stable empty indexes, revision 1, valid for three days, using the existing offline signer.

## 2. Stage and validate before routing

- [x] Save root-only predeployment backup/snapshot, including original Nginx site bytes, configuration hashes, listeners, main Nginx PID, container identities/start times/health and gateway health. Refuse if site hash differs from preflight.
- [x] Upload accepted archive/public config, verify archive SHA256 and BUILD-INFO hashes, download official Node 24.19.0, verify official SHA256, and install only in new dedicated directories. No system package changes.
- [x] Create no-login `ccupdates` user and data root; config root:ccupdates 0640. Install the accepted unit plus explicit InaccessiblePaths for existing apps/configuration/certificates and Docker socket. Validate unit before startup.
- [x] Start the new loopback-only service and verify local page/API auth. Prove its real UID cannot read existing app config or Docker socket. Prove actual www-data can read a public probe, cannot modify public data or read private/config files.

## 3. Activate routing and verify

- [x] Install location snippet from accepted template; atomically add exactly one include in the chosen TLS server. Run `nginx -t` before reload. On failure restore original site, remove snippet and stop only the new service. Preserve backup and evidence.
- [x] Verify public certificate, page/assets/security headers, authenticated API, rejected no-token/wrong-Origin requests and private URL isolation. Publish signed empty pilot/stable revision 1; no installer release is activated.
- [x] Use an unsigned, non-executable temporary transport probe at a unique unused static path to verify actual public HTTPS GET/HEAD/206/416 with www-data. Never reference it from a channel; remove its exact directory immediately and verify 404 afterward.
- [x] Verify enabled service, loopback listener, graceful restart persistence, fixed public keys, no credential/request-body leakage in relevant logs, and unchanged gateway health/container identities/start times. Nginx master PID should remain unchanged after graceful reload.
- [x] Store redacted evidence and production instructions at `docs/UPDATE-SERVICE-PRODUCTION.md`. Record exact backup and credential file paths without contents. Empty channels can expire until a real release is signed; clients remain unchanged.

## 4. Commit and handoff

- [x] Run public-profile JSON parsing, formatting, staged secret/link checks and diff checks. Obtain independent review of public deployment records and rollback boundaries.
- [x] Commit and push public configuration and deployment documentation to the current custom branch. Keep actual credentials/configuration hashes/logs in protected local files or ignored evidence, never tracked.
- [x] Report the working admin URL, local token location and outstanding Windows-client bootstrap. No CC server update, protocol migration or model/content-audit integration is part of this step.

## Execution record

- Production delivery B is active/enabled at https://api.ghostapi.org/cc-updates/admin/, loopback Node 8817 behind the existing HTTPS server. Runtime remains the Linux-accepted 50d8e8e archive.
- Production signing key and separate admin token were created only in the ACL-restricted local administrator directory. Public profile is tracked; no private key, token or token hash is tracked.
- Both signed channels are empty revision 1. First actual installer remains build 1 with channel revision at least 2. No reserved builds, candidates or public artifacts remain.
- Public TLS/API/auth/Origin/private-path tests, real Edge login/logout, actual Nginx www-data read-only access, public GET/HEAD/206/416, service stop/consistent backup/start and metadata persistence passed. Temporary deployment and transport files were removed.
- Existing container identities/start times and Nginx master PID remained unchanged; only the planned include/snippet and loopback listener changed. Existing gateway/site health remained 200/ok.
- Backup and rollback byte/hash checks passed; no live rollback or VPS reboot was performed. Independent public-profile/document/evidence review found no P1/P2 blockers.
- Staged secret/link/JSON checks (289 tracked files), repository formatting and diff checks passed. Source changes are public deployment records only; no runtime code was changed in this step.
