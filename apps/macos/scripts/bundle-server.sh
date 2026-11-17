#!/bin/bash
# Xcode build phase: puts the server the App can host into Contents/Resources/server.
#
# Release (RIFFET_BUNDLE_SERVER=YES) copies the payload from build-server-payload.sh and signs every
# Mach-O in it from the inside out, so the app's own signature (and notarization) covers it.
# Debug points the launcher at this checkout's dist/ and the node on this machine instead, which is
# enough to exercise "由 Riffet 托管" without building a payload. RIFFET_SERVER_FROM_CHECKOUT=YES
# (`build.sh dev`) does the same without rebuilding dist/: the server there is whatever the checkout
# last built and serves.
set -euo pipefail

DEST="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/server"
REPO="$(cd "$SRCROOT/../.." && pwd)"
# A public build may not embed this machine's checkout or Node path; only the bundled payload is
# self-contained (the launcher resolves node and dist relative to itself).
if [[ "${RIFFET_PUBLIC_BUILD:-0}" == "1" && "${RIFFET_BUNDLE_SERVER:-NO}" != "YES" ]]; then
  echo 'error: a public build must bundle the server (RIFFET_BUNDLE_SERVER=YES)' >&2
  exit 1
fi
mkdir -p "$DEST"
node_path="$(/bin/zsh -lc 'command -v node' 2>/dev/null || true)"
for candidate in "$node_path" "$HOME/.local/bin/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then node_path="$candidate"; break; fi
done
if [[ -z "$node_path" || ! -x "$node_path" ]]; then echo 'error: Node is required to build the server' >&2; exit 1; fi
export PATH="$(dirname "$node_path"):$PATH"
export RIFFET_BUILD_INFO_FILE="${RIFFET_BUILD_INFO_FILE:-$DERIVED_FILE_DIR/RiffetBuildInfo.json}"
node "$REPO/scripts/build-info.mjs" --verify "$RIFFET_BUILD_INFO_FILE"
# A direct xcodebuild also gets a matching payload; no external prep step is required.
if [[ "${RIFFET_BUNDLE_SERVER:-NO}" == "YES" ]]; then
  "$SRCROOT/scripts/build-server-payload.sh"
elif [[ "${RIFFET_SERVER_FROM_CHECKOUT:-NO}" == "YES" ]]; then
  [[ -f "$REPO/dist/cli.js" ]] || { echo "error: no $REPO/dist/cli.js; run pnpm build once" >&2; exit 1; }
else
  (cd "$REPO" && pnpm build)
fi
node "$REPO/scripts/build-info.mjs" --verify "$RIFFET_BUILD_INFO_FILE"
node - "$RIFFET_BUILD_INFO_FILE" "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/RiffetBuildInfo.json" "$CONFIGURATION" <<'JS'
const fs = require('node:fs');
const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
record.buildConfiguration = process.argv[4];
fs.writeFileSync(process.argv[3], JSON.stringify(record, null, 2) + '\n');
JS

if [[ "${RIFFET_BUNDLE_SERVER:-NO}" == "YES" ]]; then
  PAYLOAD="$SRCROOT/build/server-payload"
  if [[ ! -x "$PAYLOAD/bin/node" ]]; then
    echo "error: no server payload; run apps/macos/scripts/build-server-payload.sh first" >&2
    exit 1
  fi
  rsync -a --delete --exclude riffet-server "$PAYLOAD/" "$DEST/"
  NODE='"$DIR/bin/node"'
  CLI='"$DIR/dist/cli.js"'
  BUNDLED='export RIFFET_BUNDLED_NODE=1'
else
  # A bundled build before this one left its payload here; only the launcher belongs now.
  find "$DEST" -mindepth 1 -maxdepth 1 ! -name riffet-server -exec rm -rf {} +
  printf -v NODE '%q' "$node_path"
  printf -v CLI '%q' "$REPO/dist/cli.js"
  BUNDLED=':'
fi

cat > "$DEST/riffet-server" <<LAUNCHER
#!/bin/sh
# Started by launchd through Riffet.app's LaunchAgent (io.github.riffable.mac.server).
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
STATE="\${RIFFET_STATE_DIR:-\$HOME/.local/share/riffet}"
mkdir -p "\$STATE" && chmod 700 "\$STATE"
[ -f "\$STATE/app-server.env" ] && . "\$STATE/app-server.env"
exec >>"\$STATE/server.log" 2>&1
AUTH=--no-auth
[ "\${RIFFET_AUTH:-0}" = "1" ] && AUTH=--auth
export RIFFET_MANAGED_BY=app
$BUNDLED
exec $NODE $CLI serve --state-dir "\$STATE" --host "\${RIFFET_HOST:-127.0.0.1}" --port "\${RIFFET_PORT:-4337}" --cli "\${RIFFET_CLI:-cursor-agent}" \$AUTH
LAUNCHER
chmod 755 "$DEST/riffet-server"

if [[ "${RIFFET_BUNDLE_SERVER:-NO}" == "YES" ]]; then
  IDENTITY="${EXPANDED_CODE_SIGN_IDENTITY:--}"
  [[ -z "$IDENTITY" ]] && IDENTITY=-
  # Notarization wants a secure timestamp; an ad-hoc signature cannot carry one.
  TIMESTAMP=--timestamp
  [[ "$IDENTITY" == "-" ]] && TIMESTAMP=--timestamp=none
  sign() { codesign --force "$TIMESTAMP" --options runtime --sign "$IDENTITY" "$@"; }
  # Native modules first, then the runtime that loads them (with Node's own JIT entitlements).
  while IFS= read -r -d '' binary; do
    sign "$binary"
  done < <(find "$DEST/node_modules" -type f \( -name '*.node' -o -name 'spawn-helper' -o -name '*.dylib' -o -path '*/@esbuild/darwin-*/bin/esbuild' \) -print0)
  sign --entitlements "$SRCROOT/scripts/node.entitlements" "$DEST/bin/node"
fi
