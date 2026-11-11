#!/bin/bash
# Builds a distributable Riffet.app: Release build with the bundled server, signed, notarized,
# stapled, packed into a DMG, with a Sparkle appcast and the sha256 the Homebrew cask needs.
#
#   RIFFET_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" \
#   RIFFET_TEAM_ID=TEAMID \
#   RIFFET_NOTARY_PROFILE=riffet-notary \
#   RIFFET_DOWNLOAD_PREFIX=https://github.com/riffetai/riffet/releases/download/v0.1.0/ \
#   apps/macos/scripts/release.sh [--skip-build]
#
# Without RIFFET_SIGN_IDENTITY the app is ad-hoc signed and not notarized: fine for this Mac,
# while another Mac's Gatekeeper asks for an explicit "打开" first (docs/MACOS.md, 需要拍板的决策).
# The notary profile is created once with `xcrun notarytool store-credentials`. The Sparkle EdDSA
# key lives in the login keychain (`generate_keys` from Sparkle's artifacts creates it).
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
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"

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

if [[ "$IDENTITY" != "-" && -n "${RIFFET_NOTARY_PROFILE:-}" ]]; then
  ditto -c -k --keepParent "$APP" "$OUT/Riffet-notarize.zip"
  xcrun notarytool submit "$OUT/Riffet-notarize.zip" --keychain-profile "$RIFFET_NOTARY_PROFILE" --wait
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
  if [[ -n "${RIFFET_NOTARY_PROFILE:-}" ]]; then
    xcrun notarytool submit "$DMG" --keychain-profile "$RIFFET_NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
  fi
fi

# Sparkle appcast from the update archives in $OUT (generate_appcast signs them with the EdDSA key).
GENERATE="$(find "$MACOS/build/DerivedData/SourcePackages/artifacts" -path '*Sparkle*/bin/generate_appcast' -type f 2>/dev/null | head -1)"
if [[ -n "$GENERATE" && -n "${RIFFET_DOWNLOAD_PREFIX:-}" ]]; then
  ditto -c -k --keepParent "$APP" "$OUT/Riffet-$VERSION.zip"
  "$GENERATE" --download-url-prefix "$RIFFET_DOWNLOAD_PREFIX" "$OUT"
fi

SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
echo
echo "release: $DMG"
echo "version: $VERSION"
echo "sha256:  $SHA"
echo "cask:    sed -e 's/@VERSION@/$VERSION/' -e 's/@SHA256@/$SHA/' $MACOS/packaging/homebrew/riffet.rb"
