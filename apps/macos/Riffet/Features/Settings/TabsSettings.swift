import SwiftUI

/// 标签页: the session tab bar of the Riffet style, how conversations open into it, and its keys.
struct TabsSettings: View {
    var body: some View {
        @Bindable var prefs = SessionTabsPreferences.shared
        Form {
            Section {
                SettingsRow("标签样式") {
                    FormSegmented("标签样式", selection: $prefs.style) {
                        Text("标题栏").tag(SessionTabStyle.titleBar)
                        Text("关闭").tag(SessionTabStyle.off)
                    }
                    .labelsHidden()
                }

                SettingsRow("打开会话时") {
                    FormSegmented("打开会话时", selection: $prefs.openMode) {
                        Text("临时标签").tag(SessionTabOpenMode.preview)
                        Text("直接加入").tag(SessionTabOpenMode.keep)
                        Text("仅手动加入").tag(SessionTabOpenMode.manual)
                    }
                    .labelsHidden()
                    .disabled(prefs.style == .off)
                }
            }

            SettingsBlock("快捷键") {
                SettingsShortcutRow(title: String(localized: "切换到第 1–8 个标签"), keys: ["⌘", "1–8"])
                SettingsShortcutRow(title: String(localized: "最后一个标签"), keys: ["⌘", "9"])
                SettingsShortcutRow(title: String(localized: "上一个标签"), keys: ["⌃", "⇧", "⇥"])
                SettingsShortcutRow(title: String(localized: "下一个标签"), keys: ["⌃", "⇥"])
                SettingsShortcutRow(title: String(localized: "关闭标签"), keys: ["⌘", "W"])
                SettingsShortcutRow(title: String(localized: "重新打开关闭的标签"), keys: ["⇧", "⌘", "T"])
            }

            SettingsScopeFooter()
        }
        .riffetForm()
    }
}
