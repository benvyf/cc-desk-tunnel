# Browser DNS Isolation Repair

> Execute inline with systematic-debugging and test-driven-development; request independent read-only review before accepting the repair.

**Goal:** Block the confirmed local Chromium DNS escape paths while preserving remote-proxied website traffic, Coding and managed updates.

**Architecture:** Before website Chromium starts, deny its hostname resolution with host-resolver-rules, retaining only the numeric IPv4 loopback required for local authenticated proxies and IPC. Website CONNECT hostnames continue to be resolved by the existing Ubuntu proxy. Unsupported direct DNS attempts fail instead of falling back. Keep Node service connections separate. Managed update GETs use a windowless, isolated Electron helper with the original Chromium system-proxy/CA stack. GET mode accepts only the embedded update origin in packaged builds, no website profile, no cookies, no listening socket and no automatic redirects. A separate proxy-only invocation evaluates system PAC for main-process CC service connections without making a target request; this preserves PAC dnsResolve despite the website DNS guard. Inherited IPC transfers one bounded response chunk per pull and cancellation terminates the helper. No website JavaScript patching, TLS interception, new public listener, remote configuration or Claude request.

This is a repair within the already approved local-browser design and the user's instruction to fix DNS leakage. Continue on codex/claude-web in the current checkout.

## Steps

- [x] Add a native-main regression that rejects nonce DNS transactions after RTC and prefetch; run against the unfixed implementation and retain the failure.
- [x] Add the startup resolver boundary; rerun the real native entrypoint and inspect NetLog, including failed-route behavior.
- [x] Test the dedicated update transport: strict origin, TLS rejection before HTTP, streaming GET, redirects not followed, Range/cancellation, PAC dnsResolve, HTTP CONNECT and SOCKS5.
- [x] Implement the update helper and wire only managed updates to it. Keep native website requests out of this adapter.
- [x] Reproduce the main-process system PAC DNS regression and isolate service proxy evaluation as a no-target-request helper mode; verify HTTPS/WSS resolution and zero site requests.
- [x] Run native, browser, Coding/system-proxy and managed-update regressions; typecheck, build, format and stage-bundle checks appropriate to the changed files.
- [x] Independently review implementation and evidence; fix important findings.
- [x] Repeat local OS capture with the administrator helper. DNS positive control is visible in both packets and ETW; independent UDP marker was absent and interface drops remain. Record those limits explicitly; no universal zero-leakage claim.
- [x] Update the validation report and commit the concrete repair. Retain real Claude/Ubuntu production integration as a separate acceptance stage.

## Acceptance details

The regression must fail on the confirmed baseline and pass with the actual product main.cjs, without Playwright-only flags. A Chromium switch string alone is not acceptance evidence. Local resolution failures must not prevent proxied HTTPS, WSS, workers or downloads. Managed update tests must validate real TLS and cancellation, not merely mock a fetch response. No root certificate is installed into the system. Exact test host/certificate trust is confined to an isolated Electron test fixture and never added to production.

If the startup boundary affects system PAC evaluation or other existing main-process networking, investigate and test the actual interaction before claiming compatibility. Keep login/account handling and unrelated features outside this repair.
