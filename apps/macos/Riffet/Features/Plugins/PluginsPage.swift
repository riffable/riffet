import AppKit
import SwiftUI
import RiffetKit

struct PluginsPage: View {
    let workbench: Workbench
    private let store: PluginManagementStore
    @Environment(\.palette) private var palette
    @Environment(\.openSettings) private var openSettings
    @State private var selection: PluginDescriptor?
    @State private var deletingData = false
    @State private var force = false
    @State private var recoveryConfirm = false
    @State private var flow: PluginAction?
    @State private var installing = false
    @State private var rereading = false
    @State private var collapsing = false
    @State private var removing: PluginDescriptor?
    @State private var detailTab = "overview"
    @State private var configurationPage = ""
    @State private var pendingDetailTab: String?
    @State private var pendingConfigurationPage: String?
    @State private var browsing = false
    @State private var browsed: PluginMarketEntry?

    init(workbench: Workbench) { self.workbench = workbench; store = workbench.pageModels.plugins }
    private var visible: [PluginDescriptor] {
        store.items.filter { item in
            // Remote state changes must not filter out a live editor or operation.
            if (store.dirty || store.busy) && item.managementKey == store.selected?.managementKey { return true }
            return (store.query.isEmpty || (item.displayTitle + " " + item.id).localizedCaseInsensitiveContains(store.query)) &&
            (store.filter == "all" || store.filter == "enabled" && item.enabled || store.filter == "disabled" && !item.enabled || store.filter == "attention" && (item.rejected || item.stopping != nil || item.status?.state == "unavailable" || item.status?.state == "attention"))
        }
    }
    var body: some View {
        Form {
            Section {
                SegmentedTrack(selection: $browsing) {
                    Text("已安装").tag(false)
                    Text("浏览").tag(true)
                }
                .accessibilityLabel("插件").frame(maxWidth: .infinity, alignment: .leading)
                .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
            }
            if browsing { browseContent } else { installedContent }
        }
        .riffetForm()
        .scrollContentBackground(.hidden)
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity)
        .navigationTitle("插件")
        .pageChrome(.plugins, workbench: workbench, search: PageSearch(
            text: Binding(get: { store.query }, set: { store.query = $0; store.collapse() }),
            prompt: String(localized: "搜索插件")
        )) {
            PageMenuButton(symbol: store.filter == "all" ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill", help: String(localized: "筛选"), build: filterMenu)
                .disabled(store.busy || store.dirty || browsing)
            PageActionButton(title: String(localized: "安装"), symbol: "plus") {
                if store.dirty { installing = true } else { Task { await store.choosePackage() } }
            }
            .disabled(store.busy || !store.connected)
            PageMenuButton(symbol: "ellipsis", help: String(localized: "更多"), build: moreMenu)
                .disabled(store.busy || store.dirty || !store.connected)
        }
        .task(id: workbench.host.api?.baseUrl) {
            await store.connect(workbench.host.api)
            if browsing { await store.loadMarket() }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                if !store.busy { await store.refresh() }
            }
        }
        .onChange(of: browsing) { _, on in
            guard on, store.marketList == nil, !store.marketLoading else { return }
            Task { await store.loadMarket() }
        }
        .sheet(isPresented: managementPresentation) {
            if store.grant != nil { grantSheet } else { inspectorSheet }
        }
        .sheet(isPresented: Binding(get: { browsed != nil && store.grant == nil }, set: { if !$0 { browsed = nil } })) {
            if let entry = browsed { marketDetail(entry) }
        }
        .confirmationDialog("暂停所有外部插件？", isPresented: $recoveryConfirm, titleVisibility: .visible) {
            Button("暂停") { Task { await store.setRecovery(true) } }
        } message: { Text("保留原启用策略，可随时恢复") }
    }

    @ViewBuilder private var installedContent: some View {
        Group {
            if store.recovery {
                Section {
                    HStack {
                        Text("外部插件已暂停").foregroundStyle(palette.fg2)
                        Spacer(minLength: Space.md)
                        Button("恢复原启用策略") { Task { await store.setRecovery(false) } }.disabled(store.busy || store.dirty || !store.connected)
                    }
                }
            }
            if store.error != nil { Section { errorNotice } }
            if store.loading && store.items.isEmpty {
                Section { Spinner(size: .small).frame(maxWidth: .infinity) }
            } else if visible.isEmpty {
                Section {
                    Text(store.connected ? String(localized: "没有匹配的插件") : String(localized: "未连接"))
                        .foregroundStyle(palette.fg3)
                        .frame(maxWidth: .infinity)
                }
            }
            let groups = Self.groups.filter { group in visible.contains { groupOf($0) == group } }
            ForEach(groups, id: \.self) { group in
                Section {
                    ForEach(visible.filter { groupOf($0) == group }, id: \.managementKey) { item in
                        PluginRow(item: item, busy: store.busy, open: { select(item) }) {
                            if !item.rejected {
                                Toggle(item.displayTitle, isOn: Binding(get: { item.enabled }, set: { value in Task { await store.enable(value ? "on" : "off", plugin: item) } }))
                                    .labelsHidden().toggleStyle(.switch).controlSize(.mini)
                                    .disabled(store.busy || store.dirty || !store.connected || item.stopping != nil)
                            }
                        }
                    }
                } header: {
                    Text(groupTitle(group))
                } footer: {
                    if group == groups.last, let host = serverName {
                        Text("安装和启停影响连接 \(host) 的所有客户端")
                    }
                }
            }
        }
    }

    private var inspectedPlugin: PluginDescriptor? {
        if store.dirty || store.busy, let baseline = store.baseline,
           PluginManagementStore.key(baseline) == store.selectedID || baseline.id == store.selectedID {
            return baseline
        }
        return store.selected
    }

    private var managementPresentation: Binding<Bool> {
        Binding(get: { store.grant != nil || inspectedPlugin != nil }, set: { presented in
            guard !presented else { return }
            if store.grant != nil { if !store.busy { store.cancelInstall() } }
            else { closeInspector() }
        })
    }

    private var inspectorSheet: some View {
        let visible = (WorkbenchWindows.window(of: workbench)?.screen ?? NSScreen.main)?.visibleFrame.size
            ?? CGSize(width: 1280, height: 900)
        return VStack(spacing: 0) {
            if let item = inspectedPlugin {
                HStack(spacing: Space.md) {
                    PluginIcon(item: item, size: 36)
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text(item.displayTitle).font(.title3.weight(.semibold)).foregroundStyle(palette.fg)
                            .lineLimit(1).truncationMode(.middle)
                        Text([item.version.flatMap { $0.isEmpty ? nil : "v" + $0 }, source(item), status(item)]
                            .compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(palette.fg3)
                    }
                    Spacer(minLength: Space.md)
                    Button(action: closeInspector) { Image(icon: "xmark").font(.riffet(size: S(11), weight: .semibold)) }
                        .buttonStyle(IconButtonStyle(size: 26))
                        .help("关闭").accessibilityLabel("关闭")
                        .keyboardShortcut(.cancelAction).disabled(store.busy)
                }.padding(Space.xl)
                SegmentedTrack(selection: Binding(get: { shownTab(item) }, set: { selectDetailTab($0) })) {
                    Text("介绍").tag("overview")
                    if Self.hasPage(item) { Text(pageTitle(item)).tag("page") }
                    Text("管理").tag("management")
                }
                .accessibilityLabel("插件详情").disabled(store.busy)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Space.xl).padding(.bottom, Space.lg)
                Divider().overlay(palette.line)
                if shownTab(item) == "page", item.declared?.page != nil, item.enabled, store.selected != nil, let api = store.client {
                    // The plugin's own page is a settings form of its own, scrolling as one.
                    PluginPageForm(api: api, plugin: item, disabled: store.busy || !store.connected) { Task { await store.refresh() } }
                        .id(item.managementKey)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Space.lg) {
                            errorNotice
                            if store.dirty && (store.selected == nil || store.selected?.rejected == true) {
                                Text("插件已不可用，当前内容会保留到关闭").font(.callout).foregroundStyle(palette.fg3)
                            }
                            detail(item)
                        }
                        .padding(Space.xl)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }.id(item.managementKey + ":" + shownTab(item))
                }
            }
        }
        .frame(width: min(760, visible.width - 64), height: min(720, visible.height - 112))
        .background(palette.bg)
        .interactiveDismissDisabled(store.dirty || store.busy)
        .background(SheetOutsideClick { closeInspector() })
        .confirmationDialog("放弃未保存的配置？", isPresented: Binding(get: { selection != nil || installing || rereading || collapsing || pendingDetailTab != nil || pendingConfigurationPage != nil }, set: { if !$0 { cancelPendingChange() } }), titleVisibility: .visible) {
            Button("放弃修改", role: .destructive) {
                store.discard()
                if let selected = selection { store.select(selected); configurationPage = "" }
                if let tab = pendingDetailTab { detailTab = tab }
                if let page = pendingConfigurationPage { configurationPage = page }
                if collapsing { store.collapse(); detailTab = "overview"; configurationPage = "" }
                if installing { Task { await store.choosePackage() } }
                if rereading { Task { await store.refresh() } }
                cancelPendingChange()
            }
            Button("取消", role: .cancel) { cancelPendingChange() }
        }
        .confirmationDialog("删除插件数据？", isPresented: $deletingData, titleVisibility: .visible) {
            Button("删除", role: .destructive) { Task { await store.deleteData() } }
        } message: { Text("删除后无法恢复") }
        .confirmationDialog("卸载插件？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            if let target = removing {
                Button("卸载插件", role: .destructive) {
                    removing = nil
                    Task { await store.remove(target) }
                }
            }
            Button("取消", role: .cancel) { removing = nil }
        } message: {
            Text(removing?.source == "development" ? String(localized: "源目录、设置和数据会保留") : String(localized: "设置和数据会保留"))
        }
        .confirmationDialog("立即停用或切换版本？", isPresented: $force, titleVisibility: .visible) {
            Button("继续") { Task { await store.enable(store.selected?.enablement ?? "auto", force: true) } }
        } message: { Text("运行中的任务会继续，插件功能立即撤下") }
        .sheet(isPresented: Binding(get: { flow != nil }, set: { if !$0 { flow = nil } })) {
            if let action = flow, let plugin = store.selected {
                PluginFlowSheet(workbench: workbench, pluginId: plugin.id, action: action) { Task { await store.refresh() } }
            }
        }
    }

    private func closeInspector() {
        guard !store.busy else { return }
        if store.dirty { collapsing = true }
        else { store.collapse(); detailTab = "overview"; configurationPage = "" }
    }

    /// Whether the plugin has a page of its own: one it builds, its settings, a settings view for the Mac or a sign-in.
    static func hasPage(_ item: PluginDescriptor) -> Bool {
        item.declared?.page != nil || !item.settings.isEmpty
            || item.declared?.views?.contains { $0.locations.contains("settings") && $0.clients.contains("macos") } == true
            || ((item.declared?.actions ?? []) + item.actions).contains { $0.kind == "device-flow" }
    }

    private func pageTitle(_ item: PluginDescriptor) -> String {
        localizedText(item.declared?.page?.title, fallback: String(localized: "设置"))
    }

    private func shownTab(_ item: PluginDescriptor) -> String {
        detailTab == "page" && !Self.hasPage(item) ? "overview" : detailTab
    }

    private func selectDetailTab(_ tab: String) {
        guard !store.busy, tab != detailTab else { return }
        if store.dirty { pendingDetailTab = tab } else { detailTab = tab }
    }

    private func selectConfigurationPage(_ page: String) {
        guard !store.busy, page != configurationPage else { return }
        if store.dirty { pendingConfigurationPage = page } else { configurationPage = page }
    }

    private func cancelPendingChange() {
        selection = nil; installing = false; rereading = false; collapsing = false
        pendingDetailTab = nil; pendingConfigurationPage = nil
    }

    @ViewBuilder private var errorNotice: some View {
        if let error = store.error {
            HStack(alignment: .top) {
                Text(error).font(.callout).foregroundStyle(palette.danger).textSelection(.enabled)
                Spacer()
                Button("重新读取") { if store.dirty { rereading = true } else { Task { await store.refresh() } } }.disabled(store.busy)
            }
        }
    }

    private static let groups = ["agents", "workbench", "services"]

    /// The server the switches act on, as the footnote names it.
    private var serverName: String? {
        guard let base = workbench.host.api?.baseUrl, let url = URL(string: base), let host = url.host() else { return nil }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    private func filterMenu() -> NSMenu {
        let menu = NSMenu()
        let options: [(String, String)] = [
            ("all", String(localized: "全部")), ("enabled", String(localized: "已启用")),
            ("disabled", String(localized: "已停用")), ("attention", String(localized: "异常")),
        ]
        for (value, title) in options {
            let item = MenuAction.item(title) { store.filter = value; store.collapse() }
            item.state = store.filter == value ? .on : .off
            menu.addItem(item)
        }
        return menu
    }

    private func moreMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(MenuAction.item(String(localized: "重新检测"), symbol: "arrow.clockwise") {
            Task { await store.refresh(detect: true); if browsing { await store.loadMarket() } }
        })
        menu.addItem(.separator())
        if store.recovery {
            menu.addItem(MenuAction.item(String(localized: "恢复原启用策略")) { Task { await store.setRecovery(false) } })
        } else {
            menu.addItem(MenuAction.item(String(localized: "暂停所有外部插件")) { recoveryConfirm = true })
        }
        return menu
    }

    private func select(_ item: PluginDescriptor, tab: String = "overview") {
        guard !store.busy else { return }
        guard store.selected?.managementKey != item.managementKey else { return }
        if store.dirty { selection = item; pendingDetailTab = tab }
        else { store.select(item); detailTab = tab; configurationPage = "" }
    }

    @ViewBuilder private func detail(_ item: PluginDescriptor) -> some View {
        switch shownTab(item) {
        case "page": configuration(item)
        case "management":
            // Both rare: one tab, diagnostics below.
            management(item)
            Divider()
            Text("诊断").font(.callout.weight(.medium))
            diagnostics(item)
        default: overview(item)
        }
    }

    @ViewBuilder private func overview(_ item: PluginDescriptor) -> some View {
        let readme = store.readmes[PluginManagementStore.readmeKey(item)]
        if let readme, !readme.isEmpty {
            MarkdownView(source: readme).frame(maxWidth: .infinity, alignment: .leading)
        } else if readme == nil && !item.rejected {
            Spinner(size: .small).frame(maxWidth: .infinity)
        } else {
            let description = localizedText(item.description_, fallback: "")
            if !description.isEmpty { Text(description).font(.callout).foregroundStyle(palette.fg3).textSelection(.enabled) }
        }
        features(item)
            .task(id: PluginManagementStore.readmeKey(item)) { await store.loadReadme(item) }
    }

    @ViewBuilder private func management(_ item: PluginDescriptor) -> some View {
        HStack {
            if item.source == "installed" || item.source == "development" {
                Button("卸载插件", role: .destructive) { removing = item }
                    .buttonStyle(.bordered)
                    .disabled(store.busy || store.dirty || !store.connected || store.selected == nil || !PluginManagementStore.canRemove(item))
            } else {
                Text("内置插件不可卸载").font(.caption).foregroundStyle(palette.fg3)
            }
            Spacer()
        }
        VStack(alignment: .leading, spacing: Space.sm) {
            LabeledContent("发布者") { Text(item.vendor).foregroundStyle(palette.fg) }
            if let version = item.version, !version.isEmpty {
                LabeledContent("版本") { Text(version).foregroundStyle(palette.fg) }
            }
            LabeledContent("来源") { Text(source(item)).foregroundStyle(palette.fg) }
            LabeledContent("插件 ID") { Text(item.id).foregroundStyle(palette.fg) }
        }.font(.callout).foregroundStyle(palette.fg3).textSelection(.enabled)
        if !item.rejected {
            Picker("启用策略", selection: Binding(get: { item.enablement }, set: { value in Task { await store.enable(value) } })) {
                Text("自动").tag("auto"); Text("开启").tag("on"); Text("关闭").tag("off")
            }.disabled(store.busy || store.dirty || !store.connected || store.selected == nil)
        }
        versions(item)
        Divider()
        if let capabilities = item.capabilities, !capabilities.isEmpty {
            Text("权限").font(.callout.weight(.medium))
            ForEach(capabilities, id: \.self) { value in
                Text(capability(value)).font(.callout)
                if value == "models.provide" { modelSourceNote(item.declared?.modelSources?.map(\.hosts) ?? []) }
                if value == "process.exec" { executableNote(item.executables ?? []) }
            }
        }
        if item.source == "development" || item.installed?.versions.contains(where: { $0.selected && $0.trusted }) == true {
            Text("以服务器进程的权限运行").font(.caption).foregroundStyle(palette.fg3)
        }
        Text("安装和启停影响连接这台服务器的所有客户端").font(.caption).foregroundStyle(palette.fg3)
    }

    @ViewBuilder private func diagnostics(_ item: PluginDescriptor) -> some View {
        if let activation = item.activation {
            LabeledContent("激活状态") {
                switch activation.state {
                case "idle": Text("按需加载")
                case "activating": Text("加载中")
                case "active": Text("已加载")
                case "failed": Text("加载失败")
                default: Text(activation.state)
                }
            }.font(.callout).foregroundStyle(palette.fg3)
        }
        if let message = item.status?.message { Text(message).font(.callout).foregroundStyle(palette.fg3).textSelection(.enabled) }
        if let execution = item.execution {
            Text("server · " + execution.platform + " · " + execution.mode).font(.caption.monospaced()).foregroundStyle(palette.fg3)
        }
        if item.compatibility?.server?.ok == false { Text("服务器版本不兼容") }
        if item.compatibility?.web?.ok == false { Text("客户端视图版本不兼容") }
        ForEach(item.requires ?? [], id: \.id) { requirement in
            Button(requirement.id) {
                if let plugin = store.items.first(where: { $0.id == requirement.id }) {
                    store.query = ""; store.filter = "all"
                    select(plugin)
                }
            }.disabled(store.busy)
        }
        HStack(spacing: Space.md) {
            Button("运行诊断") { Task { await store.diagnose() } }.disabled(store.busy || !store.connected || store.selected == nil)
            Button("日志") { Task { await store.readLogs() } }.disabled(store.busy || !store.connected || store.selected == nil)
            if !item.rejected {
                Button("重载插件") { Task { await store.reload() } }.disabled(store.busy || store.dirty || !store.connected || store.selected == nil)
            }
            if item.stopping != nil {
                Button("立即处理") { force = true }.disabled(store.busy || store.dirty || !store.connected || store.selected == nil)
            }
        }
        ForEach(Array(store.diagnostics.enumerated()), id: \.offset) { _, check in
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(check.label).fontWeight(.medium)
                Text(check.detail).foregroundStyle(palette.fg3).textSelection(.enabled)
                if let fix = check.fix { Text(fix).foregroundStyle(palette.fg3).textSelection(.enabled) }
            }
        }
        if !store.logs.isEmpty {
            ScrollView {
                Text(store.logs.map { "\($0.at) \($0.version ?? "") #\($0.generation) \($0.level) \($0.phase) \($0.message)" }.joined(separator: "\n"))
                    .font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 220)
        }
    }

    private func configuration(_ item: PluginDescriptor) -> some View {
        let pages = item.declared?.views?.filter { $0.locations.contains("settings") && $0.clients.contains("macos") } ?? []
        let page = pages.first(where: { $0.id == configurationPage }) ?? pages.first
        let declaredActions = item.declared?.actions ?? []
        let actions = (declaredActions + item.actions.filter { action in !declaredActions.contains { $0.id == action.id } })
            .filter { $0.kind == "device-flow" }
        let generic = item.declared?.page == nil
        return VStack(alignment: .leading, spacing: Space.md) {
            if !generic {
                // Shown here only while the plugin is off: when on, the page replaces this view.
                Text("启用插件后可用").foregroundStyle(palette.fg3)
                Button("启用插件") { Task { await store.enable("on") } }
                    .disabled(store.busy || store.dirty || !store.connected || store.selected == nil || item.rejected || item.stopping != nil)
            }
            ForEach(generic ? item.settings : [], id: \.key) { field in
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(field.label).font(.callout.weight(.medium))
                    HStack {
                        let value = Binding(get: { store.draft[field.key] ?? store.baseline?.settings.first(where: { $0.key == field.key })?.value ?? "" }, set: { store.draft[field.key] = $0 })
                        if field.kind == "secret" {
                            SecureField(field.set?.boolValue == true ? String(localized: "已设置") : "", text: value)
                            if field.set?.boolValue == true { Button("清除") { store.draft[field.key] = "" } }
                        } else { TextField("", text: value) }
                    }.textFieldStyle(.roundedBorder).disabled(store.busy)
                }
            }
            if generic && !item.settings.isEmpty {
                HStack {
                    Button("保存") { Task { await store.save() } }.disabled(!store.dirty || store.busy || !store.connected || store.selected == nil || store.selected?.rejected == true)
                    Button("取消") { store.discard() }.disabled(!store.dirty || store.busy || !store.connected)
                }
            }
            if pages.count > 1 {
                SegmentedTrack(selection: Binding(get: { page?.id ?? "" }, set: { if $0 != page?.id { selectConfigurationPage($0) } })) {
                    ForEach(pages, id: \.id) { view in Text(localizedText(view.title, fallback: view.id)).tag(view.id) }
                }.accessibilityLabel("配置页面").disabled(store.busy)
            }
            if let page {
                if !item.enabled { Text("启用插件后可打开专用配置").foregroundStyle(palette.fg3) }
                else if let content = PluginAgentRegistry.configuration(page.id, workbench: workbench) { content.id(page.id).disabled(store.selected == nil || store.selected?.rejected == true || store.selected?.enabled == false) }
                else { Text("此配置在当前客户端不可用").font(.callout).foregroundStyle(palette.fg3) }
            }
            ForEach(actions, id: \.id) { action in
                Button(action.label) { flow = action }.disabled(store.busy || store.selected == nil || !item.enabled || !item.actions.contains { $0.id == action.id })
            }

        }
    }

    @ViewBuilder private func versions(_ item: PluginDescriptor) -> some View {
        if let installed = item.installed {
            ForEach(installed.versions, id: \.version) { version in
                HStack {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text(version.version)
                        Text(version.source).font(.caption).foregroundStyle(palette.fg3).textSelection(.enabled)
                        if version.trusted { Text("以服务器进程的权限运行").font(.caption).foregroundStyle(palette.fg3) }
                    }
                    Spacer()
                    if version.selected && !item.rejected { Text("使用中").foregroundStyle(palette.fg3) }
                    else { Button("使用") { Task { await store.selectVersion(version.version) } } }
                    if !version.selected || installed.versions.count == 1 { Button("卸载") { Task { await store.uninstall(version.version) } } }
                }.disabled(store.busy || store.dirty || !store.connected || store.selected == nil)
                Divider()
            }
            if installed.hasData { Button("删除数据", role: .destructive) { deletingData = true }.disabled(store.busy || store.dirty || !store.connected || store.selected == nil) }
        } else { Text(item.source == "development" ? String(localized: "开发包随源码更新") : String(localized: "版本随 Riffet 更新")).foregroundStyle(palette.fg3) }
    }

    @ViewBuilder private func features(_ item: PluginDescriptor) -> some View {
        let declared = item.declared
        let views = (declared?.views ?? []).filter { !$0.locations.contains("settings") }
        let declaredActions = declared?.actions ?? []
        let actions = (declaredActions + item.actions.filter { action in !declaredActions.contains { $0.id == action.id } })
            .filter { $0.kind == "run" }
        if let agents = declared?.agentBackends, !agents.isEmpty {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("Agent").font(.callout.weight(.medium))
                ForEach(agents, id: \.id) { agent in Text(localizedText(agent.title, fallback: agent.id)).font(.callout) }
            }
        }
        if declared?.modelSources?.isEmpty == false || !item.contributes.modelSources.isEmpty {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("模型源").font(.callout.weight(.medium))
                if let sources = declared?.modelSources, !sources.isEmpty {
                    ForEach(sources, id: \.id) { source in Text(localizedText(source.title, fallback: source.id)).font(.callout) }
                } else {
                    ForEach(item.contributes.modelSources, id: \.id) { source in Text(source.label).font(.callout) }
                }
            }
        }
        if declared?.modelSources?.isEmpty == false || !item.contributes.modelSources.isEmpty || declared?.agentBackends?.isEmpty == false {
            Button("模型与 Agent") { UserDefaults.standard.set(SettingsSection.agents.rawValue, forKey: PreferenceKey.settingsSection); openSettings() }
        }
        if !views.isEmpty {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("视图").font(.callout.weight(.medium))
                ForEach(views, id: \.id) { view in
                    HStack {
                        Text(localizedText(view.title, fallback: view.id)); Spacer()
                        if view.locations.contains("sidebar") {
                            Button("打开") { workbench.page = nil; workbench.showInspector(InspectorTab(rawValue: view.id)) }
                                .disabled(!item.enabled || item.stopping != nil || workbench.currentProject == nil || !workbench.inspectorViews.contains { $0.id == view.id })
                        }
                    }
                }
            }
        }
        if let commands = declared?.commands, !commands.isEmpty {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("命令").font(.callout.weight(.medium))
                ForEach(commands, id: \.id) { command in
                    HStack {
                        Text(localizedText(command.title, fallback: command.id)); Spacer()
                        if let key = command.keybinding {
                            let rejected = PluginKeybindings.resolve(workbench.plugins).rejected.contains(command.id)
                            Text(key).font(.caption).foregroundStyle(palette.fg3)
                                .opacity(rejected ? 0.5 : 1).strikethrough(rejected)
                                .help(rejected ? "快捷键未生效" : "")
                        }
                        Button("运行") {
                            if let command = workbench.pluginCommandList.first(where: { $0.id == command.id }) { workbench.pluginCommands.run(command, in: workbench) }
                        }.disabled(!workbench.pluginCommandList.contains { $0.id == command.id } || store.busy)
                    }
                }
            }
        }
        if let tasks = declared?.tasks, !tasks.isEmpty {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("任务").font(.callout.weight(.medium))
                ForEach(tasks, id: \.id) { task in Text(localizedText(task.title, fallback: task.id)).font(.callout) }
            }
        }
        if let appearance = declared?.appearance {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("外观").font(.callout.weight(.medium))
                ForEach(Array((appearance.palettes + appearance.fonts + appearance.backgrounds + appearance.presets).enumerated()), id: \.offset) { _, entry in
                    Text(localizedText(entry.title, fallback: entry.id)).font(.callout)
                }
                Button("选择外观") { UserDefaults.standard.set(SettingsSection.appearance.rawValue, forKey: PreferenceKey.settingsSection); openSettings() }
            }
        }
        if declared?.sharePublisher != nil || item.contributes.sharePublisher != nil {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("分享").font(.callout.weight(.medium))
                Text(localizedText(declared?.sharePublisher?.title, fallback: item.contributes.sharePublisher?.label ?? item.displayTitle)).font(.callout)
            }
        }
        ForEach(actions, id: \.id) { action in
            Button(action.label) { flow = action }.disabled(store.busy || store.selected == nil || !item.enabled || !item.actions.contains { $0.id == action.id })
        }
    }
    private var browseEntries: [PluginMarketEntry] {
        (store.marketList?.plugins ?? []).filter {
            store.query.isEmpty || (marketTitle($0) + " " + $0.id + " " + $0.vendor).localizedCaseInsensitiveContains(store.query)
        }
    }

    @ViewBuilder private var browseContent: some View {
        if let message = store.marketError {
            Section {
                HStack(alignment: .center, spacing: Space.md) {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text("无法读取插件目录").font(.callout).foregroundStyle(palette.fg)
                        Text(message).font(.caption).foregroundStyle(palette.fg3).textSelection(.enabled)
                    }
                    Spacer()
                    Button("重试") { Task { await store.loadMarket() } }.disabled(store.marketLoading)
                }
            }
        }
        if store.marketLoading && store.marketList == nil {
            Section { Spinner(size: .small).frame(maxWidth: .infinity) }
        } else if browseEntries.isEmpty && store.marketError == nil {
            Section {
                Text(store.connected ? String(localized: "没有匹配的插件") : String(localized: "未连接"))
                    .foregroundStyle(palette.fg3).frame(maxWidth: .infinity)
            }
        }
        if !browseEntries.isEmpty {
            Section {
                ForEach(browseEntries, id: \.id) { entry in
                    MarketRow(entry: entry, title: marketTitle(entry), open: { browsed = entry }) { marketAction(entry) }
                }
            }
        }
    }

    @ViewBuilder private func marketAction(_ entry: PluginMarketEntry) -> some View {
        if store.items.contains(where: { $0.id == entry.id }) {
            Button("已安装") {}.disabled(true)
        } else if !entry.compatible {
            Button("不兼容") {}.disabled(true)
        } else {
            Button("安装") { installFromMarket(entry) }.disabled(store.busy || !store.connected)
        }
    }

    private func installFromMarket(_ entry: PluginMarketEntry) {
        browsed = nil
        Task { await store.requestMarketInstall(id: entry.id, version: entry.version) }
    }

    private func marketTitle(_ entry: PluginMarketEntry) -> String {
        localizedText(entry.title, fallback: entry.id)
    }

    private func marketDetail(_ entry: PluginMarketEntry) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.md) {
                PluginIcon(id: entry.id, title: marketTitle(entry), size: 36)
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(marketTitle(entry)).font(.title3.weight(.semibold)).foregroundStyle(palette.fg).lineLimit(1)
                    Text([entry.vendor, "v" + entry.version, entry.date].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(palette.fg3)
                }
                Spacer(minLength: Space.md)
                marketAction(entry)
                Button(action: { browsed = nil }) { Image(icon: "xmark").font(.riffet(size: S(11), weight: .semibold)) }
                    .buttonStyle(IconButtonStyle(size: 26))
                    .help("关闭").accessibilityLabel("关闭").keyboardShortcut(.cancelAction)
            }.padding(Space.xl)
            Divider().overlay(palette.line)
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    let description = localizedText(entry.description_, fallback: "")
                    if !description.isEmpty { Text(description).font(.callout).foregroundStyle(palette.fg3).textSelection(.enabled) }
                    if !entry.capabilities.isEmpty {
                        VStack(alignment: .leading, spacing: Space.sm) {
                            Text("权限").font(.callout.weight(.medium))
                            ForEach(entry.capabilities, id: \.self) { value in
                                Text(capability(value)).font(.callout)
                                if value == "models.provide" { modelSourceNote(entry.modelSources?.map(\.hosts) ?? []) }
                                if value == "process.exec" { executableNote(entry.executables ?? []) }
                            }
                        }
                    }
                    if let readme = entry.readme, !readme.isEmpty,
                       let text = try? AttributedString(markdown: readme, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
                        Text(text).font(.callout).foregroundStyle(palette.fg2).textSelection(.enabled)
                            // The README comes from the index: only web links open.
                            .environment(\.openURL, OpenURLAction { url in
                                guard ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return .discarded }
                                return .systemAction
                            })
                    }
                    HStack(spacing: Space.lg) {
                        if let page = entry.page, let url = URL(string: page), ["https", "http"].contains(url.scheme) {
                            Link("在网页中查看", destination: url).font(.callout)
                        }
                        if let source = entry.source, let url = URL(string: source), url.scheme == "https" {
                            Link("源码", destination: url).font(.callout)
                        }
                    }
                }
                .padding(Space.xl)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(width: 560, height: 560)
        .background(palette.bg)
    }

    private var grantSheet: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Text(store.grant?.id ?? "").font(.title3.weight(.semibold))
            Text(store.grant?.version ?? "").font(.caption).foregroundStyle(palette.fg3)
            ForEach(store.grant?.capabilities ?? [], id: \.self) { value in
                Text(capability(value))
                if value == "models.provide" { modelSourceNote(store.grant?.modelSources?.map(\.hosts) ?? []) }
                if value == "process.exec" { executableNote(store.grant?.executables ?? []) }
            }
            if store.grant?.trustedAllowed == true {
                Toggle("信任此插件", isOn: Binding(get: { store.trustedInstall }, set: { store.trustedInstall = $0 })).disabled(store.busy)
                Text("允许插件使用 Riffet 的文件、网络和进程权限").font(.caption).foregroundStyle(palette.fg3)
            } else if store.grant?.trustedRequired == true {
                Text("请在服务器所在设备上安装此插件").font(.caption).foregroundStyle(palette.fg3)
            }
            Text("安装到当前连接的服务器").font(.caption).foregroundStyle(palette.fg3)
            HStack {
                Spacer()
                Button("取消") { store.cancelInstall() }.disabled(store.busy)
                Button("安装") { Task { await store.install(grant: store.grant?.capabilities ?? [], trusted: store.trustedInstall && store.grant?.trustedAllowed == true) } }
                    .disabled(store.busy || store.grant?.trustedRequired == true && (!store.trustedInstall || store.grant?.trustedAllowed != true))
            }
        }.padding(Space.xl).frame(width: 440).interactiveDismissDisabled(store.busy)
    }
    private func groupOf(_ item: PluginDescriptor) -> String {
        let declared = item.declared
        if declared?.agentBackends?.isEmpty == false || declared?.modelSources?.isEmpty == false { return "agents" }
        if declared?.appearance != nil || declared?.tasks?.isEmpty == false || declared?.views?.contains(where: { !$0.locations.contains("settings") }) == true { return "workbench" }
        return "services"
    }
    private func groupTitle(_ group: String) -> String {
        switch group {
        case "agents": String(localized: "Agent 与模型")
        case "workbench": String(localized: "工作台")
        default: String(localized: "服务与分享")
        }
    }
    private func source(_ item: PluginDescriptor) -> String {
        item.source == "development" ? String(localized: "开发包") : item.source == "installed" ? String(localized: "已安装") : String(localized: "内置")
    }
    private func status(_ item: PluginDescriptor) -> String {
        if item.stopping != nil { return String(localized: "等待任务结束") }
        if item.rejected || item.status?.state == "unavailable" { return String(localized: "不可用") }
        if item.status?.state == "attention" { return String(localized: "异常") }
        return item.enabled ? String(localized: "已启用") : String(localized: "已停用")
    }
    /// Where a model source sends requests and the key: the hosts every source declares, otherwise any address it names.
    @ViewBuilder private func modelSourceNote(_ sources: [[String]?]) -> some View {
        let hosts = declaredHosts(sources)
        if hosts.isEmpty {
            Text("模型请求与密钥发往插件指定的地址").font(.caption).foregroundStyle(palette.fg3)
        } else {
            (Text("模型请求与密钥发往") + Text(" ") + Text(hosts.joined(separator: ", ")).font(.caption.monospaced()))
                .font(.caption).foregroundStyle(palette.fg3)
        }
    }
    /// The commands `process.exec` runs outside the sandbox, as the user.
    @ViewBuilder private func executableNote(_ names: [String]) -> some View {
        if !names.isEmpty { Text(names.joined(separator: ", ")).font(.caption.monospaced()).foregroundStyle(palette.fg3) }
    }
    private func declaredHosts(_ sources: [[String]?]) -> [String] {
        guard !sources.isEmpty, sources.allSatisfy({ !($0 ?? []).isEmpty }) else { return [] }
        var seen = Set<String>()
        return sources.flatMap { $0 ?? [] }.filter { seen.insert($0).inserted }
    }
    private func capability(_ value: String) -> String {
        switch value {
        case "models.provide": String(localized: "提供模型源")
        case "tasks.run": String(localized: "运行项目命令")
        case "projects.read": String(localized: "读取项目文件")
        case "sessions.read": String(localized: "读取所在项目的会话内容，可由插件界面发出")
        case "network": String(localized: "访问网络")
        case "process.exec": String(localized: "以你的身份运行本机命令")
        default: value
        }
    }
}

