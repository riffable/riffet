import SwiftUI

/// The side panel's views in the reader's order, each one shown or turned off (docs/design/plugin-system.md §4.1).
/// The list holds every view this Mac can draw, so a view that is off for the open project keeps its place.
struct InspectorViewsSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let workbench = model.workbench {
            let prefs = workbench.sidebarViewPrefs
            let views = workbench.configurableInspectorViews
            SettingsBlock("检查器") {
                ForEach(Array(views.enumerated()), id: \.element.id) { index, view in
                    SettingsRow(view.title) {
                        HStack(spacing: Space.xs) {
                            Button { move(views, index, -1, prefs) } label: { Image(icon: "chevron.up") }
                                .buttonStyle(IconButtonStyle())
                                .disabled(index == 0)
                                .help("上移")
                            Button { move(views, index, 1, prefs) } label: { Image(icon: "chevron.down") }
                                .buttonStyle(IconButtonStyle())
                                .disabled(index == views.count - 1)
                                .help("下移")
                            Toggle(view.title, isOn: Binding(get: { !prefs.isHidden(view.id) }, set: { prefs.setVisible(view.id, $0) }))
                                .labelsHidden()
                                .toggleStyle(.switch)
                        }
                    }
                }
            }
        }
    }

    private func move(_ views: [InspectorViewEntry], _ index: Int, _ delta: Int, _ prefs: SidebarViewPrefs) {
        var ids = views.map(\.id)
        ids.swapAt(index, index + delta)
        prefs.setOrder(ids)
    }
}
