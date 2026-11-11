import SwiftUI

enum DemoRoute: Hashable {
    case session(UUID, focusApproval: Bool)
    case newTask
    case settings
}

struct RiffetRootView: View {
    @State private var store = DemoStore(persist: !ProcessInfo.processInfo.arguments.contains("-ui-testing"))
    @State private var path: [DemoRoute] = []
    @AppStorage("demo.v2.appearance") private var appearance = "system"

    var body: some View {
        NavigationStack(path: $path) {
            SessionListView { projectID in
                if store.newTaskDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                   let projectID { store.newTaskProjectID = projectID }
                path.append(.newTask)
            }
                .navigationDestination(for: DemoRoute.self) { route in
                    switch route {
                    case let .session(id, focusApproval):
                        ConversationView(sessionID: id, focusApproval: focusApproval)
                    case .newTask:
                        NewTaskView { id in
                            // The editor becomes the conversation; Back returns directly to the list.
                            path[path.count - 1] = .session(id, focusApproval: false)
                        }
                    case .settings:
                        DemoSettingsView(appearance: $appearance)
                    }
                }
        }
        .environment(store)
        .tint(Color(uiColor: .systemBlue))
        .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
    }
}

private struct DemoSettingsView: View {
    @Environment(DemoStore.self) private var store
    @Binding var appearance: String
    @State private var confirmingReset = false

    var body: some View {
        Form {
            Section {
                Label("Mac Studio", systemImage: "desktopcomputer")
                LabeledContent("连接", value: "演示设备")
            } header: { Text("工作设备") } footer: {
                Text("项目与 Agent 实际运行在 Mac 上。这一版使用本地样例，不连接真实服务器。")
            }
            Section("外观") {
                Picker("显示模式", selection: $appearance) {
                    Text("跟随系统").tag("system")
                    Text("浅色").tag("light")
                    Text("深色").tag("dark")
                }
            }
            Section {
                LabeledContent("Riffet 2", value: "交互 Demo")
                Button("还原演示内容", role: .destructive) { confirmingReset = true }
            } header: { Text("演示") } footer: {
                Text("会话、审批、草稿和阅读位置只保存在本机。还原后可以重新体验待处理流程。")
            }
        }
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .bottomBar)
        .confirmationDialog("还原演示内容？", isPresented: $confirmingReset, titleVisibility: .visible) {
            Button("还原并清除本地草稿", role: .destructive) { store.resetDemo() }
        } message: {
            Text("将移除本 Demo 中新建的会话和草稿，并恢复初始样例。")
        }
    }
}

#Preview { RiffetRootView() }
