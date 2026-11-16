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
                SortableList(items: views, id: \.id, title: \.title) { ids in
                    prefs.setOrder(ids)
                } row: { view, handle in
                    HStack(spacing: Space.sm) {
                        handle
                        SettingsRow(view.title) {
                            Toggle(view.title, isOn: Binding(get: { !prefs.isHidden(view.id) }, set: { prefs.setVisible(view.id, $0) }))
                                .labelsHidden()
                                .toggleStyle(.switch)
                        }
                    }
                }
            }
        }
    }
}
