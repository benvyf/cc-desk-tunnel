#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p /data/home /data/state /data/workspace
if [ ! -r /data/config/service.env ] || [ ! -w /data/home ] || [ ! -w /data/state ]; then
  echo "Run manage.sh init first; data must be writable by container uid 1000." >&2
  exit 1
fi
[ "${1:-}" = server ] || exec "$@"

# Only the administrator-built image is trusted; leave previously downloaded programs intact but unused.
PROGRAM=/app
[ ! -x "$PROGRAM/cli/bin/claude" ] || PATH="$PROGRAM/cli/bin:$PATH"
echo "Starting program $(node -p "require('$PROGRAM/apps/desktop/package.json').version") from $PROGRAM"
export PROXY_RUNTIME_DIR=/opt/runtime
unset PROXY_PROGRAM_DIR
exec node --env-file=/data/config/service.env "$PROGRAM/apps/server/src/main.ts"
