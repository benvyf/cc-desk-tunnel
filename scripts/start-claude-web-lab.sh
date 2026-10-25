#!/usr/bin/env bash
# Run as the ordinary Ubuntu administrator after extracting the dedicated lab archive.
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
lab_root=$PWD
lab_network=cc-browser-lab-net
lab_frame=cc-browser-lab-frame
lab_service=cc-browser-lab-service
[ "$(hostname -s)" = ubuntu-cc ] || { echo 'Expected ubuntu-cc'; exit 1; }
[ "$(id -u)" = 1000 ] || { echo 'Run as the ordinary uid 1000 administrator, not with sudo bash.'; exit 1; }
[ "$(uname -m)" = x86_64 ] || exit 1
for lab_file in scripts/claude-web-lab.ts apps/server/src/server.ts apps/desktop/test/fixtures/offline-rfb.ts; do
  [ -f "$lab_file" ] || { echo 'Incomplete lab archive'; exit 1; }
done
command -v openssl >/dev/null
command -v curl >/dev/null
sudo -v
for lab_name in "$lab_frame" "$lab_service"; do
  if sudo docker container inspect "$lab_name" >/dev/null 2>&1; then
    echo "Lab container already exists: $lab_name; stop and inspect it first."
    exit 1
  fi
done
if sudo docker network inspect "$lab_network" >/dev/null 2>&1; then
  echo 'Lab network already exists; do not reuse an unknown network.'; exit 1
fi
if ss -H -lnt '( sport = :18789 )' | read -r _; then
  echo 'Port 18789 is occupied'; exit 1
fi
[ "$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)" -ge 614400 ] || { echo 'Need 600 MiB available RAM'; exit 1; }
[ "$(df -Pk "$lab_root" | awk 'NR==2 {print $4}')" -ge 524288 ] || { echo 'Need 512 MiB free disk'; exit 1; }
# Read only the immutable image ID, never the existing container's settings or data.
lab_image=$(sudo docker container inspect --format '{{.Image}}' cc-desk-tunnel-ba938975-proxy-1)
[[ "$lab_image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
mkdir -p "$lab_root/.local"
lab_state=$(mktemp -d "$lab_root/.local/browser-lab-state-XXXXXXXX")
openssl rand -hex 32 > "$lab_state/token"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=cc-browser-lab.invalid' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
  -keyout "$lab_state/key.pem" -out "$lab_state/cert.pem" >/dev/null 2>&1
lab_frame_id=''
lab_service_id=''
lab_network_id=''
lab_success=0
cleanup_lab() {
  if [ "$lab_success" = 0 ]; then
    [ -z "$lab_service_id" ] || sudo docker rm -f "$lab_service_id" >/dev/null 2>&1 || true
    [ -z "$lab_frame_id" ] || sudo docker rm -f "$lab_frame_id" >/dev/null 2>&1 || true
    [ -z "$lab_network_id" ] || sudo docker network rm "$lab_network_id" >/dev/null 2>&1 || true
    echo 'Lab startup failed; production CC and browser were not changed.'
  fi
}
trap cleanup_lab EXIT
lab_network_id=$(sudo docker network create --internal --label cc.synthetic-browser-lab=1 "$lab_network")
[ "$(sudo docker network inspect --format '{{.Internal}}' "$lab_network_id")" = true ] || exit 1
lab_common=(--detach --rm --pull=never --init --network "$lab_network" --label cc.synthetic-browser-lab=1
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --read-only
  --pids-limit 96 --cpus 0.5 --no-healthcheck --env NODE_OPTIONS= --env HOME=/tmp
  --tmpfs /tmp:rw,noexec,nosuid,size=96m,mode=1777 --log-opt max-size=1m --log-opt max-file=1
  --entrypoint /opt/runtime/node/bin/node
  --mount "type=bind,src=$lab_root/apps/server/src,dst=/app/apps/server/src,readonly"
  --mount "type=bind,src=$lab_root/packages/protocol/src,dst=/app/packages/protocol/src,readonly"
  --mount "type=bind,src=$lab_root/packages/managed-server/src,dst=/app/packages/managed-server/src,readonly"
  --mount "type=bind,src=$lab_root/scripts/claude-web-lab.ts,dst=/app/scripts/claude-web-lab.ts,readonly"
  --mount "type=bind,src=$lab_root/apps/desktop/test/fixtures/offline-rfb.ts,dst=/app/apps/desktop/test/fixtures/offline-rfb.ts,readonly")
lab_frame_id=$(sudo docker run "${lab_common[@]}" --name "$lab_frame" --network-alias cc-claude-web \
  --memory 128m --memory-swap 128m "$lab_image" /app/scripts/claude-web-lab.ts fixture)
lab_service_id=$(sudo docker run "${lab_common[@]}" --name "$lab_service" --memory 384m --memory-swap 512m \
  --publish 127.0.0.1:18789:8787 \
  --mount "type=bind,src=$lab_state,dst=/run/cc-browser-lab,readonly" \
  "$lab_image" /app/scripts/claude-web-lab.ts service)
lab_ready=0
for lab_attempt in {1..15}; do
  if curl -fsS --cacert "$lab_state/cert.pem" --connect-timeout 1 --max-time 2 \
    https://127.0.0.1:18789/health -o /dev/null 2>/dev/null; then
    lab_ready=1; break
  fi
  sleep 1
done
if [ "$lab_ready" != 1 ]; then
  echo 'No TLS readiness response. Lab-only logs:'
  sudo docker logs --tail 12 "$lab_service_id" 2>&1 || true
  sudo docker logs --tail 12 "$lab_frame_id" 2>&1 || true
  exit 1
fi
# Probe only the lab fixture's RFB greeting from inside its isolated network.
sudo docker exec "$lab_service_id" /opt/runtime/node/bin/node --input-type=module -e '
import { WebSocket } from "/app/node_modules/ws/wrapper.mjs";
const ws = new WebSocket("ws://cc-claude-web:6080/");
const timer = setTimeout(() => { ws.terminate(); process.exitCode = 1; }, 5000);
ws.on("error", () => { clearTimeout(timer); process.exitCode = 1; });
ws.once("message", data => {
  clearTimeout(timer);
  if (data.toString() !== "RFB 003.008\n") process.exitCode = 1;
  else console.log("SYNTHETIC_RFB_DNS_AND_GREETING_OK");
  ws.terminate();
});'
{
  echo 'Synthetic lab only. Keep credential private; do not paste it into chat.'
  echo 'Service address via Windows SSH: wss://127.0.0.1:18789/ws'
  printf 'Service credential: '; cat "$lab_state/token"
  openssl x509 -in "$lab_state/cert.pem" -noout -fingerprint -sha256
} > "$lab_state/client-connection.txt"
lab_success=1
echo 'LAB_READY: synthetic pixels only; no Claude browser or production data mounted.'
echo "Connection settings (private): $lab_state/client-connection.txt"
echo 'Both test processes expire in 45 minutes; their Docker network remains until removed.'
sudo docker stats --no-stream --format '{{.Name}} | {{.MemUsage}} | CPU={{.CPUPerc}}' "$lab_frame_id" "$lab_service_id"
