#!/usr/bin/env bash
# First-node preparation only. Never upgrades/stops the existing production service.
set -euo pipefail
umask 077
COMMIT=4a39bc35008707366949496f9219e9b68c8d0856
SOURCE=/opt/cc-desk-tunnel-pilot-4a39bc3
STATE=/var/lib/cc-desk-tunnel-pilot-4a39bc3
IMAGE=cc-desk-tunnel:pilot-4a39bc3
PROJECT=cc-pilot-4a39bc3
PRODUCTION=cc-desk-tunnel-ba938975-proxy-1
TEST_ID=''
[[ "$(id -u)" = 0 && "$(hostname -s)" = ubuntu-cc ]] || { echo 'Run with sudo on ubuntu-cc.' >&2; exit 1; }
[[ ! -e "$SOURCE" && ! -e "$STATE" ]] || { echo 'Preparation paths already exist; inspect them instead of overwriting.' >&2; exit 1; }
docker inspect "$PRODUCTION" >/dev/null
mkdir -m 700 "$STATE"
trap 'rc=$?; if [[ -n "$TEST_ID" ]]; then docker stop --time 10 "$TEST_ID" >/dev/null 2>&1 || true; fi; if ((rc)); then printf "Preparation failed; private diagnostics: %s. Production was not changed.\n" "$STATE" >&2; fi' EXIT
docker inspect "$PRODUCTION" > "$STATE/production-before.inspect.json"
BEFORE="$(docker inspect --format '{{.Id}} {{.Image}} {{.State.StartedAt}}' "$PRODUCTION")"
free -m > "$STATE/resources.txt"
df -h / /srv >> "$STATE/resources.txt"
printf '1/4 Fetching pinned source %s\n' "$COMMIT"
git clone --quiet --no-checkout https://github.com/benvyf/cc-desk-tunnel.git "$SOURCE"
git -C "$SOURCE" checkout --quiet --detach "$COMMIT"
[[ "$(git -C "$SOURCE" rev-parse HEAD)" = "$COMMIT" && -z "$(git -C "$SOURCE" status --porcelain)" ]]
printf '2/4 Building isolated image; log: %s/build.log\n' "$STATE"
docker build -t "$IMAGE" -f "$SOURCE/deploy/docker/Dockerfile" "$SOURCE" > "$STATE/build.log" 2>&1
printf '3/4 Starting fresh test data on 127.0.0.1:18787\n'
export PROXY_DEPLOY_CONFIG="$STATE/docker.env"
bash "$SOURCE/deploy/manage.sh" init --host cc-desk-tunnel.local --mode fingerprint --data "$STATE/data" --control-port 18787 > "$STATE/init.log" 2>&1
sed -i "s|^PROXY_IMAGE=.*|PROXY_IMAGE='$IMAGE'|; s|^PROJECT_NAME=.*|PROJECT_NAME='$PROJECT'|; s|^CONTROL_BIND=.*|CONTROL_BIND='127.0.0.1'|" "$PROXY_DEPLOY_CONFIG"
dc() { docker compose --env-file "$PROXY_DEPLOY_CONFIG" -p "$PROJECT" -f "$SOURCE/deploy/docker/compose.yaml" "$@"; }
dc up -d --no-build > "$STATE/start.log" 2>&1
TEST_ID="$(dc ps -q proxy)"
[[ -n "$TEST_ID" && "$TEST_ID" != "$(docker inspect --format '{{.Id}}' "$PRODUCTION")" ]]
wait_healthy() {
  for _ in {1..60}; do
    [[ "$(docker inspect --format '{{.State.Health.Status}}' "$TEST_ID")" != healthy ]] || return 0
    sleep 2
  done
  docker logs "$TEST_ID" > "$STATE/test-container.log" 2>&1
  return 1
}
wait_healthy
docker exec -i "$TEST_ID" node --env-file=/data/config/service.env --input-type=module > "$STATE/protocol-check.json" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import https from 'node:https';
const { WebSocket } = createRequire('/app/apps/server/package.json')('ws');
const ca = readFileSync('/data/tls/control.crt');
const tls = { ca, servername: 'cc-desk-tunnel.local', allowPartialTrustChain: true };
const health = await new Promise((resolve, reject) => {
  const r = https.get({ host: '127.0.0.1', port: 8787, path: '/health', ...tls }, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => {
      try { assert.equal(response.statusCode, 200); resolve(JSON.parse(body)); } catch (error) { reject(error); }
    });
  });
  r.on('error', reject);
  r.setTimeout(10000, () => r.destroy(new Error('Health timeout')));
});
assert.equal(health.protocolVersion, 20);
assert.equal(health.adapter, 'claude-code');
async function connection(version) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('wss://127.0.0.1:8787/ws', tls);
    const timer = setTimeout(() => finish(new Error('Protocol timeout')), 10000);
    const expected = new Set(['service.update.check', 'service.update.install']);
    const finish = (error, result) => { clearTimeout(timer); socket.terminate(); error ? reject(error) : resolve(result); };
    socket.on('error', error => finish(error));
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token: process.env.PROXY_TOKEN, protocolVersion: version, deviceName: 'isolated-linux-pilot' })));
    socket.on('message', bytes => {
      try {
        const m = JSON.parse(bytes);
        if (m.type === 'connection.error') {
          assert.equal(version, 19);
          assert.equal(m.code, 'version_mismatch');
          finish(null, 'version_mismatch');
        } else if (m.type === 'ready') {
          assert.equal(version, 20);
          assert.equal(m.update, undefined);
          for (const type of expected) socket.send(JSON.stringify({ type, requestId: type, ...(type.endsWith('install') ? { version: '99.0.0' } : {}) }));
        } else if (m.type === 'response' && expected.has(m.requestId)) {
          assert.equal(m.ok, false);
          assert.equal(m.code, 'updates_unavailable');
          expected.delete(m.requestId);
          if (expected.size === 0) finish(null, 'authenticated-and-legacy-updates-rejected');
        }
      } catch (error) { finish(error); }
    });
  });
}
const current = await connection(20);
const old = await connection(19);
console.log(JSON.stringify({ health, current, old, modelRequests: 0 }, null, 2));
NODE
printf '4/4 Checking recreation, persistence and ignored downloaded program\n'
docker exec "$TEST_ID" sh -c 'printf "pilot-persistence\n" > /data/workspace/.pilot-persistence'
mkdir -p "$STATE/data/program/apps/server/src" "$STATE/data/program/apps/desktop"
printf 'throw new Error("Downloaded program must never run");\n' > "$STATE/data/program/apps/server/src/main.ts"
printf '{"version":"99.0.0"}\n' > "$STATE/data/program/apps/desktop/package.json"
chown -R 1000:1000 "$STATE/data/program"
CERT_BEFORE="$(sha256sum "$STATE/data/tls/control.crt" | cut -d' ' -f1)"
CONFIG_BEFORE="$(sha256sum "$STATE/data/config/service.env" | cut -d' ' -f1)"
OLD_TEST_ID="$TEST_ID"
dc up -d --no-build --force-recreate > "$STATE/recreate.log" 2>&1
TEST_ID="$(dc ps -q proxy)"
[[ "$TEST_ID" != "$OLD_TEST_ID" ]]
wait_healthy
[[ "$(docker exec "$TEST_ID" cat /data/workspace/.pilot-persistence)" = pilot-persistence ]]
[[ "$(sha256sum "$STATE/data/tls/control.crt" | cut -d' ' -f1)" = "$CERT_BEFORE" ]]
[[ "$(sha256sum "$STATE/data/config/service.env" | cut -d' ' -f1)" = "$CONFIG_BEFORE" ]]
docker logs "$TEST_ID" > "$STATE/test-container.log" 2>&1
grep -F 'Starting program 0.3.6 from /app' "$STATE/test-container.log" >/dev/null
[[ "$(docker inspect --format '{{.Id}} {{.Image}} {{.State.StartedAt}}' "$PRODUCTION")" = "$BEFORE" ]]
docker inspect "$PRODUCTION" > "$STATE/production-after.inspect.json"
docker image inspect --format '{{.Id}}' "$IMAGE" > "$STATE/image-id.txt"
docker stop --time 10 "$TEST_ID" >/dev/null
TEST_ID=''
printf '{"sourceCommit":"%s","image":"%s","protocol":20,"protocol19Rejected":true,"legacyUpdatesRejected":true,"recreation":true,"persistentData":true,"downloadedProgramIgnored":true,"productionUnchanged":true,"modelRequests":0,"cutoverPerformed":false}\n' "$COMMIT" "$IMAGE" > "$STATE/result.json"
cat "$STATE/result.json"
printf 'PASS. Test container stopped; production is unchanged. Private evidence: %s\n' "$STATE"
