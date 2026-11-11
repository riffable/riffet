import SwiftUI

struct NewTaskView: View {
    @Environment(DemoStore.self) private var store
    @FocusState private var writing: Bool
    @State private var failedToStart = false
    let onStart: (UUID) -> Void

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                Text("在 Mac Studio 上开始").font(.subheadline).foregroundStyle(.secondary)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 18) { contextMenus }
                    VStack(alignment: .leading, spacing: 4) { contextMenus }
                }
            }
            .padding(.horizontal, 22).padding(.top, 18).padding(.bottom, 14)
            Divider().padding(.horizontal, 22)
            ZStack(alignment: .topLeading) {
                if store.newTaskDraft.isEmpty {
                    Text("描述你想完成的事…")
                        .font(.body).foregroundStyle(.tertiary)
                        .padding(.horizontal, 27).padding(.top, 23)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $store.newTaskDraft)
                    .font(.body).scrollContentBackground(.hidden)
                    .padding(.horizontal, 22).padding(.top, 15)
                    .focused($writing)
                    .accessibilityLabel("任务内容")
                    .accessibilityIdentifier("newTaskText")
            }
            .frame(maxHeight: .infinity)
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle("新任务").navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .bottomBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: 12) {
                Text("草稿自动保留").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Button(action: start) {
                    Label("开始任务", systemImage: "arrow.up")
                        .font(.body.weight(.semibold))
                        .padding(.horizontal, 18).frame(minHeight: 46)
                }
                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                .disabled(store.newTaskDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("startTask")
            }
            .padding(.horizontal, 22).padding(.vertical, 10).background(.bar)
        }
        .task { writing = true }
        .alert("未能开始任务", isPresented: $failedToStart) {
            Button("继续编辑", role: .cancel) {}
        } message: { Text("检查项目选择后重试，输入内容已保留。") }
    }

    @ViewBuilder private var contextMenus: some View {
        @Bindable var store = store
        Menu {
            Picker("项目", selection: $store.newTaskProjectID) {
                ForEach(store.projects) { Text($0.name).tag($0.id) }
            }
        } label: {
            Label(store.project(store.newTaskProjectID).name, systemImage: "folder")
                .font(.subheadline.weight(.medium)).frame(minHeight: 44)
        }
        .accessibilityLabel("项目：\(store.project(store.newTaskProjectID).name)")
        Menu {
            Picker("Agent", selection: $store.newTaskAgent) {
                ForEach(["Codex", "Claude Code", "Cursor"], id: \.self) { Text($0).tag($0) }
            }
        } label: {
            HStack(spacing: 6) {
                Text(store.newTaskAgent)
                Image(systemName: "chevron.down").font(.caption2)
            }
            .font(.subheadline.weight(.medium)).frame(minHeight: 44)
        }
        .accessibilityLabel("Agent：\(store.newTaskAgent)")
    }

    private func start() {
        guard let id = store.startTask(text: store.newTaskDraft, projectID: store.newTaskProjectID, agent: store.newTaskAgent) else {
            failedToStart = true
            return
        }
        writing = false
        onStart(id)
    }
}
