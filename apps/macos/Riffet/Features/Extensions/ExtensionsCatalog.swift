import SwiftUI
import RiffetKit

/// A filter chip that opens an AppKit menu; it reads as set (and shows the choice) when active.
struct ExtensionSelect: View {
    let title: String
    let value: String?
    let symbol: String?
    let options: [ChoiceOption]
    @Environment(\.palette) private var palette

    var body: some View {
        ChoiceMenu(options: options) {
            HStack(spacing: 5) {
                if let symbol { Image(icon: symbol).font(.riffet(size: S(11.5))) }
                Text(value ?? title).lineLimit(1)
                Image(icon: "chevron.down").font(.riffet(size: S(8), weight: .bold)).foregroundStyle(palette.fg4)
            }
            .font(.riffet(size: S(12.5)))
            .foregroundStyle(value == nil ? palette.fg2 : palette.fg)
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(value == nil ? Color.clear : palette.bgHover))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line, lineWidth: value == nil ? 1 : 0))
        }
        .fixedSize()
        .help(title)
    }
}

/// Extensions for the selected Agent and scope, with optional batch selection.
struct ExtensionsCatalog: View {
    let store: ExtensionsStore
    let onOpen: (String) -> Void
    let onCreate: () -> Void
    let onBatch: (Bool) -> Void
    let onBackend: (NativeBackendId) -> Void
    let onKind: (String) -> Void
    let onInstall: () -> Void
    let onDiagnostics: () -> Void
    let projectTitle: String
    let projectOptions: [ChoiceOption]
    @Environment(\.palette) private var palette
    @State private var filtersOpen = false
    @State private var batchMode = false

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            if store.filters.activeCount > 0 { activeFilters.disabled(store.busy) }
            if store.currentSource?.error != nil { failedBanner }
            Divider().overlay(palette.line)
            content
            footer
        }
        .onChange(of: store.currentSource?.key) { _, _ in resetPresentation() }
        .onChange(of: store.filters.kind) { _, _ in resetPresentation() }
        .overlay(alignment: .bottom) {
            if batchMode && store.batch.selected > 0 { bulkBar.padding(.bottom, Space.xl) }
        }
    }

    // MARK: Toolbar

    private var toolbar: some View {
        VStack(spacing: Space.md) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Space.sm) {
                    sourceSelectors
                    Spacer(minLength: Space.md)
                    searchField.frame(width: 280)
                }
                VStack(spacing: Space.sm) {
                    HStack { sourceSelectors; Spacer(minLength: 0) }
                    searchField
                }
            }
            HStack(spacing: Space.sm) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.lg) {
                        ForEach(ExtensionText.kindOrder, id: \.self) { kind in
                            Button { onKind(kind) } label: {
                                HStack(spacing: Space.xs) {
                                    Text(kindLabel(kind))
                                    if store.filters.kind == kind {
                                        Text("\(store.kindCounts[kind] ?? 0)")
                                            .font(.riffet(size: S(11)))
                                            .foregroundStyle(palette.fg4)
                                            .monospacedDigit()
                                    }
                                }
                                .font(.riffet(size: S(12.5), weight: store.filters.kind == kind ? .semibold : .regular))
                                .foregroundStyle(store.filters.kind == kind ? palette.fg : palette.fg3)
                                .frame(height: 36)
                                .overlay(alignment: .bottom) {
                                    if store.filters.kind == kind {
                                        RoundedRectangle(cornerRadius: 1).fill(palette.fg).frame(height: 2)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                Button { filtersOpen.toggle() } label: {
                    HStack(spacing: Space.xs) {
                        Image(icon: "line.3.horizontal.decrease")
                        if store.filters.activeCount > 0 {
                            Text("\(store.filters.activeCount)").monospacedDigit()
                        }
                    }
                    .font(.riffet(size: S(12)))
                }
                .buttonStyle(ChipButtonStyle())
                .foregroundStyle(filtersOpen || store.filters.activeCount > 0 ? palette.accent : palette.fg3)
                .help("筛选")
                .popover(isPresented: $filtersOpen, arrowEdge: .bottom) { filterPanel }
                ChoiceMenu(options: sortOptions) {
                    Image(icon: "arrow.up.arrow.down")
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(store.filters.sort == .standard ? palette.fg3 : palette.accent)
                        .frame(width: 28, height: 28)
                }
                .help("排序 · \(store.filters.sort.label)")
                ChoiceMenu(options: batchOptions) {
                    Image(icon: "ellipsis").font(.riffet(size: S(14)))
                        .foregroundStyle(palette.fg3).frame(width: 28, height: 28)
                }
                .help("列表选项")
                createAction
            }
        }
        .padding(.horizontal, Space.lg)
        .padding(.top, Space.md)
        .disabled(store.busy)
    }

    private var sourceSelectors: some View {
        HStack(spacing: Space.sm) {
            ExtensionSelect(title: "Agent", value: store.filters.backend.map(backendTitle), symbol: nil, options: agentOptions)
            ExtensionSelect(title: String(localized: "用户配置"), value: projectTitle, symbol: "folder", options: projectOptions)
        }
    }

    @ViewBuilder
    private var createAction: some View {
        if store.filters.kind == "plugin" {
            Button(action: onInstall) {
                Label("安装", icon: "plus").font(.riffet(size: S(12), weight: .medium))
            }
            .buttonStyle(SolidButtonStyle())
            .disabled(store.busy || store.currentSource == nil)
            .fixedSize()
        } else if !store.creatableSources.isEmpty {
            Button(action: onCreate) {
                Label("新建", icon: "plus").font(.riffet(size: S(12), weight: .medium))
            }
            .buttonStyle(SolidButtonStyle())
            .disabled(store.busy)
            .fixedSize()
        }
    }

    private func resetPresentation() {
        batchMode = false
        filtersOpen = false
        store.clearChecked()
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(icon: "magnifyingglass").font(.riffet(size: S(12))).foregroundStyle(palette.fg4)
            TextField("搜索扩展", text: Binding(get: { store.filters.query }, set: { value in store.setFilters { $0.query = value } }))
                .textFieldStyle(.plain)
                .font(.riffet(size: S(12.5)))
            if !store.filters.query.isEmpty {
                Button { store.setFilters { $0.query = "" } } label: {
                    Image(icon: "xmark.circle.fill").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                }
                .buttonStyle(.plain)
                .help("清除搜索")
            }
        }
        .padding(.horizontal, Space.sm)
        .frame(height: 30)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgSubtle))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
    }

    private var batchOptions: [ChoiceOption] {
        [ChoiceOption(title: batchMode ? String(localized: "结束批量选择") : String(localized: "批量选择"), selected: batchMode) {
            batchMode.toggle()
            store.clearChecked()
        }]
    }

    private var filterPanel: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            HStack {
                Text("筛选").font(.riffet(size: S(13), weight: .semibold)).foregroundStyle(palette.fg)
                Spacer()
                if store.filters.activeCount > 0 {
                    Button("清除") { clearFacetFilters() }
                        .buttonStyle(ChipButtonStyle())
                }
            }
            filterSection(String(localized: "作用域"), options: scopeOptions)
            filterSection(String(localized: "来源"), options: originOptions)
            filterSection(String(localized: "状态"), options: statusOptions)
        }
        .padding(Space.lg)
        .frame(width: 300)
        .background(palette.bgElevated)
        .disabled(store.busy)
    }

    private func filterSection(_ title: String, options: [ChoiceOption]) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text(title).font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
            FlowRow(spacing: Space.xs, lineSpacing: Space.xs) {
                ForEach(options.indices, id: \.self) { index in
                    let option = options[index]
                    Button(action: option.action) {
                        HStack(spacing: Space.xs) {
                            if option.selected {
                                Image(icon: "checkmark").font(.riffet(size: S(9), weight: .semibold))
                            }
                            Text(option.title)
                        }
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(option.selected ? palette.accent : palette.fg2)
                        .padding(.horizontal, Space.sm)
                        .frame(height: 28)
                        // The check and the accent mark the chosen filter; every chip keeps one fill.
                        .background(RoundedRectangle(cornerRadius: Radius.control).fill(palette.bgSubtle))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var activeFilters: some View {
        FlowRow(spacing: Space.sm, lineSpacing: Space.sm) {
            if let scope = store.filters.scope {
                filterToken(ExtensionText.scope(scope)) { store.setFilters { $0.scope = nil } }
            }
            if store.filters.origin != .all {
                filterToken(store.filters.origin.label) { store.setFilters { $0.origin = .all } }
            }
            if store.filters.status != .all {
                filterToken(store.filters.status.label) { store.setFilters { $0.status = .all } }
            }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
    }

    private func filterToken(_ title: String, clear: @escaping () -> Void) -> some View {
        Button(action: clear) {
            HStack(spacing: Space.sm) {
                Text(title).font(.riffet(size: S(11.5)))
                Image(icon: "xmark").font(.riffet(size: S(8), weight: .semibold))
            }
            .foregroundStyle(palette.fg2)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs)
            .background(Capsule().fill(palette.bgSubtle))
        }
        .buttonStyle(.plain)
        .help("清除\(title)")
    }

    private func clearFacetFilters() {
        store.setFilters { $0.scope = nil; $0.origin = .all; $0.status = .all }
    }

    private var failedBanner: some View {
        HStack(spacing: Space.sm) {
            Image(icon: "exclamationmark.triangle.fill")
                .font(.riffet(size: S(11))).foregroundStyle(palette.warning)
            Text("部分扩展未能读取")
                .font(.riffet(size: S(12))).foregroundStyle(palette.fg2)
            Spacer()
            Button("查看详情", action: onDiagnostics).buttonStyle(ChipButtonStyle())
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .background(palette.bgSubtle)
    }

    // MARK: List

    @ViewBuilder
    private var content: some View {
        if store.sources.isEmpty {
            VStack(spacing: Space.sm) {
                Text("暂无 Agent 配置").font(.riffet(size: S(14), weight: .medium)).foregroundStyle(palette.fg2)
                Text("在设置的「模型设置」中配置 Agent 后查看扩展。").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.rows.isEmpty {
            VStack(spacing: Space.md) {
                if store.currentSource?.loading == true {
                    Spinner(size: .small)
                    Text("正在读取扩展").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                } else if store.currentSource?.error != nil || store.readableSourceCount == 0 {
                    Text("没有读取成功的配置").font(.riffet(size: S(13))).foregroundStyle(palette.fg2)
                    Button("重新读取") { store.refresh() }.buttonStyle(SolidButtonStyle(kind: .primary)).disabled(store.busy)
                } else if !store.filters.query.isEmpty || store.filters.activeCount > 0 {
                    Text("没有匹配的扩展").font(.riffet(size: S(13))).foregroundStyle(palette.fg2)
                    Button("清除筛选") { store.resetFilters() }.buttonStyle(SolidButtonStyle()).disabled(store.busy)
                } else {
                    Text("暂无\(kindLabel(store.filters.kind ?? "skill"))").font(.riffet(size: S(13))).foregroundStyle(palette.fg2)
                    createAction
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 0) {
                if batchMode { listHeader }
                List {
                    ForEach(store.pagedRows) { row in
                        ExtensionCatalogRow(
                            row: row,
                            checked: store.checked.contains(row.id),
                            batchMode: batchMode,
                            active: store.selectedKey == row.id,
                            disabled: store.busy,
                            onToggle: { store.toggleChecked($0) },
                            onOpen: onOpen
                        )
                        .equatable()
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    }
                    Color.clear.frame(height: store.batch.selected > 0 ? 56 : 0)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                // A new page starts at the top; the id changes only when the page does.
                .id(store.page)
            }
        }
    }

    private var listHeader: some View {
        HStack(spacing: Space.sm) {
            Button { store.setAllChecked(!store.allChecked) } label: {
                Image(icon: store.allChecked ? "checkmark.square.fill" : (store.batch.selected > 0 ? "minus.square.fill" : "square"))
                    .font(.riffet(size: S(14)))
                    .foregroundStyle(store.batch.selected > 0 ? palette.accent : palette.fg4)
            }
            .buttonStyle(.plain)
            .disabled(store.busy)
            .help("全选本页")
            Text("全选本页")
            Spacer()
        }
        .font(.riffet(size: S(11.5)))
        .foregroundStyle(palette.fg3)
        .padding(.horizontal, Space.lg)
        .frame(height: 28)
        .overlay(alignment: .bottom) { Rectangle().fill(palette.lineSoft).frame(height: 1) }
    }

    @ViewBuilder
    private var footer: some View {
        if store.pageCount > 1 {
            HStack(spacing: Space.sm) {
                Spacer()
                Button { store.setPage(store.page - 1) } label: {
                    Image(icon: "chevron.left").font(.riffet(size: S(10), weight: .semibold))
                }
                .buttonStyle(IconButtonStyle(size: 26))
                .disabled(store.busy || store.page <= 1)
                .help("上一页")
                Text("\(store.page) / \(store.pageCount)").monospacedDigit()
                Button { store.setPage(store.page + 1) } label: {
                    Image(icon: "chevron.right").font(.riffet(size: S(10), weight: .semibold))
                }
                .buttonStyle(IconButtonStyle(size: 26))
                .disabled(store.busy || store.page >= store.pageCount)
                .help("下一页")
                Spacer()
            }
            .font(.riffet(size: S(11.5)))
            .foregroundStyle(palette.fg3)
            .padding(.horizontal, Space.lg)
            .frame(height: 40)
            .overlay(alignment: .top) { Rectangle().fill(palette.lineSoft).frame(height: 1) }
        }
    }

    private var bulkBar: some View {
        HStack(spacing: Space.sm) {
            Button { store.clearChecked() } label: { Image(icon: "xmark").font(.riffet(size: S(11), weight: .semibold)) }
                .buttonStyle(IconButtonStyle(size: 24))
                .disabled(store.operationBusy)
                .help("取消选择")
            Text("已选 \(store.batch.selected) 项").font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg)
            Rectangle().fill(palette.line).frame(width: 1, height: 16)
            if let progress = store.batchProgress {
                Spinner(size: .mini)
                Text("\(progress.done + 1) / \(progress.total)").font(.riffet(size: S(12))).foregroundStyle(palette.fg3).monospacedDigit()
            } else if store.operationBusy {
                Spinner(size: .mini)
            }
            Button("启用\(store.batch.enable > 0 ? " \(store.batch.enable)" : "")") { onBatch(true) }
                .buttonStyle(ChipButtonStyle())
                .disabled(store.busy || store.dirty || store.batch.enable == 0)
                .help(store.batch.enable == 0 ? "所选条目没有可启用的项" : "启用所选条目")
            Button("停用\(store.batch.disable > 0 ? " \(store.batch.disable)" : "")") { onBatch(false) }
                .buttonStyle(ChipButtonStyle())
                .disabled(store.busy || store.dirty || store.batch.disable == 0)
                .help(store.batch.disable == 0 ? "所选条目没有可停用的项" : "停用所选条目")
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, 6)
        .background(Capsule().fill(palette.bgElevated).elevation(.pop))
        .overlay(Capsule().strokeBorder(palette.line))
    }

    // MARK: Menus

    private func kindLabel(_ kind: String) -> String { kind == "config" ? String(localized: "配置文件") : ExtensionText.kind(kind) }

    private var agentOptions: [ChoiceOption] {
        var seen: [NativeBackendId] = []
        for source in store.sources where !seen.contains(source.backendId) { seen.append(source.backendId) }
        return seen.map { backend in
            ChoiceOption(title: backendTitle(backend), selected: store.filters.backend == backend) {
                onBackend(backend)
            }
        }
    }

    private var scopeOptions: [ChoiceOption] {
        [ChoiceOption(title: String(localized: "全部"), selected: store.filters.scope == nil) { store.setFilters { $0.scope = nil } }]
            + ["user", "project", "managed", "builtin"].map { scope in
                ChoiceOption(title: ExtensionText.scope(scope), selected: store.filters.scope == scope) { store.setFilters { $0.scope = scope } }
            }
    }

    private var originOptions: [ChoiceOption] {
        ExtensionOriginFilter.allCases.map { origin in
            ChoiceOption(title: origin == .all ? String(localized: "全部") : origin.label, selected: store.filters.origin == origin) { store.setFilters { $0.origin = origin } }
        }
    }

    private var statusOptions: [ChoiceOption] {
        ExtensionStatusFilter.allCases.map { status in
            ChoiceOption(
                title: status == .all ? String(localized: "全部") : status.label,
                selected: store.filters.status == status
            ) { store.setFilters { $0.status = status } }
        }
    }

    private var sortOptions: [ChoiceOption] {
        ExtensionSort.allCases.map { sort in
            ChoiceOption(title: sort.label, selected: store.filters.sort == sort) { store.setFilters { $0.sort = sort } }
        }
    }
}

/// One catalog row. It compares by what it shows, so ticking one box or opening one item rebuilds
/// only that row.
private struct ExtensionCatalogRow: View, Equatable {
    let row: ExtensionRow
    let checked: Bool
    let batchMode: Bool
    let active: Bool
    let disabled: Bool
    @Environment(\.palette) private var palette
    let onToggle: (String) -> Void
    let onOpen: (String) -> Void
    @State private var hovered = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.checked == rhs.checked && lhs.active == rhs.active
            && lhs.disabled == rhs.disabled && lhs.batchMode == rhs.batchMode
    }

    var body: some View {
        HStack(spacing: 0) {
            if batchMode {
                Button { onToggle(row.id) } label: {
                    Image(icon: checked ? "checkmark.square.fill" : "square")
                        .font(.riffet(size: S(14)))
                        .foregroundStyle(checked ? palette.accent : palette.fg4)
                        .frame(width: 28)
                        .frame(maxHeight: .infinity)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(disabled)
                .help("选择 \(row.name)")
            }
            Button { onOpen(row.id) } label: {
                HStack(alignment: .top, spacing: Space.sm) {
                    Image(icon: ExtensionText.symbol(row.kind))
                        .font(.riffet(size: S(13)))
                        .foregroundStyle(active ? palette.accent : palette.fg3)
                        .frame(width: 28, height: 28)
                        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgSubtle))
                    VStack(alignment: .leading, spacing: Space.xs) {
                        HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
                            Text(row.name)
                                .font(.riffet(size: S(13), weight: .medium))
                                .foregroundStyle(palette.fg)
                                .lineLimit(1)
                            if row.kind == "skill" { skillBadges }
                            Spacer(minLength: Space.xs)
                            if row.status == .disabled || row.status == .attention || row.status == .pending {
                                HStack(spacing: Space.xs) {
                                    Circle().fill(statusColor).frame(width: 5, height: 5)
                                    Text(row.status.label)
                                        .font(.riffet(size: S(11)))
                                        .foregroundStyle(palette.fg2)
                                }
                                .fixedSize()
                            }
                        }
                        if !row.subtitle.isEmpty {
                            Text(row.subtitle)
                                .font(.riffet(size: S(12)))
                                .foregroundStyle(palette.fg2)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    Image(icon: "chevron.right")
                        .font(.riffet(size: S(9), weight: .semibold))
                        .foregroundStyle(active ? palette.accent : palette.fg4)
                        .padding(.top, Space.xs)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, Space.md)
                .frame(minHeight: 68)
                .padding(.horizontal, Space.sm)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            .onHover { hovered = $0 }
        }
        .background(RoundedRectangle(cornerRadius: Radius.container, style: .continuous)
            .fill(active ? palette.bgActive : ((checked || hovered) ? palette.bgHover : Color.clear)))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.container, style: .continuous)
                .strokeBorder(active ? palette.accent.opacity(0.45) : Color.clear)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, Space.xxs)
    }

    private var skillBadges: some View {
        HStack(spacing: Space.xs) {
            if let source = row.skillSource {
                badge(source, symbol: source == String(localized: "插件提供") ? "puzzlepiece.extension" : (row.scope == "builtin" ? "shippingbox" : "folder"), foreground: palette.fg3, background: palette.bgMuted)
            }
            if let reason = row.readOnlyReason {
                badge(String(localized: "文件只读"), symbol: "lock", foreground: palette.warning, background: palette.warning.opacity(0.1))
                    .help(reason)
            }
            if row.canDelete {
                badge(String(localized: "可删除"), symbol: "trash", foreground: palette.accent, background: palette.accentSoft)
            }
        }
    }

    private func badge(_ title: String, symbol: String, foreground: Color, background: Color) -> some View {
        HStack(spacing: 3) {
            Image(icon: symbol).font(.riffet(size: S(9)))
            Text(title).font(.riffet(size: S(10.5)))
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Capsule().fill(background))
        .fixedSize()
    }

    private var statusColor: Color {
        switch row.status {
        case .disabled: palette.fg4
        case .attention, .pending: palette.warning
        case .loaded: palette.success
        case .enabled, .discovered: palette.fg3
        }
    }
}