@MainActor
private extension PluginDescriptor {
    var managementKey: String { PluginManagementStore.key(self) }
}

/// A plugin in the list: its mark, its name with a tag only where one is worth reading, one line of
/// description, and the switch. The row opens the plugin's details; the chevron says so on hover.
private struct PluginRow<Trailing: View>: View {
    let item: PluginDescriptor
    let busy: Bool
    let open: () -> Void
    @ViewBuilder let trailing: Trailing
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        HStack(spacing: Space.md) {
            Button(action: open) {
                HStack(spacing: Space.md) {
                    PluginIcon(item: item)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(item.displayTitle).font(.riffet(size: S(13))).foregroundStyle(palette.fg).lineLimit(1)
                            if item.source == "development" { PluginTag(text: String(localized: "开发包"), warning: false) }
                            if let problem { PluginTag(text: problem, warning: true) }
                        }
                        let description = localizedText(item.description_, fallback: "")
                        if !description.isEmpty {
                            Text(description).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3).lineLimit(1)
                        }
                    }
                    Spacer(minLength: Space.md)
                    Image(icon: "chevron.right")
                        .font(.riffet(size: S(10), weight: .semibold))
                        .foregroundStyle(palette.fg4)
                        .opacity(hovering ? 1 : 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(busy)
            trailing
        }
        .padding(.vertical, 2)
        .onHover { on in withAnimation(Motion.fast) { hovering = on } }
    }

    /// What needs the reader: the plain states (enabled, built in, installed) are not tagged.
    private var problem: String? {
        if item.stopping != nil { return String(localized: "等待任务结束") }
        if item.rejected || item.status?.state == "unavailable" { return String(localized: "不可用") }
        if item.status?.state == "attention" { return String(localized: "异常") }
        return nil
    }
}

