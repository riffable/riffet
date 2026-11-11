import SwiftUI
import WebKit
import RiffetKit

/// A side-panel view a plugin draws with its web entry, in a web view of its own
/// (apps/web/src/plugins/isolated/IsolatedView.tsx is the web counterpart). It lives and dies with the
/// instance the context names: another server, project, conversation or instance is a new web view,
/// and the old bridge ends with its pending calls cancelled. `visible`, the language and the palette
/// change within an instance and arrive as pushes.
struct PluginWebView: View {
    let package: PluginWebPackage
    /// `<pluginId>/<name>`
    let viewId: String
    /// `single`, `per-session` or `per-project`
    let instances: String
    let workbench: Workbench
    let project: Project

    @Environment(\.inspectorPanelVisible) private var visible
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if let base = workbench.host.api?.baseUrl {
            let sessionId = workbench.showingHome ? nil : workbench.selected?.id
            let instanceId = instances == "per-session" ? "\(viewId):\(sessionId ?? "")" : instances == "per-project" ? "\(viewId):\(project.id)" : viewId
            let dark = colorScheme == .dark
            let colors = dark ? palette.values.dark : palette.values.light
            PluginPage(
                package: package, base: base, workbench: workbench,
                bridgeContext: PluginBridgeContext(serviceId: base, projectId: project.id, sessionId: sessionId, instanceId: instanceId, visible: visible, locale: AppLanguage.running.rawValue),
                theme: PluginBridgeTheme(scheme: dark ? "dark" : "light", vars: Dictionary(uniqueKeysWithValues: colors.roleValues().map { ("--" + $0.key, $0.value) })),
                background: palette.nsColor(\.bg)
            )
            .id([base, project.id, sessionId ?? "", instanceId, package.fingerprint].joined(separator: "|"))
        } else {
            ContentUnavailableView("加载失败", icon: "exclamationmark.triangle")
        }
    }
}

/// Compiles the content rules, then shows the web view; a page that cannot load shows the reason.
private struct PluginPage: View {
    let package: PluginWebPackage
    let base: String
    let workbench: Workbench
    let bridgeContext: PluginBridgeContext
    let theme: PluginBridgeTheme
    let background: NSColor

    @State private var rules: WKContentRuleList?
    @State private var failure: String?

    var body: some View {
        Group {
            if let failure {
                ContentUnavailableView {
                    Label("加载失败", icon: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                }
            } else if let rules {
                PluginWebHost(
                    package: package, base: base, rules: rules, bridgeContext: bridgeContext, theme: theme, background: background,
                    makeServices: { [package, workbench] context, theme in
                        WorkbenchPluginServices(workbench: workbench, base: base, package: package, context: context, theme: theme)
                    },
                    fetch: { try await PluginEntryFetcher.fetch($0) },
                    onFailure: { message in DispatchQueue.main.async { failure = message } }
                )
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            do { rules = try await PluginContentRules.list(network: package.network) } catch { failure = error.localizedDescription }
        }
    }
}
