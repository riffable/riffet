import AppKit
import KeyboardShortcuts
import SwiftUI
import RiffetKit

/// 输入: how the composer sends, stored on the server.
struct InputSettings: View {
    @Environment(AppModel.self) private var model
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        if let workbench = model.workbench {
            form(workbench)
        } else {
            NeedsServerView()
        }
    }

    private func form(_ workbench: Workbench) -> some View {
        let settings = workbench.settings
        let behavior = settings?.composerEnterBehavior == "newline" ? "newline" : "send"
        let runningBehavior = settings?.composerRunningBehavior == "steer" ? "steer" : "queue"
        return Form {
            Section {
                // The other key, the one the reader cannot see from the choice itself.
                SettingsRow(String(localized: "Enter 键"), detail: behavior == "send" ? String(localized: "⇧↩ 换行") : String(localized: "⌘↩ 发送")) {
                    FormSegmented("Enter 键", selection: enterBinding(workbench, current: behavior)) {
                        Text("发送").tag("send")
                        Text("换行").tag("newline")
                    }
                    .labelsHidden()
                    .fixedSize()
                    .disabled(busy)
                }

                SettingsRow(String(localized: "运行中发送的消息")) {
                    FormSegmented("运行中发送的消息", selection: runningBinding(workbench, current: runningBehavior)) {
                        Text("排队").tag("queue")
                        Text("补充到当前任务").tag("steer")
                    }
                    .labelsHidden()
                    .fixedSize()
                    .disabled(busy)
                    .accessibilityIdentifier("composerRunningBehavior")
                }

                SettingsRow(String(localized: "展示稍后发送按钮")) {
                    Toggle("展示稍后发送按钮", isOn: sendLaterBinding(workbench, current: settings?.composerSendLater?.boolValue == true))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .disabled(busy)
                }

                SettingsErrorText(message: error)
            }

            SettingsScopeFooter()
        }
        .riffetForm()
    }

    private func enterBinding(_ workbench: Workbench, current: String) -> Binding<String> {
        Binding(
            get: { current },
            set: { next in
                guard next != current else { return }
                Task { await save(workbench, SettingsPatch.make(composerEnterBehavior: next)) }
            }
        )
    }

    private func runningBinding(_ workbench: Workbench, current: String) -> Binding<String> {
        Binding(get: { current }, set: { next in
            guard next != current else { return }
            Task { await save(workbench, SettingsPatch.make(composerRunningBehavior: next)) }
        })
    }

    private func sendLaterBinding(_ workbench: Workbench, current: Bool) -> Binding<Bool> {
        Binding(get: { current }, set: { next in
            guard next != current else { return }
            Task { await save(workbench, SettingsPatch.make(composerSendLater: next)) }
        })
    }

    private func save(_ workbench: Workbench, _ body: AppSettingsUpdate) async {
        busy = true
        error = nil
        do { try await SettingsStore.save(workbench, body) } catch { self.error = error.riffetMessage }
        busy = false
    }
}

/// 快捷键: the system-wide key that opens quick chat, then every in-app shortcut of the shared table
/// (`ShortcutStore`), each one recordable. This Mac's.
struct ShortcutSettings: View {
    private let store = ShortcutStore.shared
    @Environment(\.palette) private var palette
    @State private var recording: ShortcutID?
    @State private var notice: Notice?
    @State private var monitor = KeyMonitor()

    private struct Notice {
        let id: ShortcutID
        let text: String
        var replace: (chord: String, other: ShortcutID)?
    }

    var body: some View {
        Form {
            SettingsBlock("全局快捷键") {
                SettingsRow("打开快速对话") {
                    KeyboardShortcuts.Recorder(for: .quickPrompt)
                }
            }

            block(String(localized: "工作台"), scope: .workbench)

            SettingsBlock("标签页") {
                ForEach(rows(.tabs)) { row($0) }
                SettingsShortcutRow(title: String(localized: "切换到第 1–8 个标签"), keys: ["⌘", "1–8"])
                SettingsShortcutRow(title: String(localized: "最后一个标签"), keys: ["⌘", "9"])
            }

            block(String(localized: "会话"), scope: .session)
            block(String(localized: "文件"), scope: .files)

            SettingsBlock("输入框") {
                SettingsShortcutRow(title: String(localized: "发送 / 排队"), keys: ["⌘", "↩"])
                SettingsShortcutRow(title: String(localized: "停止并发送"), keys: ["⇧", "⌘", "↩"])
            }

            Section {
                HStack {
                    Spacer()
                    SettingsActionButton("全部恢复默认") { store.resetAll(); notice = nil }
                        .disabled(!store.hasOverrides)
                }
            }

            SettingsScopeFooter()
        }
        .riffetForm()
        .onChange(of: recording) { _, id in
            monitor.stop()
            if let id { monitor.start { capture($0, for: id) } }
        }
        .onDisappear { monitor.stop(); recording = nil; notice = nil }
    }

    private func rows(_ scope: ShortcutScope) -> [ShortcutID] {
        ShortcutID.allCases.filter { $0.scope == scope && $0.customizable }
    }