/// A release in the plugin index, laid out like an installed plugin's row.
private struct MarketRow<Trailing: View>: View {
    let entry: PluginMarketEntry
    let title: String
    let open: () -> Void
    @ViewBuilder let trailing: Trailing
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        HStack(spacing: Space.md) {
            Button(action: open) {
                HStack(spacing: Space.md) {
                    PluginIcon(id: entry.id, title: title)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.riffet(size: S(13))).foregroundStyle(palette.fg).lineLimit(1)
                        let description = localizedText(entry.description_, fallback: "")
                        Text(description.isEmpty ? entry.vendor + " · " + entry.version : description + "  " + entry.vendor + " · " + entry.version)
                            .font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3).lineLimit(1)
                    }
                    Spacer(minLength: Space.md)
                    Image(icon: "chevron.right")
                        .font(.riffet(size: S(10), weight: .semibold))
                        .foregroundStyle(palette.fg4)
                        .opacity(hovering ? 1 : 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            trailing
        }
        .padding(.vertical, 2)
        .onHover { on in withAnimation(Motion.fast) { hovering = on } }
    }
}

private struct PluginTag: View {
    let text: String
    let warning: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        Text(text)
            .font(.riffet(size: S(10.5)))
            .foregroundStyle(warning ? palette.danger : palette.fg3)
            .padding(.horizontal, 5)
            .frame(height: 16)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(warning ? palette.danger.opacity(0.1) : palette.bgMuted))
    }
}

