#!/bin/bash
# Builds a distributable Riffet.app: Release build with the bundled server, signed, notarized,
# stapled, packed into a DMG, plus the Sparkle update archive and its signed appcast entry.
#
#   RIFFET_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" \
#   RIFFET_TEAM_ID=TEAMID \
#   RIFFET_NOTARY_PROFILE=riffet-notary \
#   apps/macos/scripts/release.sh [--skip-build]
#
# Output in build/dist: Riffet-<version>.dmg (download), Riffet-<version>.zip (what Sparkle installs)
# and Riffet-<version>.appcast.json (its EdDSA signature and requirements). The appcast itself is
# built from the published releases by scripts/build-appcast.ts (docs/RELEASE.md).
#
# Without RIFFET_SIGN_IDENTITY the app is ad-hoc signed and not notarized: fine for this Mac,
# while another Mac's Gatekeeper asks for an explicit "打开" first (docs/MACOS.md, 需要拍板的决策).
# Notarization uses either a keychain profile (`xcrun notarytool store-credentials`, RIFFET_NOTARY_PROFILE)
# or an App Store Connect API key (RIFFET_NOTARY_KEY=<.p8 path>, RIFFET_NOTARY_KEY_ID, RIFFET_NOTARY_ISSUER),
# which is what CI uses. The Sparkle EdDSA key comes from RIFFET_SPARKLE_KEY_FILE, or else the login
# keychain (`generate_keys` from Sparkle's artifacts creates it).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MACOS="$(cd "$HERE/.." && pwd)"
IDENTITY="${RIFFET_SIGN_IDENTITY:--}"
OUT="$MACOS/build/dist"
ARCHIVE="$MACOS/build/Riffet.xcarchive"

cd "$MACOS"
REPO="$(cd "$MACOS/../.." && pwd)"
mkdir -p "$MACOS/build"
if [[ -z "${RIFFET_BUILD_INFO_FILE:-}" ]]; then
  export RIFFET_BUILD_INFO_FILE="$MACOS/build/RiffetBuildInfo.json"
  node "$REPO/scripts/build-info.mjs" --output "$RIFFET_BUILD_INFO_FILE"
else
  node "$REPO/scripts/build-info.mjs" --verify "$RIFFET_BUILD_INFO_FILE"
fi
# A release payload must be built from this exact checkout and exclusion set, never reused from a
# cache that another configuration produced.
export RIFFET_PAYLOAD_FORCE=1
"$HERE/build-server-payload.sh" "$@"
# A public release must not carry an excluded vendor's code or assets in the server it ships.
if [[ -n "${RIFFET_EXCLUDED_VENDORS:-}" ]]; then
  node "$REPO/scripts/check-public-artifacts.mjs" "$MACOS/build/server-payload"
fi
xcodegen generate --quiet

settings=(CODE_SIGN_IDENTITY="$IDENTITY")
if [[ "$IDENTITY" != "-" ]]; then
  settings+=(DEVELOPMENT_TEAM="${RIFFET_TEAM_ID:?set RIFFET_TEAM_ID}" OTHER_CODE_SIGN_FLAGS="--timestamp" ENABLE_HARDENED_RUNTIME=YES)
fi
if [[ -n "${RIFFET_SPARKLE_PUBLIC_KEY:-}" ]]; then settings+=(RIFFET_SPARKLE_PUBLIC_KEY="$RIFFET_SPARKLE_PUBLIC_KEY"); fi
if [[ -n "${RIFFET_APPCAST_URL:-}" ]]; then settings+=(RIFFET_APPCAST_URL="$RIFFET_APPCAST_URL"); fi

rm -rf "$ARCHIVE" "$OUT"
mkdir -p "$OUT"
xcodebuild -project Riffet.xcodeproj -scheme Riffet -configuration Release -derivedDataPath build/DerivedData \
  -destination 'generic/platform=macOS' -skipPackagePluginValidation -skipMacroValidation \
  -archivePath "$ARCHIVE" archive "${settings[@]}" -quiet
APP="$OUT/Riffet.app"
ditto "$ARCHIVE/Products/Applications/Riffet.app" "$APP"
# The full version (a beta's -beta.N included) names the files; the bundle carries MAJOR.MINOR.PATCH.
VERSION="$(node -p "require('$REPO/package.json').version")"
plist() { /usr/libexec/PlistBuddy -c "Print $1" "$APP/Contents/Info.plist"; }
SHORT_VERSION="$(plist CFBundleShortVersionString)"
BUILD="$(plist CFBundleVersion)"
[[ "$SHORT_VERSION" == "${VERSION%%-*}" ]] || { echo "release: the app is $SHORT_VERSION, package.json is $VERSION; run pnpm version:check" >&2; exit 1; }

