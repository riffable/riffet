#!/bin/bash
# Xcode build phase, after the frameworks are embedded and before the app itself is signed.
#
# Sparkle arrives signed with its authors' Team ID. Under hardened runtime, library validation only
# lets the app load code signed by the same team, so an ad-hoc (or our Developer ID) app refuses to
# start with Sparkle as shipped. Re-sign it and its helpers with this build's identity, keeping
# their entitlements. App extensions (widget, share) are signed by their own targets with their own
# sandbox entitlements; they are signed again here only to take this build's identity and options,
# keeping those entitlements, because the app's seal covers them and has to come last.
set -euo pipefail

IDENTITY="${EXPANDED_CODE_SIGN_IDENTITY:--}"
[[ -z "$IDENTITY" ]] && IDENTITY=-
TIMESTAMP=--timestamp
RUNTIME=(--options runtime)
if [[ "$IDENTITY" == "-" ]]; then
  TIMESTAMP=--timestamp=none
  RUNTIME=()
fi
SPARKLE="$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH/Sparkle.framework"

sign() { codesign --force "$TIMESTAMP" ${RUNTIME[@]+"${RUNTIME[@]}"} --preserve-metadata=entitlements --sign "$IDENTITY" "$1"; }
if [[ -d "$SPARKLE" ]]; then
  VERSION="$SPARKLE/Versions/B"
  for helper in "$VERSION/XPCServices/Installer.xpc" "$VERSION/XPCServices/Downloader.xpc" "$VERSION/Autoupdate" "$VERSION/Updater.app"; do
    [[ -e "$helper" ]] && sign "$helper"
  done
  sign "$SPARKLE"
fi
for extension in "$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/PlugIns"/*.appex; do
  [[ -d "$extension" ]] && sign "$extension"
done

# Xcode skips the app's own signing step when it thinks nothing changed, so seal the app again
# here; when Xcode does sign it afterwards, that signature simply replaces this one.
if codesign -d "$CODESIGNING_FOLDER_PATH" >/dev/null 2>&1; then
  # A test run injects RiffetTests.xctest into PlugIns; the seal has to cover it as it stands, and
  # Xcode signs it again when the test target is rebuilt.
  for plugin in "$CODESIGNING_FOLDER_PATH"/Contents/PlugIns/*.xctest; do
    [[ -d "$plugin" ]] && { codesign --force --timestamp=none --sign "$IDENTITY" "$plugin" || rm -rf "$plugin"; }
  done
  codesign --force "$TIMESTAMP" ${RUNTIME[@]+"${RUNTIME[@]}"} --preserve-metadata=entitlements --sign "$IDENTITY" "$CODESIGNING_FOLDER_PATH"
fi
