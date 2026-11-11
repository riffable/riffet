#!/bin/bash
# Runs the app's benchmark on one conversation and fails when a number is over its budget
# (docs/MACOS.md, "性能规范"). Needs the dev build running: `apps/macos/scripts/build.sh dev`.
#
#   apps/macos/scripts/perf-bench.sh <会话 id>            滚动、甩动、跳转、展开、切换、流式
#   apps/macos/scripts/perf-bench.sh <会话 id> --sidebar  另外测侧栏开合动画
#   apps/macos/scripts/perf-bench.sh <会话 id> --settings 另外测设置窗口打开与切换分区
#   apps/macos/scripts/perf-bench.sh <会话 id> --pages     另外测一级页面的进入、再次进入与返回
#   apps/macos/scripts/perf-bench.sh <会话 id> --inspector 另外测侧边面板各标签的打开与切换
#   apps/macos/scripts/perf-bench.sh <会话 id> --cold      另外测不在内存里的会话从设备缓存打开
set -euo pipefail

SESSION="${1:?usage: perf-bench.sh <session-id> [--sidebar] [--settings] [--pages] [--inspector] [--cold]}"
shift
SIDEBAR=""
SETTINGS=""
PAGES=""
INSPECTOR=""
COLD=""
for flag in "$@"; do
  case "$flag" in
    --sidebar) SIDEBAR="--sidebar" ;;
    --settings) SETTINGS="--settings" ;;
    --pages) PAGES="--pages" ;;
    --inspector) INSPECTOR="--inspector" ;;
    --cold) COLD="--cold" ;;
  esac
done
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/../build/Release/Riffet.app"
PERF="$HOME/Library/Application Support/Riffet/perf"

[[ -d "$APP" ]] || { echo "没有 dev 包：先运行 scripts/build.sh dev" >&2; exit 2; }
# The app ignores riffet://perf links until they are turned on from this machine; the installed
# app shares these defaults, so they go off again on the way out.
defaults write io.github.riffetai.mac riffet.perf.links -bool true
trap 'defaults delete io.github.riffetai.mac riffet.perf.links 2>/dev/null || true' EXIT
pgrep -f "build/Release/Riffet.app/Contents/MacOS/Riffet" >/dev/null || { open "$APP"; sleep 8; }

# run <url> <report name>: opens the link and waits for a fresh report.
run() {
  local file="$PERF/latest-$2.json" before=0
  [[ -f "$file" ]] && before="$(stat -f %m "$file")"
  open -a "$APP" "$1"
  for _ in $(seq 1 180); do
    sleep 1
    [[ -f "$file" && "$(stat -f %m "$file")" != "$before" ]] && return 0
  done
  echo "等了 3 分钟没有 $2 报告" >&2
  exit 2
}

measure() {
  run "riffet://perf/bench?session=$SESSION" bench
  if [[ -n "$SIDEBAR" ]]; then run "riffet://perf/sidebar" sidebar; fi
  if [[ -n "$SETTINGS" ]]; then run "riffet://perf/settings" settings; fi
  if [[ -n "$PAGES" ]]; then run "riffet://perf/pages?session=$SESSION" pages; fi
  if [[ -n "$INSPECTOR" ]]; then run "riffet://perf/inspector?session=$SESSION" inspector; fi
  if [[ -n "$COLD" ]]; then run "riffet://perf/cold?session=$SESSION" cold; fi
}

