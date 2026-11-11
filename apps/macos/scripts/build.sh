#!/bin/bash
# Builds Riffet.app.
#
#   apps/macos/scripts/build.sh            Debug, into apps/macos/build/Debug/Riffet.app
#   apps/macos/scripts/build.sh release    Release with the bundled server (builds the payload first)
#   apps/macos/scripts/build.sh dev        Release compiled file by file, installed and relaunched
#   apps/macos/scripts/build.sh dev --fast-kotlin
#                                          the same with a debug Kotlin framework: ~20 s instead of
#                                          80-100 s after a Kotlin change, but the app runs slower
#   apps/macos/scripts/build.sh test       Debug build, then the unit tests (and perf-lint, check-i18n)
#   apps/macos/scripts/build.sh perf <id>  perf-lint, then the benchmark on the running dev build
#
# The Kotlin framework is built by the Xcode project's own build phase, so this needs JDK 17+,
# Xcode 26 and XcodeGen (`brew install xcodegen`).
#
# Every step says what it is doing: the expensive one runs xcodebuild -quiet, which prints nothing
# at all until something is wrong, and a silent terminal reads as a hung build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MACOS="$(cd "$HERE/.." && pwd)"
MODE="${1:-debug}"
[[ "$MODE" == "dev" && "${2:-}" == "--fast-kotlin" ]] && export RIFFET_KOTLIN_BUILD_TYPE=debug
STARTED=$SECONDS
REPO="$(cd "$MACOS/../.." && pwd)"
# Freeze once before either the payload or Xcode is built. This path is inherited by all phases.
if [[ "$MODE" != "perf" ]]; then
  mkdir -p "$MACOS/build"
  if [[ -z "${RIFFET_BUILD_INFO_FILE:-}" ]]; then
    export RIFFET_BUILD_INFO_FILE="$MACOS/build/RiffetBuildInfo.json"
    node "$REPO/scripts/build-info.mjs" --output "$RIFFET_BUILD_INFO_FILE"
  else
    node "$REPO/scripts/build-info.mjs" --verify "$RIFFET_BUILD_INFO_FILE"
  fi
fi

step() { printf '==> %s\n' "$1"; }

elapsed() {
  local seconds=$1
  if (( seconds < 60 )); then printf '%ds' "$seconds"; else printf '%dm%02ds' $((seconds / 60)) $((seconds % 60)); fi
}

# xcodebuild's -quiet keeps warnings and errors only, so a three-minute compile prints one line or
# none. Report progress every 15 seconds without delaying a completed build by that interval.
build_quietly() {
  local started=$SECONDS
  "$@" &
  local pid=$!
  local next_report=15
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.25
    kill -0 "$pid" 2>/dev/null || break
    if (( SECONDS - started >= next_report )); then
      printf '    构建中… %s\n' "$(elapsed $((SECONDS - started)))"
      next_report=$((next_report + 15))
    fi
  done
  if wait "$pid"; then
    printf '    构建完成 %s\n' "$(elapsed $((SECONDS - started)))"
  else
    printf '    构建失败 %s\n' "$(elapsed $((SECONDS - started)))" >&2
    return 1
  fi
}

cd "$MACOS"
step "生成 Xcode 工程（xcodegen）"
xcodegen generate --quiet

