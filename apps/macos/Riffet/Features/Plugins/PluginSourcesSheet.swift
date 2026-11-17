import SwiftUI
import RiffetKit

/// The plugin indexes this server reads: switch one off, add an address, remove one that is not built in.
struct PluginSourcesSheet: View {
    let store: PluginManagementStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var address = ""
    @State private var removing: PluginSource?

    private var sources: [PluginSource] { store.marketList?.sources ?? [] }
    private var trimmed: String { address.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("插件源").font(.title3.weight(.semibold)).foregroundStyle(palette.fg)
                Spacer(minLength: Space.md)
                Button(action: { dismiss() }) { Image(icon: "xmark") }
                    .buttonStyle(IconButtonStyle(size: 26))
                    .help("关闭").accessibilityLabel("关闭").keyboardShortcut(.cancelAction)
            }.padding(Space.xl)
            Divider().overlay(palette.line)
            Form {
                Section {
                    ForEach(sources, id: \.id) { source in row(source) }
                }
                Section {
                    HStack(spacing: Space.md) {
                        TextField("插件源", text: $address, prompt: Text(verbatim: "https://"))
                            .labelsHidden().onSubmit(add)
                        Button("添加", action: add).disabled(trimmed.isEmpty || store.sourceBusy)
                    }
                    if let message = store.sourceError {
                        Text(message).font(.callout).foregroundStyle(palette.danger).textSelection(.enabled)
                    }
                }
            }
            .riffetForm()
            .scrollContentBackground(.hidden)
        }
        .frame(width: 520, height: 460)
        .background(palette.bg)
        .interactiveDismissDisabled(store.sourceBusy)
        .onAppear { store.sourceError = nil }
        .confirmationDialog("移除插件源？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            if let target = removing {
                Button("移除", role: .destructive) {
                    removing = nil
                    Task { await store.removeSource(target.id) }
                }
            }
            Button("取消", role: .cancel) { removing = nil }
        } message: { Text("已安装的插件保留，不再收到更新。") }
    }

    private func row(_ source: PluginSource) -> some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(PluginManagementStore.displayName(source)).font(.callout).foregroundStyle(palette.fg).lineLimit(1)
                Text(source.url).font(.caption).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.middle)
                if let error = source.error, source.enabled {
                    Text(error).font(.caption).foregroundStyle(palette.danger).lineLimit(2)
                } else if let count = source.plugins {
                    Text("\(Int(count.intValue)) 个插件").font(.caption).foregroundStyle(palette.fg3)
                }
            }
            Spacer(minLength: Space.md)
            if !source.builtin {
                Button { removing = source } label: { Image(icon: "trash") }
                    .buttonStyle(IconButtonStyle(size: 26))
                    .help("移除").accessibilityLabel("移除")
                    .disabled(store.sourceBusy)
            }
            Toggle(PluginManagementStore.displayName(source), isOn: Binding(
                get: { source.enabled },
                set: { value in Task { await store.setSource(source.id, enabled: value) } }
            ))
            .labelsHidden().toggleStyle(.switch).controlSize(.mini)
            .disabled(store.sourceBusy)
        }
    }

    private func add() {
        guard !trimmed.isEmpty, !store.sourceBusy else { return }
        Task { if await store.addSource(trimmed) { address = "" } }
    }
}
