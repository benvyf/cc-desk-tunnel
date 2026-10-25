# Isolated browser egress lab

This is an owned-site-only transport diagnostic, separate from the older noVNC/RFB experiment. It does not launch a native agent, contact Claude or read production configuration. Its sole allowed target is `api.ghostapi.org:443`; real remote DNS and public-address validation remain active. Do not browse existing API paths: prepare a dedicated owned test prefix before website requests.

Run `node --test scripts/browser-egress-lab.test.mjs` and `bash scripts/test-browser-egress-launcher.sh` before packaging. `node scripts/package-browser-egress-lab.mjs` creates a private archive under `.local/egress-private-*`. The archive contains an independent token and TLS private key: transfer it only through the verified SSH route, never through chat, public downloads or Git. The matching local `client.json` is also private. Website TLS verification remains normal; the self-signed certificate pin applies only to the isolated lab control channel.

The Ubuntu administrator receives the archive into a new private directory, verifies the separately provided SHA256, and extracts only that verified archive. Before running, apply `chmod -R go-rwx` to the extracted directory. Start as ordinary uid 1000 on `ubuntu-cc`:

```bash
bash scripts/start-browser-egress-lab.sh
```

The launcher requires the exact existing image `sha256:365918cb8abf4f4b784502a6bbabeda5704dc928e5c899438199776001b1adb2`; it never pulls or builds. It refuses occupied port/container/network names and existing cidfiles. It creates a separate bridge network and runs only the lab script via Node 24, with uid 1000, no capabilities, no-new-privileges, read-only root and mounts, 160MiB memory (192MiB including swap), 0.25 CPU, 64 PIDs, and bounded tmpfs/logs. It mounts only bundled source and independent state; no production volumes, browser profile or Docker socket.

The image may descend from a production container snapshot. The launcher reads environment **names only** and blanks every inherited entry, then sets fixed HOME/PATH/NODE_OPTIONS. It masks `/data` and `/etc/claude-code` with empty, mode000 tmpfs and explicitly works in `/tmp`. It accepts only those known declared image volume paths; unexpected image volumes stop startup. This prevents inherited environment credentials, known data paths and automatic anonymous volumes from entering this test's process or mounted data. It does not assert that every historical byte of the reused image has been audited.

Docker publishes only `127.0.0.1:18789`. The established SSH reverse tunnel exposes it only at VPS `127.0.0.1:38789`. A separate authenticated local SSH forward reaches that VPS loopback. `EGRESS_LAB_READY` means the TLS server is listening; it does not prove website egress. Check pinned TLS, authentication and rejected targets before any owned-site requests.

Keep the foreground launcher terminal open. Ctrl+C or the 45-minute service lifetime ends the lab. The EXIT trap uses noninteractive sudo to attempt removal of only the container ID read from this new run's root-owned cidfile and the network ID created by this run. If sudo authorization has expired or cleanup fails, it prints a cleanup notice; inspect the lab's exact IDs and labels before manual removal. Do not prune or remove by broad pattern. The private archive/state and cidfile remain for evidence, so restarting requires inspection and a fresh private extraction. Stopping the SSH terminal ends only the test route.

This lab does not upgrade public8443, disable JEV moderation, publish an installer or validate Claude account behavior. An owned-site result cannot establish that every browser protocol or production integration is ready. Record untested cases explicitly.