case "$MODE" in
  debug)
    step "编译 Debug"
    build_quietly xcodebuild -project Riffet.xcodeproj -scheme Riffet -configuration Debug -derivedDataPath build/DerivedData \
      -destination 'platform=macOS,arch=arm64' -skipPackagePluginValidation -skipMacroValidation build -quiet
    mkdir -p build/Debug && rm -rf build/Debug/Riffet.app
    cp -R build/DerivedData/Build/Products/Debug/Riffet.app build/Debug/
    echo "built: $MACOS/build/Debug/Riffet.app（用时 $(elapsed $((SECONDS - STARTED)))）"
    ;;
  release)
    step "准备 server payload（指纹没变就直接复用）"
    "$HERE/build-server-payload.sh"
    step "编译 Release"
    build_quietly xcodebuild -project Riffet.xcodeproj -scheme Riffet -configuration Release -derivedDataPath build/DerivedData \
      -destination 'platform=macOS,arch=arm64' -skipPackagePluginValidation -skipMacroValidation build -quiet
    mkdir -p build/Release && rm -rf build/Release/Riffet.app
    cp -R build/DerivedData/Build/Products/Release/Riffet.app build/Release/
    echo "built: $MACOS/build/Release/Riffet.app（用时 $(elapsed $((SECONDS - STARTED)))）"
    ;;
  dev)
    # Optimised like Release, but per file: a one-file change recompiles that file instead of
    # re-optimising the whole module (seconds rather than a minute). release.sh keeps whole-module
    # optimisation for what ships. A dev build is used on this machine only, so it skips what only
    # a shipped app needs: the bundled server payload (its launcher runs this checkout's dist/ with
    # the local node, as Debug does; the payload was rebuilt on every commit) and the dSYM.
    step "编译 Release（单文件优化，不打包 server）"
    build_quietly xcodebuild -project Riffet.xcodeproj -scheme Riffet -configuration Release -derivedDataPath build/DerivedData \
      -destination 'platform=macOS,arch=arm64' -skipPackagePluginValidation -skipMacroValidation build -quiet \
      SWIFT_COMPILATION_MODE=singlefile RIFFET_BUNDLE_SERVER=NO RIFFET_SERVER_FROM_CHECKOUT=YES DEBUG_INFORMATION_FORMAT=dwarf
    step "重启 app"
    running="$(pgrep -f "build/Release/Riffet.app/Contents/MacOS/Riffet" || true)"
    if [[ -n "$running" ]]; then
      kill $running
      while pgrep -f "build/Release/Riffet.app/Contents/MacOS/Riffet" >/dev/null; do sleep 0.2; done
    fi
    # Only what changed is copied; the signature covers the result exactly as built.
    mkdir -p build/Release/Riffet.app
    rsync -a --delete build/DerivedData/Build/Products/Release/Riffet.app/ build/Release/Riffet.app/
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f build/Release/Riffet.app
    open build/Release/Riffet.app
    echo "running: $MACOS/build/Release/Riffet.app（用时 $(elapsed $((SECONDS - STARTED)))）"
    ;;
  update-debug|update-release)
    # The update CLI owns stopping, verification and replacement. Never install or open here.
    CONFIGURATION=Debug
    if [[ "$MODE" == "update-release" ]]; then CONFIGURATION=Release; fi
    step "暂存编译 ${CONFIGURATION}（不替换或启动 App）"
    build_quietly xcodebuild -project Riffet.xcodeproj -scheme Riffet -configuration "$CONFIGURATION" -derivedDataPath build/UpdateDerivedData \
      -destination 'platform=macOS,arch=arm64' -skipPackagePluginValidation -skipMacroValidation build -quiet
    node "$REPO/scripts/build-info.mjs" --verify "$RIFFET_BUILD_INFO_FILE"
    mkdir -p build/update
    rm -rf build/update/Riffet.app
    ditto "build/UpdateDerivedData/Build/Products/$CONFIGURATION/Riffet.app" build/update/Riffet.app
    echo "staged: $MACOS/build/update/Riffet.app"
    ;;
  test)
    step "性能规范检查（perf-lint）"
    "$HERE/perf-lint.sh"
    step "编译 Debug 并跑单测"
    build_quietly xcodebuild -project Riffet.xcodeproj -scheme Riffet -configuration Debug -derivedDataPath build/DerivedData \
      -destination 'platform=macOS,arch=arm64' -skipPackagePluginValidation -skipMacroValidation test -quiet
    # Reads what this build's compiler extracted, so it runs after it.
    step "界面语言检查（check-i18n）"
    node "$HERE/check-i18n.mjs" build/DerivedData
    echo "tests ok（用时 $(elapsed $((SECONDS - STARTED)))）"
    ;;
  perf)
    step "性能规范检查（perf-lint）"
    "$HERE/perf-lint.sh"
    step "基准（需要 dev 包在运行）"
    "$HERE/perf-bench.sh" "${2:?usage: $0 perf <session-id> [--sidebar] [--settings]}" "${@:3}"
    ;;
  *)
    echo "usage: $0 [debug|release|dev|update-debug|update-release|test|perf <session-id>]" >&2
    exit 2
    ;;
esac
