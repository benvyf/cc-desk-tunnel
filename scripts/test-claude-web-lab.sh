#!/usr/bin/env bash
# Exercise startup boundaries using shell fakes. Never invokes Docker, sudo or a network client.
set -euo pipefail
lab_test_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p "$lab_test_root/.local"
lab_test_dir=$(mktemp -d "$lab_test_root/.local/lab-shell-test-XXXXXXXX")
export lab_test_root lab_test_dir

hostname() { echo ubuntu-cc; }
id() { echo 1000; }
uname() { echo x86_64; }
sudo() { if [ "${1:-}" != -v ]; then "$@"; fi; }
ss() { return 0; }
sleep() { :; }
curl() { [ "$lab_case" != notready ]; }
awk() {
  if [[ "$1" = *MemAvailable* ]]; then echo 2097152; else command awk "$@"; fi
}
df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nfixture 99999999 0 99999999 0%% /\n'; }
openssl() {
  case "$1" in
    rand) echo local-lab-credential-sentinel ;;
    req)
      shift
      while [ "$#" -gt 0 ]; do
        if [ "$1" = -keyout ] || [ "$1" = -out ]; then
          shift; printf 'local fixture\n' > "$1"
        fi
        shift
      done ;;
    x509) echo 'sha256 Fingerprint=fixture' ;;
    *) return 1 ;;
  esac
}
docker() {
  printf '%s\n' "$*" >> "$lab_test_dir/$lab_case.commands"
  case "$1:$2" in
    container:inspect)
      if [ "${3:-}" = --format ]; then
        echo sha256:365918cb8abf0000000000000000000000000000000000000000000000000000
      elif [ "$lab_case" = exists ]; then return 0
      else return 1; fi ;;
    network:inspect)
      if [ "${3:-}" = --format ]; then
        if [ "$lab_case" = noninternal ]; then echo false; else echo true; fi
      else return 1; fi ;;
    network:create) [[ "$*" = *'--internal'* ]] || return 1; echo lab-network-id ;;
    network:rm) [ "$3" = lab-network-id ] || return 1 ;;
    run:*)
      [[ "$*" = *'--read-only'* && "$*" = *'--network cc-browser-lab-net'* && "$*" = *'--pull=never'* ]] || return 1
      [[ "$*" != *'src=/data'* && "$*" != *'/config,dst='* && "$*" != *docker.sock* ]] || return 1
      if [[ "$*" = *'--name cc-browser-lab-frame'* ]]; then echo lab-frame-id
      elif [[ "$*" = *'--publish 127.0.0.1:18789:8787'* ]]; then echo lab-service-id
      else return 1; fi ;;
    rm:-f) [[ "$3" = lab-frame-id || "$3" = lab-service-id ]] || return 1 ;;
    exec:*) echo SYNTHETIC_RFB_DNS_AND_GREETING_OK ;;
    stats:*) echo 'fixture stats' ;;
    logs:*) echo 'fixture startup failed' ;;
    *) echo 'Unexpected fake Docker operation' >&2; return 1 ;;
  esac
}
export -f hostname id uname sudo ss sleep curl awk df openssl docker
for lab_case in ready exists noninternal notready; do
  export lab_case
  lab_result=0
  bash -c 'source "$lab_test_root/scripts/start-claude-web-lab.sh"' > "$lab_test_dir/$lab_case.output" 2>&1 || lab_result=$?
  if [ "$lab_case" = ready ]; then
    [ "$lab_result" = 0 ]
    grep -q LAB_READY "$lab_test_dir/$lab_case.output"
    ! grep -q '^rm -f' "$lab_test_dir/$lab_case.commands"
  else
    [ "$lab_result" != 0 ]
    if [ "$lab_case" = exists ]; then
      ! grep -q '^network create' "$lab_test_dir/$lab_case.commands"
    else
      grep -q '^network rm lab-network-id$' "$lab_test_dir/$lab_case.commands"
    fi
    if [ "$lab_case" = notready ]; then
      grep -q '^rm -f lab-service-id$' "$lab_test_dir/$lab_case.commands"
      grep -q '^rm -f lab-frame-id$' "$lab_test_dir/$lab_case.commands"
    fi
  fi
  ! grep -q local-lab-credential-sentinel "$lab_test_dir/$lab_case.output"
  echo "PASS startup shell: $lab_case"
done
