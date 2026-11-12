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
            Form {
                Section {
                    SettingsHint("连接服务器后可修改。")
                }
                SettingsScopeFooter()
            }
            .riffetForm()
        }
    }

    private func form(_ workbench: Workbench) -> some View {
        let settings = workbench.settings
        let behavior = settings?.composerEnterBehavior == "send" ? "send" : "newline"
        let runningBehavior = settings?.composerRunningBehavior == "steer" ? "steer" : "queue"
        return Form {
            Section {
                // The other key, the one the reader cannot see from the choice itself.
                SettingsRow(String(localized: "Enter 键"), detail: behavior == "send" ? String(localized: "⇧↩ 换行") : String(localized: "⌘↩ 发送")) {
                    FormSegmented("Enter 键", selection: enterBinding(workbench, current: behavior)) {
                        Text("换行").tag("newline")
                        Text("发送").tag("send")
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

/// 快捷键: the global hotkey that opens quick chat, and the in-app shortcuts (fixed). This Mac's.
struct ShortcutSettings: View {
    var body: some View {
        Form {
            SettingsBlock("全局快捷键") {
                SettingsRow("打开快速对话") {
                    KeyboardShortcuts.Recorder(for: .quickPrompt)
                }
            }

            SettingsBlock("应用内快捷键") {
                SettingsShortcutRow(title: String(localized: "新会话"), keys: ["⌘", "N"])
                SettingsShortcutRow(title: String(localized: "发送 / 排队"), keys: ["⌘", "↩"])
                SettingsShortcutRow(title: String(localized: "停止并发送"), keys: ["⇧", "⌘", "↩"])
                SettingsShortcutRow(title: String(localized: "中断"), keys: ["⌘", "."])
                SettingsShortcutRow(title: String(localized: "搜索"), keys: ["⌘", "K"])
                SettingsShortcutRow(title: String(localized: "命令"), keys: ["⇧", "⌘", "P"])
                SettingsShortcutRow(title: String(localized: "终端"), keys: ["⌃", "`"])
            }

            SettingsScopeFooter()
        }
        .riffetForm()
    }
}
