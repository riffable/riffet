import SwiftUI

/// What every page and settings pane that needs a server shows while there is none: a server tile,
/// one title, one button that takes the reader to the new-session page, where the setup card finishes
/// the connection (docs/design/system/patterns.md §1.5).
struct NeedsServerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: Space.lg) {
            Image(icon: "server.rack")
                .font(RiffetFont.body)
                .foregroundStyle(palette.fg2)
                .frame(width: 40, height: 40)
                .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
                .accessibilityHidden(true)
            Text("需要连接服务器")
                .font(RiffetFont.text(RiffetTextSize.base, weight: .medium))
                .foregroundStyle(palette.fg)
            Button("连接") { model.showSetup() }
                .buttonStyle(SolidButtonStyle(kind: .secondary))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.bottom, Space.xxl)
    }
}
