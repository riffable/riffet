import SwiftUI
import RiffetKit

/// A deletion waiting for the reader's word: the conversation, what the server said it removes, and
/// how the confirmation is going.
@MainActor
@Observable
final class SessionDeletion: Identifiable {
    let session: Session
    var preview: SessionDeletionPreview
    var submitting = false
    var error: String?

    init(session: Session, preview: SessionDeletionPreview) {
        self.session = session
        self.preview = preview
    }
}

/// The deletion's confirmation, a sheet the workbench holds open: a failed delete stays in it.
private struct SessionDeletionDialog: ViewModifier {
    let workbench: Workbench

    func body(content: Content) -> some View {
        content
            .sheet(item: Binding(get: { workbench.deletion }, set: { workbench.deletion = $0 })) { request in
                SessionDeletionSheet(workbench: workbench, request: request)
            }
            .alert("操作失败", isPresented: Binding(get: { workbench.deletionError != nil }, set: { if !$0 { workbench.deletionError = nil } })) {
                Button("好") {}
            } message: { Text(workbench.deletionError ?? "") }
    }
}

extension View {
    func sessionDeletionDialog(_ workbench: Workbench) -> some View {
        modifier(SessionDeletionDialog(workbench: workbench))
    }
}

private struct SessionDeletionSheet: View {
    let workbench: Workbench
    let request: SessionDeletion
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        let effects = request.preview.effects
        VStack(alignment: .leading, spacing: Space.md) {
            Text("删除会话？").font(.riffet(size: S(16), weight: .semibold))
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("所有设备都会移除，无法恢复。项目文件和 CLI 历史保留。")
                if effects.discussions > 0 { Text("同时删除 \(Int(effects.discussions)) 个侧边聊天。") }
                if effects.schedules > 0 { Text("\(Int(effects.schedules)) 个定时计划继续运行。") }
            }
            .font(.riffet(size: S(13)))
            .foregroundStyle(palette.fg2)
            .fixedSize(horizontal: false, vertical: true)
            if let error = request.error {
                Text(error).font(.riffet(size: S(12))).foregroundStyle(palette.danger).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                    .disabled(request.submitting)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(SolidButtonStyle(kind: .secondary))
                Button("删除") { Task { await workbench.confirmDeletion(request) } }
                    .buttonStyle(SolidButtonStyle(kind: .danger))
                    .disabled(request.submitting)
            }
        }
        .padding(Space.xl)
        .frame(width: 420)
    }
}
