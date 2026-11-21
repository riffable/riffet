import SwiftUI

/// 标签页: the session tab bar of the Riffet style and how conversations open into it. Its keys are on 快捷键.
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
                    }
                    .labelsHidden()
                    .disabled(prefs.style == .off)
                }

                SettingsRow("新建会话时") {
                    FormSegmented("新建会话时", selection: Binding(
                        get: { prefs.openMode == .keep ? .keep : prefs.newMode },
                        set: { prefs.newMode = $0 }
                    )) {
                        Text("临时标签").tag(SessionTabNewMode.preview)
                        Text("直接加入").tag(SessionTabNewMode.keep)
                    }
                    .labelsHidden()
                    .disabled(prefs.style == .off || prefs.openMode == .keep)
                }
            }

            SettingsScopeFooter()
        }
        .riffetForm()
    }
}
