#!/bin/bash
# Builds what Riffet.app carries in Contents/Resources/server (docs/MACOS.md, S1): the official
# Node runtime, the server's dist/ and only the server's production dependencies.
#
#   apps/macos/scripts/build-server-payload.sh [--skip-build]
#
# The Node version comes from the repository's .node-version; NODE_VERSION overrides it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MACOS="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$MACOS/../.." && pwd)"
OUT="$MACOS/build/server-payload"
CACHE="$MACOS/build/cache"
NODE_VERSION="${NODE_VERSION:-$(cat "$REPO/.node-version")}"
NODE_VERSION="v${NODE_VERSION#v}"
ARCH=arm64

# Freeze the same identity for the App and its payload, including tag-only changes in the cache key.
mkdir -p "$MACOS/build"
if [[ -z "${RIFFET_BUILD_INFO_FILE:-}" ]]; then
  export RIFFET_BUILD_INFO_FILE="$MACOS/build/RiffetBuildInfo.json"
  node "$REPO/scripts/build-info.mjs" --output "$RIFFET_BUILD_INFO_FILE"
else
  node "$REPO/scripts/build-info.mjs" --verify "$RIFFET_BUILD_INFO_FILE"
fi

# Everything the payload is made from; an unchanged fingerprint reuses the last payload as it is.
# The excluded-vendor set changes the bundle, and `plugins/` is the vendor surface the core
# imports, so both belong in the key even when the server build skips a rebuild.
fingerprint() {
  {
    echo "$NODE_VERSION"
    echo "excluded-vendors=${RIFFET_EXCLUDED_VENDORS:-}"
    cat "$RIFFET_BUILD_INFO_FILE"
    shasum "$HERE/build-server-payload.sh"
    (cd "$REPO" && git ls-files -co --exclude-standard -z -- package.json pnpm-lock.yaml tsconfig.json scripts plugins apps/server apps/web packages 2>/dev/null \
      | xargs -0 stat -f '%m %z %N' 2>/dev/null)
  } | shasum | awk '{print $1}'
}
STAMP="$MACOS/build/server-payload.fingerprint"
CURRENT="$(fingerprint)"
if [[ "${RIFFET_PAYLOAD_FORCE:-0}" != "1" && -x "$OUT/bin/node" && -f "$STAMP" && "$(cat "$STAMP")" == "$CURRENT" ]]; then
  echo "server payload: unchanged, reusing $OUT"
  exit 0
fi

if [[ "${1:-}" != "--skip-build" ]]; then
  (cd "$REPO" && pnpm build)
fi

# --skip-build is only valid when dist was built from this exact frozen identity.
node - "$RIFFET_BUILD_INFO_FILE" "$REPO/dist/build-info.json" <<'JS'
const fs = require('node:fs');
const expected = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const actual = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (expected.sourceRoot !== actual.sourceRoot || JSON.stringify(expected.build) !== JSON.stringify(actual.build)) {
  throw new Error('Server build identity does not match the App; rebuild Server/Web before packaging');
}
JS

rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/dist" "$CACHE"

# Official runtime, verified against the release's SHASUMS256.txt.
TARBALL="node-$NODE_VERSION-darwin-$ARCH.tar.xz"
if [[ ! -f "$CACHE/$TARBALL" ]]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL" -o "$CACHE/$TARBALL.partial"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
  expected="$(grep " $TARBALL\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | awk '{print $1}')"
  actual="$(shasum -a 256 "$CACHE/$TARBALL.partial" | awk '{print $1}')"
  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    echo "error: checksum mismatch for $TARBALL" >&2
    exit 1
  fi
  mv "$CACHE/$TARBALL.partial" "$CACHE/$TARBALL"
fi
[[ -x "$CACHE/node-$NODE_VERSION-darwin-$ARCH/bin/node" ]] || tar -xJf "$CACHE/$TARBALL" -C "$CACHE"
cp "$CACHE/node-$NODE_VERSION-darwin-$ARCH/bin/node" "$OUT/bin/node"
cp "$CACHE/node-$NODE_VERSION-darwin-$ARCH/LICENSE" "$OUT/bin/NODE-LICENSE"

# The server and the assets it serves; source maps stay out of the app.
rsync -a --exclude '*.map' "$REPO/dist/" "$OUT/dist/"
# Riffet's own license and notice must travel with the server the App carries.
for legal in LICENSE NOTICE; do
  [[ -f "$REPO/dist/$legal" ]] || { echo "error: dist/$legal is missing; run pnpm build" >&2; exit 1; }
done
# Licenses of every npm package in the payload, next to Node's (scripts/third-party-notices.ts).
cp "$REPO/dist/THIRD_PARTY_NOTICES.md" "$OUT/bin/THIRD_PARTY_NOTICES.md"

# Only what dist/ loads at runtime, as scripts/build.ts derived it from the bundle.
cp "$REPO/dist/runtime-package.json" "$OUT/package.json"
# The installed dependencies only change with that manifest, so they are kept per manifest hash.
MODULES="$CACHE/deps-$(shasum "$OUT/package.json" | awk '{print $1}')/node_modules"
if [[ ! -d "$MODULES" ]]; then
  (cd "$OUT" && npm install --omit=dev --no-audit --no-fund --no-package-lock --ignore-scripts --registry=https://registry.npmjs.org/ >/dev/null)
  rm -rf "$CACHE"/deps-*
  ditto "$OUT/node_modules" "$MODULES"
else
  ditto "$MODULES" "$OUT/node_modules"
fi

# node-pty ships prebuilt binaries for every platform; keep this Mac's, so nothing else gets signed.
PREBUILDS="$OUT/node_modules/node-pty/prebuilds"
if [[ -d "$PREBUILDS" ]]; then
  find "$PREBUILDS" -mindepth 1 -maxdepth 1 ! -name "darwin-$ARCH" -exec rm -rf {} +
  chmod +x "$PREBUILDS/darwin-$ARCH/spawn-helper"
fi
find "$OUT/node_modules" -name '*.md' -not -iname 'licen[cs]e*' -not -iname 'notice*' -not -iname 'copying*' -not -iname 'third*party*' -delete 2>/dev/null || true
node "$REPO/scripts/build-info.mjs" --verify "$RIFFET_BUILD_INFO_FILE"
# Keep the frozen record with the payload so bundle-server can verify both identities.
cp "$RIFFET_BUILD_INFO_FILE" "$OUT/RiffetBuildInfo.json"
echo "$CURRENT" > "$STAMP"

echo "server payload: $OUT ($(du -sh "$OUT" | awk '{print $1}'), node $NODE_VERSION)"
