#!/bin/bash
# Checks the macOS sources for patterns that made the app slow before (docs/MACOS.md, "性能规范"),
# and for macOS 26-only calls made outside the helpers that fall back on macOS 15 (C1).
# A line that must break a rule says why with `perf-lint: allow <reason>` on the same line.
#
#   apps/macos/scripts/perf-lint.sh        exit 1 and list the violations, if any
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../Riffet" && pwd)"
cd "$ROOT"
failed=0

# rule <id> <message> <regex> [path...]: every match outside an allowed line is a violation.
rule() {
  local id="$1" message="$2" pattern="$3"
  shift 3
  local hits
  hits="$(rg -n --no-heading -e "$pattern" "${@:-.}" -g '*.swift' 2>/dev/null | rg -v 'perf-lint: allow' || true)"
  if [[ -n "$hits" ]]; then
    printf '\n[%s] %s\n%s\n' "$id" "$message" "$hits"
    failed=1
  fi
}

rule P1 "SwiftUI 的小转圈每帧都让宿主重新布局；用 Spinner" \
  'ProgressView\(\)\.controlSize'
rule P2 "永不停止的 SwiftUI 动画让整窗每帧刷新；用 Core Animation（见 applyShimmer）" \
  '\.repeatForever\('
rule P3 "转录里的 toolTip 是跟踪区域，随列表移动会重设光标；用 FragmentView.help" \
  '\btoolTip\s*=' Features/Transcript/TranscriptViews.swift Features/Transcript/TranscriptCell.swift Features/Transcript/TextLayout.swift
rule P4 "转录的行内不放跟踪区域和光标区域；悬停由 TranscriptController 统一分发" \
  'NSTrackingArea\(|addCursorRect\(|func updateTrackingAreas' Features/Transcript/TranscriptViews.swift Features/Transcript/TranscriptCell.swift Features/Transcript/TextLayout.swift
rule P5 "转录的行内只用 ScrollStrip 滚动（滚动条带跟踪区域，光标重设靠 CursorGuard 去重）" \
  'NSScrollView\(|: NSScrollView' Features/Transcript/TranscriptViews.swift Features/Transcript/TranscriptCell.swift Features/Transcript/TextLayout.swift
rule P6 "面板和页面容器上的动画每帧重排整个窗口；页面直接切换" \
  '\.animation\(' Features/Inspector Features/Workbench
rule P7 "主线程同步等待" \
  'DispatchQueue\.main\.sync'
rule P8 "工具栏、输入框和终端里的 SwiftUI Menu 会在跟踪期间重建菜单；用 ToolbarMenuButton / MenuAnchor" \
  '^\s*Menu \{' Features/Workbench/WorkbenchView.swift Features/Composer/ComposerView.swift Features/Inspector/TerminalPanel.swift
rule P9 "转录布局在后台队列上跑，不能读主线程的状态（S()、DisplayPreferences、AppModel）" \
  '\bS\(|DisplayPreferences\.shared|AppModel\.shared' Features/Transcript/TranscriptLayout.swift Features/Transcript/TranscriptText.swift Features/Transcript/MarkdownModel.swift
rule P10 "整个对话页随会话重建（.id(session.id)）只留给转录本身" \
  'ConversationView\(.*\)\s*\.id\(|^\s*\.id\(session\.id\)' Features/Workbench/WorkbenchView.swift
rule C1 "macOS 26 才有的玻璃只经 riffetGlass(in:) / hideSharedToolbarBackground()（Theme/Controls.swift），macOS 15 上统一回退" \
  '\bglassEffect\(|\bsharedBackgroundVisibility\('

if (( failed )); then
  printf '\nperf-lint: 有违反性能规范或系统兼容的写法（docs/MACOS.md「性能规范」）。确需保留的行加注释 `perf-lint: allow <原因>`。\n' >&2
  exit 1
fi
echo "perf-lint: ok"
