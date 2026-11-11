#!/bin/bash
# Xcode's first phase freezes the App identity outside tracked Resources. Command-line builders
# may provide the same frozen record used for Server/Web in RIFFET_BUILD_INFO_FILE.
set -euo pipefail
REPO="$(cd "$SRCROOT/../.." && pwd)"
node_path="$(/bin/zsh -lc 'command -v node' 2>/dev/null || true)"
for candidate in "$node_path" "$HOME/.local/bin/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then node_path="$candidate"; break; fi
done
if [[ -z "$node_path" || ! -x "$node_path" ]]; then echo 'error: Node is required to record the build version' >&2; exit 1; fi
if [[ -n "${RIFFET_BUILD_INFO_FILE:-}" ]]; then
  "$node_path" "$REPO/scripts/build-info.mjs" --verify "$RIFFET_BUILD_INFO_FILE"
else
  "$node_path" "$REPO/scripts/build-info.mjs" --output "$DERIVED_FILE_DIR/RiffetBuildInfo.json"
fi
