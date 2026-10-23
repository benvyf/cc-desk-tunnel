#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION=v24.21.0
CLAUDE_VERSION=2.1.295
RUNTIME="${CC_DESK_TUNNEL_RUNTIME:-$HOME/.local/share/cc-desk-tunnel/runtime}"
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "Unsupported architecture" >&2; exit 1 ;;
esac
if [ "$(id -u)" -eq 0 ]; then
  echo "Run as the intended ordinary user, without sudo." >&2
  exit 1
fi
mkdir -p "$RUNTIME"
if [ -x "$RUNTIME/node/bin/node" ] && [ "$("$RUNTIME/node/bin/node" --version)" != "$NODE_VERSION" ]; then
  echo "Existing managed Node runtime is not $NODE_VERSION. Choose a new CC_DESK_TUNNEL_RUNTIME directory." >&2
  exit 1
fi
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
ARCHIVE="node-$NODE_VERSION-linux-$ARCH.tar.xz"
if [ ! -x "$RUNTIME/node/bin/node" ]; then
  curl --connect-timeout 20 --max-time 300 -fsSL "https://nodejs.org/dist/$NODE_VERSION/$ARCHIVE" -o "$TEMP/$ARCHIVE"
  curl --connect-timeout 20 --max-time 60 -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TEMP/checksums"
  (cd "$TEMP" && grep "  $ARCHIVE$" checksums | sha256sum -c -)
  tar -xJf "$TEMP/$ARCHIVE" -C "$TEMP"
  mv -- "$TEMP/node-$NODE_VERSION-linux-$ARCH" "$RUNTIME/node"
fi
export PATH="$RUNTIME/node/bin:$PATH"
node --version
# Install the same official native distribution used by the reviewed terminal pilot.
# These release-specific SHA512 values are pinned, not fetched from a mutable manifest.
case "$ARCH" in
  x64) CLAUDE_INTEGRITY='nC9RZ6ZArEavyAiFdEtGK6/XPhjfE79tP2tCh+PjmRUxSO/6W3IuXv/rmo8c6u2UzHyvgKodRj1z6UcBGlbnyA==' ;;
  arm64) CLAUDE_INTEGRITY='JgQigCZCbsTnJQMLBjzeIpx001jlw+QlSR08SsAW7p0hjUR73DczX4NpO2lq/+RPm8w48KhM8DxJqhUmAMV5+Q==' ;;
esac
STAMP="native-$CLAUDE_VERSION-$ARCH.sha256"
if ! (cd "$RUNTIME/cli/bin" 2>/dev/null && sha256sum --status -c "../$STAMP") 2>/dev/null; then
  CLAUDE_ARCHIVE="claude-code-linux-$ARCH-$CLAUDE_VERSION.tgz"
  curl --connect-timeout 20 --max-time 300 -fsSL \
    "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-$ARCH/-/$CLAUDE_ARCHIVE" -o "$TEMP/$CLAUDE_ARCHIVE"
  node --input-type=module -e '
    import {readFileSync} from "node:fs";
    import {createHash} from "node:crypto";
    const actual=createHash("sha512").update(readFileSync(process.argv[1])).digest("base64");
    if(actual!==process.argv[2])throw new Error("Official Claude archive integrity mismatch");
  ' "$TEMP/$CLAUDE_ARCHIVE" "$CLAUDE_INTEGRITY"
  tar -xzf "$TEMP/$CLAUDE_ARCHIVE" -C "$TEMP" package/claude
  mkdir -p "$RUNTIME/cli/bin"
  NEXT="$(mktemp "$RUNTIME/cli/bin/.claude.XXXXXX")"
  install -m 755 "$TEMP/package/claude" "$NEXT"
  mv -f -- "$NEXT" "$RUNTIME/cli/bin/claude"
  (cd "$RUNTIME/cli/bin" && sha256sum claude > "../$STAMP")
fi
"$RUNTIME/cli/bin/claude" --version
printf 'Runtime installed for user %s at %s\n' "$(id -un)" "$RUNTIME"
printf 'No account login or model call has been performed.\n'