notary=()
if [[ -n "${RIFFET_NOTARY_KEY:-}" ]]; then
  notary=(--key "$RIFFET_NOTARY_KEY" --key-id "${RIFFET_NOTARY_KEY_ID:?set RIFFET_NOTARY_KEY_ID}" --issuer "${RIFFET_NOTARY_ISSUER:?set RIFFET_NOTARY_ISSUER}")
elif [[ -n "${RIFFET_NOTARY_PROFILE:-}" ]]; then
  notary=(--keychain-profile "$RIFFET_NOTARY_PROFILE")
fi

if [[ "$IDENTITY" != "-" ]]; then
  # Inside out: each extension (<Name>.appex, entitlements at <Name>/<Name>.entitlements) with its own
  # sandbox entitlements, then the app, whose seal covers them.
  for extension in "$APP"/Contents/PlugIns/*.appex; do
    [[ -d "$extension" ]] || continue
    name="$(basename "$extension" .appex)"
    codesign --force --timestamp --options runtime --entitlements "$MACOS/$name/$name.entitlements" --sign "$IDENTITY" "$extension"
  done
  codesign --force --timestamp --options runtime --entitlements "$MACOS/Riffet/Resources/Riffet.entitlements" --sign "$IDENTITY" "$APP"
fi
codesign --verify --deep --strict --verbose=1 "$APP"

if [[ "$IDENTITY" != "-" && ${#notary[@]} -gt 0 ]]; then
  ditto -c -k --keepParent "$APP" "$OUT/Riffet-notarize.zip"
  xcrun notarytool submit "$OUT/Riffet-notarize.zip" "${notary[@]}" --wait
  xcrun stapler staple "$APP"
  rm "$OUT/Riffet-notarize.zip"
fi

# DMG with an /Applications shortcut: the app must run from a fixed path (Claude hooks point at
# the bundled node), so dragging it there is the install step.
STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/Riffet.app"
ln -s /Applications "$STAGE/Applications"
DMG="$OUT/Riffet-$VERSION.dmg"
hdiutil create -volname "Riffet $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG" -quiet
rm -rf "$STAGE"
if [[ "$IDENTITY" != "-" ]]; then
  codesign --force --timestamp --sign "$IDENTITY" "$DMG"
  if [[ ${#notary[@]} -gt 0 ]]; then
    xcrun notarytool submit "$DMG" "${notary[@]}" --wait
    xcrun stapler staple "$DMG"
  fi
fi

# Sparkle installs the zipped (stapled) app. Its appcast entry is signed here, where the key is; the
# feed that lists the entries of every published release is built when the site is deployed.
SIGN="$(find "$MACOS/build/DerivedData/SourcePackages/artifacts" -path '*Sparkle*/bin/sign_update' -type f 2>/dev/null | head -1)"
if [[ "$IDENTITY" != "-" && -n "$SIGN" ]]; then
  ZIP="$OUT/Riffet-$VERSION.zip"
  ditto -c -k --keepParent "$APP" "$ZIP"
  key=()
  if [[ -n "${RIFFET_SPARKLE_KEY_FILE:-}" ]]; then key=(--ed-key-file "$RIFFET_SPARKLE_KEY_FILE"); fi
  # Prints: sparkle:edSignature="…" length="…"
  signature="$("$SIGN" ${key[@]+"${key[@]}"} "$ZIP")"
  SIGNATURE="$(sed -n 's/.*edSignature="\([^"]*\)".*/\1/p' <<<"$signature")"
  LENGTH="$(sed -n 's/.*length="\([0-9]*\)".*/\1/p' <<<"$signature")"
  [[ -n "$SIGNATURE" && -n "$LENGTH" ]] || { echo "release: sign_update printed no signature" >&2; exit 1; }
  VERSION="$VERSION" SHORT_VERSION="$SHORT_VERSION" BUILD="$BUILD" MINIMUM="$(plist LSMinimumSystemVersion)" \
    FILE="$(basename "$ZIP")" SIGNATURE="$SIGNATURE" LENGTH="$LENGTH" node -e '
      const e = process.env;
      const entry = { version: e.VERSION, shortVersion: e.SHORT_VERSION, build: e.BUILD, minimumSystemVersion: e.MINIMUM,
        file: e.FILE, length: Number(e.LENGTH), edSignature: e.SIGNATURE };
      process.stdout.write(JSON.stringify(entry, null, 2) + "\n");' > "$OUT/Riffet-$VERSION.appcast.json"
fi

SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
echo
echo "release: $DMG"
echo "version: $VERSION"
echo "sha256:  $SHA"
echo "cask:    sed -e 's/@VERSION@/$VERSION/' -e 's/@SHA256@/$SHA/' $MACOS/packaging/homebrew/riffet.rb"
