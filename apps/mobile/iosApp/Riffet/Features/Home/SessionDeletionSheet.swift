import SwiftUI
import RiffetKit

/// The deletion's confirmation, a sheet the workbench holds open: a failed delete stays in it.
struct SessionDeletionSheet: View {
    let workbench: Workbench
    let request: SessionDeletion
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        let effects = request.preview.effects
        VStack(alignment: .leading, spacing: 12) {
            Text("删除会话？").font(.headline).foregroundStyle(palette.fg)
            VStack(alignment: .leading, spacing: 6) {
                Text("所有设备都会移除，无法恢复。项目文件和 CLI 历史保留。")
                if effects.discussions > 0 { Text("同时删除 \(Int(effects.discussions)) 个侧边聊天。") }
                if effects.schedules > 0 { Text("\(Int(effects.schedules)) 个定时计划继续运行。") }
            }
            .font(.subheadline).foregroundStyle(palette.fg2)
            if let error = request.error {
                Text(error).font(.footnote).foregroundStyle(palette.danger)
            }
            Spacer(minLength: 0)
            HStack(spacing: 12) {
                Button { dismiss() } label: { Text("取消").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).keyboardShortcut(.defaultAction).disabled(request.submitting)
                Button(role: .destructive) { Task { await workbench.confirmDeletion(request) } } label: { Text("删除").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).disabled(request.submitting)
            }
            .controlSize(.large)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .presentationDetents([.height(260 + (effects.discussions > 0 ? 24 : 0) + (effects.schedules > 0 ? 24 : 0))])
        // A wide window shows a form sheet and ignores detents; it fits the content instead.
        .presentationSizing(.form.fitted(horizontal: false, vertical: true))
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(request.submitting)
    }
}
