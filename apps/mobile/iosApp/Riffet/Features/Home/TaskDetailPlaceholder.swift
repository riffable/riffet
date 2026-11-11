import SwiftUI

/// The detail column of 任务 on a wide window before a session is open: the list beside it is the
/// next step, so the column only carries the mark.
struct TaskDetailPlaceholder: View {
    @Environment(\.palette) private var palette

    var body: some View {
        BrandMark(front: palette.fg3.opacity(0.22), back: palette.fg3.opacity(0.12))
            .frame(width: 56, height: 56)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(palette.bg)
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
    }
}
