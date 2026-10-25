#!/usr/bin/env bash
# Foreground, owned-site-only validation. Never reads or mounts production state.
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
lab_root=$PWD
lab_name=cc-egress-lab-service
lab_network=cc-egress-lab-net
lab_image=sha256:365918cb8abf4f4b784502a6bbabeda5704dc928e5c899438199776001b1adb2
[ "$(hostname -s)" = ubuntu-cc ] && [ "$(id -u)" = 1000 ] && [ "$(uname -m)" = x86_64 ] || {
  echo 'Run as ordinary uid 1000 on ubuntu-cc x86_64.' >&2; exit 1;
}
for file in state/token state/key.pem state/cert.pem scripts/browser-egress-lab.mjs apps/server/src/browser-proxy.ts apps/server/src/browser-proxy-target.ts apps/server/src/throttle.ts; do
  [ -f "$file" ] && [ ! -L "$file" ] || { echo "Missing regular lab file: $file" >&2; exit 1; }
done
[ ! -e state/container.cid ] || { echo 'Existing lab cidfile; inspect before retry.' >&2; exit 1; }
sudo -v
[ "$(sudo docker image inspect --format '{{.Id}}' "$lab_image")" = "$lab_image" ] || exit 1
# The image may descend from docker commit. Read names only, never values, and
# override every inherited environment entry before even docker-init starts.
lab_env_names=$(sudo docker image inspect --format '{{range .Config.Env}}{{println (index (split . "=") 0)}}{{end}}' "$lab_image")
lab_env=()
while IFS= read -r lab_env_name; do
  [ -z "$lab_env_name" ] && continue
  [[ "$lab_env_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo 'Unexpected image environment name.' >&2; exit 1; }
  lab_env+=(--env "$lab_env_name=")
done <<< "$lab_env_names"
lab_volumes=$(sudo docker image inspect --format '{{range $path, $_ := .Config.Volumes}}{{println $path}}{{end}}' "$lab_image")
while IFS= read -r lab_volume; do
  case "$lab_volume" in ''|/data|/etc/claude-code) ;; *) echo 'Unexpected declared image volume; refusing startup.' >&2; exit 1 ;; esac
done <<< "$lab_volumes"
if sudo docker container inspect "$lab_name" >/dev/null 2>&1; then
  echo 'Lab container name already exists; refusing reuse.' >&2; exit 1
fi
if [ -n "$(ss -H -lnt '( sport = :18789 )')" ]; then
  echo 'Port 18789 occupied; wait for the single-use probe to exit.' >&2; exit 1
fi
if sudo docker network inspect "$lab_network" >/dev/null 2>&1; then
  echo 'Lab network already exists; refusing reuse.' >&2; exit 1
fi
lab_network_id=''
cleanup() {
  if [ -f "$lab_root/state/container.cid" ]; then
    if lab_cid=$(sudo -n cat "$lab_root/state/container.cid"); then
      if [[ "$lab_cid" =~ ^[a-f0-9]{64}$ ]]; then
        sudo -n docker rm -f "$lab_cid" >/dev/null 2>&1 || echo 'LAB_CLEANUP: container absent or removal needs administrator review.' >&2
      fi
    else
      echo 'LAB_CLEANUP: cannot read root-owned cidfile; administrator cleanup needed.' >&2
    fi
  fi
  if [[ "$lab_network_id" =~ ^[a-f0-9]{64}$ ]]; then
    sudo -n docker network rm "$lab_network_id" >/dev/null 2>&1 || echo 'LAB_CLEANUP: network removal needs administrator review.' >&2
  fi
}
trap cleanup EXIT
lab_network_id=$(sudo docker network create --label cc.synthetic-egress-lab=1 "$lab_network")
[[ "$lab_network_id" =~ ^[a-f0-9]{64}$ ]] || exit 1
sudo docker run --rm --pull=never --init --name "$lab_name" \
  --cidfile "$lab_root/state/container.cid" --label cc.synthetic-egress-lab=1 \
  --network "$lab_network_id" --publish 127.0.0.1:18789:8787 \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --read-only \
  --pids-limit 64 --cpus 0.25 --memory 160m --memory-swap 192m --no-healthcheck \
  "${lab_env[@]}" --env NODE_OPTIONS= --env HOME=/tmp --env PATH=/opt/runtime/node/bin:/usr/bin:/bin --workdir /tmp \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --tmpfs /data:rw,noexec,nosuid,size=1m,mode=000 \
  --tmpfs /etc/claude-code:rw,noexec,nosuid,size=1m,mode=000 \
  --log-opt max-size=1m --log-opt max-file=1 \
  --mount "type=bind,src=$lab_root/state,dst=/run/cc-egress-lab,readonly" \
  --mount "type=bind,src=$lab_root/apps/server/src,dst=/app/apps/server/src,readonly" \
  --mount "type=bind,src=$lab_root/scripts/browser-egress-lab.mjs,dst=/app/scripts/browser-egress-lab.mjs,readonly" \
  --entrypoint /opt/runtime/node/bin/node "$lab_image" /app/scripts/browser-egress-lab.mjs