    private func block(_ title: String, scope: ShortcutScope) -> some View {
        SettingsBlock(title) {
            ForEach(rows(scope)) { row($0) }
        }
    }

    private func row(_ id: ShortcutID) -> some View {
        let active = notice?.id == id ? notice : nil
        return SettingsRow(label(id), detail: active?.text) {
            HStack(spacing: Space.sm) {
                if let replace = active?.replace {
                    SettingsActionButton("替换") {
                        store.set(replace.other, chords: [])
                        store.set(id, chords: [replace.chord])
                        notice = nil
                    }
                    .controlSize(.small)
                }
                Button { notice = nil; recording = recording == id ? nil : id } label: {
                    Group {
                        if recording == id {
                            Text("按下新快捷键")
                                .font(RiffetFont.caption)
                                .foregroundStyle(palette.accent)
                        } else if let chord = store.chords(id).first {
                            SettingsKeycaps(keys: ShortcutChord.keycaps(chord))
                        } else {
                            Text("未设置")
                                .font(RiffetFont.caption)
                                .foregroundStyle(palette.fg3)
                        }
                    }
                    .padding(.horizontal, Space.xs)
                    .padding(.vertical, Space.xxs)
                }
                .buttonStyle(HoverRowStyle())
                .accessibilityLabel(label(id))
                if store.isOverridden(id) {
                    Button { store.reset(id); notice = nil } label: { Image(icon: "arrow.counterclockwise") }
                        .buttonStyle(IconButtonStyle(size: 24))
                        .help("恢复默认")
                        .accessibilityLabel("恢复默认")
                }
                if !store.chords(id).isEmpty {
                    Button { store.set(id, chords: []); notice = nil } label: { Image(icon: "xmark") }
                        .buttonStyle(IconButtonStyle(size: 24))
                        .help("清除")
                        .accessibilityLabel("清除")
                }
            }
        }
    }

    /// One key press while recording. Esc alone cancels.
    private func capture(_ event: NSEvent, for id: ShortcutID) -> Bool {
        if event.keyCode == 53, event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty {
            recording = nil
            return true
        }
        guard let chord = ShortcutChord.chord(from: event) else { return true }
        guard PluginKeybindings.parse(chord) != nil else {
            notice = Notice(id: id, text: String(localized: "需要 ⌘、⌃ 或 ⌥"))
            return true
        }
        switch store.conflict(chord, for: id) {
        case .reserved:
            notice = Notice(id: id, text: String(localized: "系统或标准菜单已占用"))
        case .taken(let other):
            notice = Notice(id: id, text: String(localized: "已用于「\(label(other))」"), replace: (chord, other))
        case nil:
            store.set(id, chords: [chord])
            notice = nil
        }
        recording = nil
        return true
    }

    private func label(_ id: ShortcutID) -> String {
        switch id {
        case .search: String(localized: "搜索")
        case .commandPalette: String(localized: "命令")
        case .toggleSidebar: String(localized: "显示/隐藏侧栏")
        case .toggleTerminal: String(localized: "显示/隐藏终端")
        case .newSession: String(localized: "新会话")
        case .searchContent: String(localized: "搜索内容")
        case .refresh: String(localized: "刷新")
        case .textBigger: String(localized: "放大")
        case .textSmaller: String(localized: "缩小")
        case .textReset: String(localized: "实际大小")
        case .toggleInspector: String(localized: "显示/隐藏检查器")
        case .showChanges: String(localized: "变更")
        case .showFiles: String(localized: "文件")
        case .inspectorFullscreen: String(localized: "检查器全屏")
        case .openMarks: WorkbenchPage.marks.title
        case .openTasks: WorkbenchPage.tasks.title
        case .openExtensions: WorkbenchPage.extensions.title
        case .openStats: WorkbenchPage.stats.title
        case .previousSession: String(localized: "上一个会话")
        case .nextSession: String(localized: "下一个会话")
        case .tabGoTo: String(localized: "切换到第 1–8 个标签")
        case .tabLast: String(localized: "最后一个标签")
        case .tabPrevious: String(localized: "上一个标签")
        case .tabNext: String(localized: "下一个标签")
        case .tabClose: String(localized: "关闭标签")
        case .tabReopen: String(localized: "重新打开关闭的标签")
        case .toggleChatTerminal: String(localized: "切换对话/终端视图")
        case .find: String(localized: "在会话中查找")
        case .findNext: String(localized: "查找下一个")
        case .findPrevious: String(localized: "查找上一个")
        case .interrupt: String(localized: "中断")
        case .openInNewWindow: String(localized: "在新窗口中打开")
        case .quickOpen: String(localized: "快速打开")
        case .quickPrompt: String(localized: "打开快速对话")
        }
    }
}

extension ShortcutID: Identifiable {
    var id: String { rawValue }
}

/// The local key-down monitor of a recording.
@MainActor
private final class KeyMonitor {
    private var token: Any?

    func start(_ handle: @escaping (NSEvent) -> Bool) {
        token = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { handle($0) ? nil : $0 }
    }

    func stop() {
        if let token { NSEvent.removeMonitor(token) }
        token = nil
    }
}
