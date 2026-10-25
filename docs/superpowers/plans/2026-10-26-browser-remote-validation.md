# Browser Remote Validation Plan

> **For agentic workers:** Execute inline with review checkpoints. Use executing-plans for implementation and requesting-code-review before remote configuration changes.

**Goal:** Verify that the isolated local browser reaches an owned HTTPS site through Ubuntu and fails closed when that route fails, without contacting Claude.

**Architecture:** Local authenticated CONNECT proxy → certificate-pinned WSS lab service → Ubuntu public target. A temporary SSH reverse forward exposes the lab only on VPS loopback; local SSH reaches that loopback. The existing public 8443 service remains on its current destination.

**Tech Stack:** Existing Node 24 image, current proxy/view modules, OpenSSH, Electron, owned HTTPS site, tcpdump.

## Checkpoint 1: Restricted test tunnel

- [x] Record Ubuntu resource/runtime/port preflight and receive a dedicated public key. Keep its private key exclusively on Ubuntu.
- [x] Prepare a dedicated `cc-egress-lab` SSH account. Restrict it to remote TCP forwarding on `127.0.0.1:38789`, no local forwarding, shell, subsystem, agent, X11, TUN, Unix socket forwarding, password or interactive authentication. Authorize only the received key for 48 hours according to VPS UTC.
- [x] Validate a staged sshd configuration, compare effective configurations for every existing Unix account, and request independent review before applying. Back up the exact original configuration; append a single lab include at the end rather than inserting a Match block into a global include directory. Validate again before reload; use reload rather than restart.
- [x] Verify the installed restrictions, existing 8443/28787–28792 listeners and new root SSH access. Prepare rollback which refuses to overwrite concurrent sshd configuration changes.
- [x] Give the administrator an Ubuntu command using the pinned VPS host key, `BatchMode=yes`, `IdentitiesOnly=yes`, `ExitOnForwardFailure=yes`, keepalives and a 45-minute foreground timeout. It forwards `127.0.0.1:38789` to Ubuntu `127.0.0.1:18789`; it never opens a new public listening port.
- [x] After user connects, inspect the listener and perform a synthetic loopback readiness probe. This checkpoint proves only the tunnel, not browser egress.

The VPS policy constrains the listen address, not the client-side `-R` destination or lifetime; those depend on the trusted administrator command. Effective policy checks, actual public-key authentication, loopback listener creation and fixed-nonce data round-trip have passed. Denied forwarding/session attempts remain pending.

## Checkpoint 2: Isolated lab service and owned site

- [x] Package the current restricted proxy with an independent generated token and WSS certificate. Use exact existing image identity with `--pull=never`, a Node entrypoint, no production mounts, read-only root, dropped capabilities, resource caps and bounded lifetime. Bind only Ubuntu `127.0.0.1:18789`.
- [x] Test launcher validation and cleanup before distribution. Review the complete launch command and package contents. No production policy or native CLI entrypoint is used.
- [x] Stage a random owned HTTPS test prefix on `api.ghostapi.org`; validate nginx configuration and review rollback before reload. Keep request logs private and bounded, accept dummy content only, expose no generic proxy or filesystem routes.
- [x] Build a local harness around the actual proxy/view modules with a dedicated persistent test profile, certificate pin for lab control traffic and normal website certificate validation. Allow only the exact owned hostname on port 443, with normal remote DNS and public address validation; no injected lookup or dial overrides.

The private bundle was transferred through the verified SSH route, verified/extracted by Ubuntu, and started successfully. Actual local-to-Ubuntu checks passed for pinned TLS, valid/invalid credentials, wrong certificate pin, local proxy authentication and rejected host/IP/port targets. No website connections were requested. Image environment names are blanked, known data paths are masked, and unexpected image-declared volumes refuse startup. This does not replace the remaining owned-site/browser checks.

## Checkpoint 3: Real observations

- [x] Compare request identifiers, owned-site source records, Ubuntu connection/capture evidence and local connection evidence. Matching public IPs alone do not prove remote routing.
- [ ] Verify HTTPS, WSS, dummy upload/download, navigation, workers, certificate failure, invalid authentication and route loss. Check DNS, UDP/QUIC/WebRTC and IPv6 separately; mark unavailable cases unverified.
- [x] Verify no local target connections or automatic replays after disconnection. Reconnect through a fresh explicit action and verify cleanup.
- [x] Stop only named lab resources, remove only lab SSH authorization/configuration, validate and reload sshd, and verify existing business listeners again. Retain private diagnostic evidence locally.

Owned-site observations are recorded in `docs/claude-web-owned-site-validation-2026-10-26.md`. Completed connection/replay checks are scoped to Chromium NetLog and the finite recorded observation window. IPv6 route-probe UDP sockets appeared without UDP byte events; OS-level packet verification and full production-entrypoint coverage remain pending. The Ubuntu capture reached its packet limit during earlier functional runs and does not cover the final complete recovery run. Actual denied SSH session/forwarding attempts remain untested even though the temporary SSH access has now been removed.

## Acceptance boundary

No Claude login, messaging or automated requests occur in this plan. No installer is published. Production JEV moderation remains enforced and is not bypassed; successful owned-site transport tests do not authorize Claude Chat on a moderated production node. Account-area hiding, real login and full production-entrypoint acceptance remain separate, unverified work.
