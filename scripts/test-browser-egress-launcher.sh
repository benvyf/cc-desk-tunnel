#!/usr/bin/env bash
# Safety boundaries: exported shell fakes; no real sudo, Docker or network operations.
set -euo pipefail
test_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d "$test_root/.local/egress-shell-XXXXXXXX")
export test_root test_dir
hostname() { echo ubuntu-cc; }
id() { echo 1000; }
uname() { echo x86_64; }
ss() { if [ "$test_case" = occupied ]; then echo LISTEN; fi; }
sudo() {
  if [ "${1:-}" = -v ]; then return; fi
  if [ "${1:-}" = -n ]; then shift; fi
  "$@"
}
docker() {
  printf '%s\n' "$*" >> "$test_dir/$test_case.commands"
  case "$1:$2" in
    image:inspect)
      if [[ "$*" = *'Config.Env'* ]]; then
        printf '%s\n' PATH NODE_OPTIONS HOME CC_TOKEN MONITOR_KEY
      elif [[ "$*" = *'Config.Volumes'* ]]; then
        if [ "$test_case" = badvolume ]; then echo /unexpected; else echo /data; fi
      else echo sha256:365918cb8abf4f4b784502a6bbabeda5704dc928e5c899438199776001b1adb2; fi ;;
    container:inspect) [ "$test_case" = exists ] ;;
    network:inspect) return 1 ;;
    network:create) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    network:rm) [ "$3" = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ] ;;
    run:*)
      [[ "$*" = *'--pull=never'* && "$*" = *'--read-only'* && "$*" = *'--cap-drop ALL'* ]]
      [[ "$*" = *'--user 1000:1000'* && "$*" = *'--publish 127.0.0.1:18789:8787'* ]]
      [[ "$*" = *'--env CC_TOKEN='* && "$*" = *'--env MONITOR_KEY='* && "$*" = *'--workdir /tmp'* ]]
      [[ "$*" = *'--tmpfs /data:rw,noexec,nosuid,size=1m,mode=000'* && "$*" = *'--tmpfs /etc/claude-code:rw,noexec,nosuid,size=1m,mode=000'* ]]
      [[ "$*" != *'src=/data'* && "$*" != *'src=/etc/claude-code'* && "$*" != *'docker.sock'* ]]
      while [ "$#" -gt 0 ]; do
        if [ "$1" = --cidfile ]; then
          shift; printf '%064d\n' 1 > "$1"
        fi
        shift
      done
      [ "$test_case" != runfailed ]
      ;;
    rm:-f) [ "$3" = 0000000000000000000000000000000000000000000000000000000000000001 ] ;;
    *) echo "Unexpected operation: $*" >&2; return 1 ;;
  esac
}
export -f hostname id uname ss sudo docker
for test_case in ready exists occupied runfailed badvolume; do
  export test_case
  mkdir -p "$test_dir/$test_case/scripts" "$test_dir/$test_case/state" "$test_dir/$test_case/apps/server/src"
  cp "$test_root/scripts/start-browser-egress-lab.sh" "$test_dir/$test_case/scripts/"
  for file in state/token state/key.pem state/cert.pem scripts/browser-egress-lab.mjs apps/server/src/browser-proxy.ts apps/server/src/browser-proxy-target.ts apps/server/src/throttle.ts; do
    touch "$test_dir/$test_case/$file"
  done
  result=0
  bash -c 'source "$test_dir/$test_case/scripts/start-browser-egress-lab.sh"' > "$test_dir/$test_case.output" 2>&1 || result=$?
  if [ "$test_case" = ready ]; then [ "$result" = 0 ]; else [ "$result" != 0 ]; fi
  if [ "$test_case" = occupied ] || [ "$test_case" = exists ] || [ "$test_case" = badvolume ]; then
    ! grep -q '^run\|^network create\|^rm -f' "$test_dir/$test_case.commands"
  else
    grep -q '^network rm aaaaaaaaaa' "$test_dir/$test_case.commands"
    grep -q '^rm -f 0000000000' "$test_dir/$test_case.commands"
  fi
done
echo EGRESS_LAUNCHER_SAFETY_PASS