/// A plugin's own mark: the Agent it provides, the symbol its first view declares, or its initial on
/// a tile tinted from its id, so no two plugins share one stock glyph.
struct PluginIcon: View {
    let id: String
    let title: String
    var item: PluginDescriptor?
    var size: CGFloat = 28
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme

    init(item: PluginDescriptor, size: CGFloat = 28) { id = item.id; title = item.displayTitle; self.item = item; self.size = size }
    init(id: String, title: String, size: CGFloat = 28) { self.id = id; self.title = title; item = nil; self.size = size }

    var body: some View {
        mark
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.25, style: .continuous).fill(fill))
            .accessibilityHidden(true)
    }

    private var agent: String? {
        item?.declared?.agentBackends?.map(\.id).first { !AgentMarkGlyphs.paths(for: $0).isEmpty }
    }

    private var symbol: String? {
        item?.declared?.agentBackends?.compactMap(\.icon?.sfSymbol).first
            ?? item?.declared?.views?.compactMap(\.icon?.sfSymbol).first
    }

    @ViewBuilder private var mark: some View {
        if let agent {
            AgentMarkView(backend: agent, size: size * 0.6, color: agentMarkColor(agent, palette) ?? palette.fg)
        } else if let symbol {
            Image(icon: symbol).font(.riffet(size: size * 0.5)).foregroundStyle(palette.fg2)
        } else {
            Text(initial).font(.riffet(size: size * 0.46, weight: .semibold)).foregroundStyle(ink)
        }
    }

    private var initial: String {
        title.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?"
    }

    /// A stable hue from the id; low chroma, so the tiles colour the list without shouting.
    private var hue: Double {
        Double(id.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value } % 360) / 360
    }

    private var tinted: Bool { agent == nil && symbol == nil }

    private var fill: Color {
        guard tinted else { return palette.bgMuted }
        return scheme == .dark ? Color(hue: hue, saturation: 0.3, brightness: 0.3) : Color(hue: hue, saturation: 0.12, brightness: 0.96)
    }

    private var ink: Color {
        scheme == .dark ? Color(hue: hue, saturation: 0.3, brightness: 0.9) : Color(hue: hue, saturation: 0.55, brightness: 0.45)
    }
}
