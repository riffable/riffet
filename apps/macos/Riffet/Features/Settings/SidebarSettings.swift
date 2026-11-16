import SwiftUI
import RiffetKit

/// 侧栏: which pages are sidebar rows and in what order; the rest sit under the sidebar's 更多. Stored on the server.
struct SidebarSettings: View {
    @Environment(AppModel.self) private var model
    /// The order being saved, shown at once; nil once the newest save has settled.
    @State private var pending: [String]?
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        Form {
            if let workbench = model.workbench {
                let saved = pending ?? workbench.settings?.sidebarPinned
                let split = WorkbenchPage.split(saved: saved)
                if !split.pinned.isEmpty {
                    SettingsBlock("固定显示") {
                        SortableList(items: split.pinned, id: \.destinationId, title: \.title) { ids in
                            save(workbench, WorkbenchPage.reordered(saved: saved, shown: ids))
                        } row: { page, handle in
                            HStack(spacing: Space.sm) {
                                handle
                                row(page, pinned: true, workbench: workbench, saved: saved)
                            }
                        }
                    }
                }
                if !split.more.isEmpty {
                    SettingsBlock("更多") {
                        ForEach(split.more, id: \.self) { page in
                            row(page, pinned: false, workbench: workbench, saved: saved)
                        }
                    }
                }
                if let error { Section { SettingsErrorText(message: error) } }
            } else {
                Section { SettingsHint("连接服务器后可修改。") }
            }
            SettingsScopeFooter()
        }
        .riffetForm()
    }

    private func row(_ page: WorkbenchPage, pinned: Bool, workbench: Workbench, saved: [String]?) -> some View {
        SettingsRow(page.title) {
            Button {
                save(workbench, WorkbenchPage.toggled(saved: saved, page: page, pinned: !pinned))
            } label: {
                Image(icon: pinned ? "pin.fill" : "pin")
            }
            .buttonStyle(IconButtonStyle(active: pinned))
            .help(pinned ? "从侧栏移到更多" : "固定到侧栏")
            .accessibilityLabel(pinned ? "把\(page.title)移到更多" : "把\(page.title)固定到侧栏")
            .accessibilityAddTraits(pinned ? .isSelected : [])
        }
    }

    /// Shows [ids] now and saves behind it, one request at a time and the newest last, so an older response
    /// never overwrites a newer order. A failed save puts the stored order back and says why.
    private func save(_ workbench: Workbench, _ ids: [String]) {
        pending = ids
        error = nil
        guard !saving else { return }
        saving = true
        Task {
            var sent: [String]?
            do {
                while let next = pending, next != sent {
                    sent = next
                    try await SettingsStore.save(workbench, SettingsPatch.make(sidebarPinned: next))
                }
            } catch {
                self.error = error.riffetMessage
            }
            pending = nil
            saving = false
        }
    }
}