check() {
python3 - "$PERF" "$SIDEBAR" "$SETTINGS" "$PAGES" "$INSPECTOR" "$COLD" <<'EOF'
import json, sys, os
perf, sidebar, settings = sys.argv[1], sys.argv[2] == "--sidebar", sys.argv[3] == "--settings"
pages_on, inspector, cold = sys.argv[4] == "--pages", sys.argv[5] == "--inspector", sys.argv[6] == "--cold"
bench = json.load(open(os.path.join(perf, "latest-bench.json")))
frame = 1000 / (bench["environment"].get("refreshRate") or 60)
pages = bench["pages"]
failures, rows = [], []

def get(page, group, key, field):
    return pages.get(page, {}).get(group, {}).get(key, {}).get(field)

def check(label, value, budget, unit="ms"):
    ok = value is not None and value <= budget
    rows.append(f"{'✓' if ok else '✗'} {label}: {value if value is not None else '—'}{unit}（预算 ≤ {budget:g}{unit}）")
    if not ok: failures.append(label)

# Late-frame time a second: a 120 Hz display leaves 8 ms a frame and compositing alone makes some late.
hitch_budget = 15 if frame > 12 else 60
for page, activity, name in [("bench.scroll", "scroll", "匀速滚动"), ("bench.fling", "scroll", "快速甩动"), ("bench.jump", "scroll", "跳到两端"), ("bench.stream", "stream", "流式输出")]:
    check(f"{name} 每秒卡顿", get(page, "frames", activity, "hitchMsPerSecond"), hitch_budget, "ms/s")
    check(f"{name} p99 帧", get(page, "frames", activity, "p99"), round(frame * 2.2, 1))
check("流式输出 主线程每次应用 p95", get("bench.stream", "phases", "transcript.apply", "p95"), 4)
check("展开/折叠 到上屏 p95", get("bench.toggle", "input", "toggle", "p95"), 50)
check("切到会话 p95", get("bench.switch", "input", "toSession.ready", "p95"), 180)
check("切到首页 p95", get("bench.switch", "input", "toHome", "p95"), 200)
check("打开会话（含读取缓存）", bench["bench"].get("openMs"), 800)

if sidebar:
    report = json.load(open(os.path.join(perf, "latest-sidebar.json")))
    frames = report["pages"].get("bench.sidebar", {}).get("frames", {}).get("interact", {})
    check("侧栏开合 每秒卡顿", frames.get("hitchMsPerSecond"), 150, "ms/s")

if settings:
    report = json.load(open(os.path.join(perf, "latest-settings.json")))
    taps = report["pages"].get("bench.settings", {}).get("input", {})
    check("设置窗口 打开", taps.get("settingsOpen", {}).get("max"), 300)
    check("设置 首次进入分区 p95", taps.get("settingsSection", {}).get("p95"), 180)
    check("设置 再次切回分区 p95", taps.get("settingsRevisit", {}).get("p95"), 120)

def show(label, value, unit="ms"):
    rows.append(f"· {label}: {value if value is not None else '—'}{unit}")

def taps(name, page):
    return json.load(open(os.path.join(perf, f"latest-{name}.json")))["pages"].get(page, {}).get("input", {})

if pages_on:
    t = taps("pages", "bench.pages")
    show("进入页面 p95（到上屏）", t.get("toPage", {}).get("p95"))
    show("进入页面 p95（到内容）", t.get("toPage.ready", {}).get("p95"))
    check("再次进入页面 p95（到内容）", t.get("toPageAgain.ready", {}).get("p95"), 300)
    check("从页面回到会话 p95", t.get("fromPage.ready", {}).get("p95"), 220)
    for key in sorted(k for k in t if k.startswith("page.") and k.endswith(".ready")):
        show(f"  {key}", t[key].get("max"))

if inspector:
    t = taps("inspector", "bench.inspector")
    for key in sorted(k for k in t if k.startswith("inspector")):
        show(f"侧边面板 {key}", t[key].get("max"))
    again = [v.get("max") for k, v in t.items() if k.startswith("inspectorAgain.") and k.endswith(".ready")]
    check("侧边面板 再次切换标签（到内容）最慢", max(again) if again else None, 150)

if cold:
    report = json.load(open(os.path.join(perf, "latest-cold.json")))
    page = report["pages"].get("bench.cold", {})
    show("冷打开 p95（到上屏）", page.get("input", {}).get("coldOpen", {}).get("p95"))
    check("冷打开 p95（到内容）", page.get("input", {}).get("coldOpen.ready", {}).get("p95"), 250)
    check("冷打开 读缓存排队 p95", page.get("phases", {}).get("client.cache.wait", {}).get("p95"), 20)
    for key in sorted(k for k in page.get("phases", {}) if k.startswith("client.")):
        show(f"  {key} p95", page["phases"][key].get("p95"))

print(f"会话 {bench['bench'].get('session')}，{bench['bench'].get('rows')} 行，{bench['environment'].get('build')}，{bench['environment'].get('refreshRate')} Hz")
print("\n".join(rows))
if failures:
    print(f"\n超出预算：{'、'.join(failures)}", file=sys.stderr)
    sys.exit(1)
print("\nperf-bench: ok")
EOF
}

measure
# Other work on the machine can make a few frames late; a real regression is over budget twice.
if ! check; then
  echo "重跑一次确认…" >&2
  sleep 10
  measure
  check
fi
