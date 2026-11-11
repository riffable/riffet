import SwiftUI
import RiffetKit

/// One provider (backend profile) and the models it offers, for a picker that lists providers
/// beside their models. `models == nil` while its catalog is still being read.
struct ProviderModels: Identifiable {
    let profile: NativeBackendProfile
    let models: [ModelInfo]?
    var issue: String? = nil
    var id: String { profile.id }
}

/// The same catalog and parameter rules as the other clients, presented as a compact Mac menu.
struct ModelControls: View {
    let catalog: [ModelInfo]
    let selection: String?
    var usage: (() async -> NativeBackendUsage?)?
    var showsAccountUsage = false
    /// The catalog is still being read: the chip shows a spinner, and with nothing to list
    /// yet it does not open.
    var loading = false
    /// Every provider of the agent being started, when it has more than one. Empty keeps the
    /// panel a single model list, which is what an open conversation has: its provider is fixed.
    var providers: [ProviderModels] = []
    var activeProviderId: String?
    /// A model of another provider: the caller switches provider and model in one write.
    var chooseInProvider: ((String, String) -> Void)?
    /// Re-reads one provider's catalog after it failed or answered with nothing.
    var retryProvider: ((String) -> Void)?
    /// The agent, provider and session these figures belong to. Two backends can share a profile
    /// id, so `activeProviderId` alone cannot tell a switch.
    var scope: String = ""
    /// Re-reads the catalogs as the popup opens, so model membership is as fresh as the quota read.
    var refresh: (() async -> Void)?
    let choose: (String) -> Void
    @Environment(\.palette) private var palette
    @Environment(\.compactControls) private var compact
    @State private var open = false
    @State private var loaded: NativeBackendUsage?
    /// The agent, provider and session [loaded] describes: reopening the popup keeps its figures
    /// on the rows until the new read lands, another provider's are dropped at once.
    @State private var loadedKey: String?
    @State private var loadingUsage = false

    private var usageKey: String { "\(scope)|\(activeProviderId ?? "")" }

    /// The models the current selection is read against. Right after choosing another provider's
    /// model the main catalog can still be a request behind, so prefer the loaded provider list.
    private var activeModels: [ModelInfo] {
        if let activeProviderId, let provider = providers.first(where: { $0.id == activeProviderId }), let models = provider.models { return models }
        return catalog
    }

    var body: some View {
        let resolved = resolveModelSelection(catalog: activeModels, selection: selection)
        let params = catalogParams(catalog: activeModels, model: resolved.model, overrides: resolved.params)
        Button {
            if !open, usage != nil { loadingUsage = true }
            open.toggle()
        } label: {
            HStack(spacing: 5) {
                Text(modelLabel(catalog: activeModels, value: selection).ifEmpty(String(localized: "选择模型")))
                    .lineLimit(1)
                    .frame(maxWidth: compact ? 120 : 220, alignment: .leading)
                    .fixedSize(horizontal: true, vertical: false)
                ForEach(params, id: \.id) { mark($0) }
                if loading { Spinner(size: .mini) }
            }
        }
        .buttonStyle(ChipButtonStyle(active: open))
        .disabled(loading && catalog.isEmpty)
        .help(modelSelectionSummary(catalog: activeModels, selection: selection))
        .accessibilityLabel("选择模型")
        .accessibilityValue(modelSelectionSummary(catalog: activeModels, selection: selection))
        .anchoredPopup(isPresented: $open) {
            ModelPanel(catalog: catalog, selection: selection, resolved: resolved, params: params, loaded: loaded,
                       showsAccountUsage: showsAccountUsage, loadingUsage: loadingUsage,
                       providers: providers, activeProviderId: activeProviderId,
                       choose: choose, chooseInProvider: chooseInProvider, retryProvider: retryProvider)
        }
        // A provider switch writes a new usage read, so the popup's own quota follows it too.
        .task(id: open ? usageKey : nil) {
            guard open else { loadingUsage = false; return }
            let key = usageKey
            loadingUsage = true
            // Drop another provider's figures before awaiting the new read, including while the
            // catalog refresh is still in flight; this one's stay until their replacement lands.
            if loadedKey != key {
                loaded = nil
                loadedKey = key
            }
            await refresh?()
            guard !Task.isCancelled, let usage else { loadingUsage = false; return }
            let snapshot = await usage()
            guard !Task.isCancelled else { return }
            if let snapshot { loaded = snapshot }
            loadingUsage = false
        }
    }

    @ViewBuilder
    private func mark(_ param: ModelParam_) -> some View {
        switch paramKind(param: param) {
        case .fast:
            if isOn(param: param) { Image(icon: "bolt.fill").font(.riffet(size: S(11))).foregroundStyle(palette.fg2).accessibilityLabel("Fast") }
        case .toggle:
            if param.id == "thinking", !isOn(param: param) { Image(icon: "brain").font(.riffet(size: S(11))).foregroundStyle(palette.fg4) }
        case .effort:
            if !param.value.isEmpty, param.value != "default", !compact { Text(optionLabel(param: param, value: param.value)).foregroundStyle(palette.fg3) }
        case .max:
            if isOn(param: param), !compact { Text("MAX").foregroundStyle(palette.fg3) }
        case .select:
            if param.id == "context", param.value != "default" {
                Text(optionLabel(param: param, value: param.value)).foregroundStyle(palette.fg3)
            }
        default:
            EmptyView()
        }
    }
}

struct ModelPanel: View {
    let catalog: [ModelInfo]
    let selection: String?
    let resolved: ParsedSelection
    let params: [ModelParam_]
    let loaded: NativeBackendUsage?
    let showsAccountUsage: Bool
    let loadingUsage: Bool
    var providers: [ProviderModels] = []
    var activeProviderId: String?
    let choose: (String) -> Void
    var chooseInProvider: ((String, String) -> Void)?
    var retryProvider: ((String) -> Void)?
    @Environment(\.palette) private var palette
    @Environment(\.popupAvailableSize) private var availableSize
    @State private var hovered: String?
    /// The arrow keys moved the focus: only then is the focused row drawn, so opening the panel
    /// marks the chosen model with its check alone.
    @State private var keyed = false
    /// The provider whose models the right column lists. Picking one only previews it; the
    /// provider switch commits with the model, so a look around does not reset mode or approval.
    @State private var viewingProviderId: String?
    @FocusState private var focusedModel: String?

    private var twoColumn: Bool { providers.count > 1 }
    private var shownProvider: ProviderModels? {
        guard twoColumn else { return nil }
        return providers.first { $0.id == (viewingProviderId ?? activeProviderId) } ?? providers.first
    }
    private var shownModels: [ModelInfo] {
        guard let shownProvider else { return catalog }
        return shownProvider.models ?? []
    }
    /// Parameters and quota describe the provider in use, so they stay off while another is previewed.
    private var isActiveProvider: Bool { !twoColumn || shownProvider?.id == activeProviderId }
    private var shownParams: [ModelParam_] { isActiveProvider ? params : [] }
    private var rows: Int { max(twoColumn ? providers.count : 1, shownModels.count) }
    private var chromeHeight: CGFloat { (shownParams.isEmpty ? 0 : CGFloat(shownParams.count) * 32 + 17) + (showsAccountUsage && isActiveProvider ? ModelAccountUsage.height + 1 : 0) }
    private var listHeight: CGFloat { min(300, CGFloat(max(1, rows)) * 30 + 12, max(42, availableSize.height - chromeHeight)) }
    private var orderedParams: [ModelParam_] { shownParams.sorted { Self.order($0) < Self.order($1) } }

    var body: some View {
        Group {
            if chromeHeight + 42 > availableSize.height {
                ScrollView { contents }.frame(height: availableSize.height)
            } else {
                contents
            }
        }
        .frame(width: min(twoColumn ? 420 : 320, availableSize.width), alignment: .leading)
        .background(palette.bgPopover, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
    }

    private var contents: some View {
        VStack(alignment: .leading, spacing: 0) {
            if twoColumn {
                HStack(alignment: .top, spacing: 0) {
                    providerColumn.frame(width: 132)
                    // A vertical divider takes whatever height it is offered; held to the lists', the
                    // panel stays as tall as its rows wherever the popup has room to grow.
                    Divider().overlay(palette.line).frame(height: listHeight)
                    modelColumn
                }
            } else {
                modelColumn
            }
            if !shownParams.isEmpty {
                Divider().overlay(palette.line)
                VStack(spacing: 0) {
                    ForEach(orderedParams, id: \.id) { row($0) }
                }
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
            }
            if showsAccountUsage && isActiveProvider {
                Divider().overlay(palette.line)
                ModelAccountUsage(account: loaded?.account, loading: loadingUsage)
                    // Keep the menu anchored while the single quota row loads.
                    .frame(height: ModelAccountUsage.height)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var providerColumn: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(providers) { provider in providerRow(provider) }
            }
            .padding(6)
        }
        .frame(height: listHeight)
    }

    private func providerRow(_ provider: ProviderModels) -> some View {
        let active = provider.id == activeProviderId
        let shown = provider.id == shownProvider?.id
        return Button { viewingProviderId = provider.id; focusedModel = nil } label: {
            HStack(spacing: Space.xs) {
                Text(provider.profile.name).font(.riffet(size: S(13))).foregroundStyle(palette.fg).lineLimit(1).layoutPriority(1)
                Spacer(minLength: 0)
                Image(icon: "checkmark").font(.riffet(size: S(10), weight: .semibold)).foregroundStyle(palette.fg2).opacity(active ? 1 : 0).frame(width: 12)
            }
            .padding(.horizontal, Space.sm).frame(maxWidth: .infinity, alignment: .leading).frame(height: 30)
            // The check marks the chosen provider; a fill, the other one whose models are previewed.
            .background(shown && !active ? palette.bgHover : Color.clear, in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var modelColumn: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    if let provider = shownProvider, provider.models == nil {
                        HStack(spacing: Space.xs) {
                            Text(provider.issue ?? String(localized: "加载中…")).font(RiffetFont.caption).foregroundStyle(palette.fg3).lineLimit(2)
                            Spacer(minLength: Space.xs)
                            if provider.issue != nil, let retryProvider {
                                Button(String(localized: "重试")) { retryProvider(provider.id) }
                                    .buttonStyle(.plain).font(.riffet(size: S(11))).foregroundStyle(palette.mark)
                            }
                        }
                        .padding(.horizontal, Space.sm).frame(maxWidth: .infinity, alignment: .leading).frame(height: 30)
                    }
                    ForEach(shownModels, id: \.value) { modelRow($0).id($0.value) }
                    if shownModels.isEmpty, !twoColumn || shownProvider?.models != nil {
                        Text("没有可用模型").font(RiffetFont.caption).foregroundStyle(palette.fg3).frame(height: 30)
                    }
                }
                .padding(6)
            }
            .frame(height: listHeight)
            .frame(maxWidth: .infinity)
            .onAppear {
                guard isActiveProvider else { focusedModel = nil; return }
                proxy.scrollTo(resolved.model, anchor: .center); focusedModel = resolved.model
            }
            .onChange(of: viewingProviderId) { _, _ in
                guard isActiveProvider else { focusedModel = nil; return }
                focusedModel = resolved.model
            }
            .onChange(of: focusedModel) { _, id in if let id { proxy.scrollTo(id) } }
            .onMoveCommand { direction in
                keyed = true
                let index = shownModels.firstIndex { $0.value == focusedModel } ?? shownModels.firstIndex { $0.value == resolved.model } ?? 0
                let next = direction == .down ? index + 1 : direction == .up ? index - 1 : index
                if shownModels.indices.contains(next) { focusedModel = shownModels[next].value }
            }
        }
    }

    private static func order(_ param: ModelParam_) -> Int {
        switch paramKind(param: param) {
        case .effort: 0
        case .toggle: 1
        case .select: 2
        case .fast: 3
        case .max: 4
        }
    }

    private func value(for param: ModelParam_, _ value: String) {
        choose(selectionWithParam(catalog: shownModels, currentSelection: selection ?? resolved.model, paramId: param.id, value: value))
    }

    @ViewBuilder
    private func row(_ param: ModelParam_) -> some View {
        let kind = paramKind(param: param)
        HStack(spacing: Space.sm) {
            Text(Self.title(param, kind)).font(.riffet(size: S(13))).foregroundStyle(palette.fg2).lineLimit(1).layoutPriority(1)
            Spacer(minLength: Space.sm)
            switch kind {
            case .fast, .toggle:
                if kind == .fast, param.options.contains(where: { $0.value == "default" }) {
                    Button("默认") { value(for: param, "default") }
                        .font(.riffet(size: S(11)))
                        .foregroundStyle(param.value == "default" ? palette.mark : palette.fg3)
                        .buttonStyle(.plain)
                        .help("跟随 Claude Code 的 Fast 设置")
                }
                Toggle(Self.title(param, kind), isOn: Binding(get: { isOn(param: param) }, set: { value(for: param, toggledValue(param: param, on: $0, fallback: nil)) }))
                    .toggleStyle(.switch).controlSize(.mini).labelsHidden().tint(palette.accent)
                    .accessibilityValue(param.value == "default" ? "跟随默认设置" : isOn(param: param) ? "开启" : "关闭")
            default:
                ChoiceMenu(options: (kind == .max ? param.options : listValues(param: param)).map { option in
                    ChoiceOption(title: optionLabel(param: param, value: option.value), selected: param.value == option.value) { value(for: param, option.value) }
                }) {
                    HStack(spacing: 6) {
                        Text(optionLabel(param: param, value: param.value)).lineLimit(1)
                        Spacer(minLength: 0)
                        Image(icon: "chevron.up.chevron.down").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
                    }
                    .font(.riffet(size: S(12))).foregroundStyle(palette.fg2)
                    .padding(.horizontal, 8).frame(width: 100, height: 24)
                    .background(palette.bg, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
                }
                .accessibilityLabel(Self.title(param, kind))
            }
        }
        .frame(maxWidth: .infinity).frame(height: 32)
    }

    private static func title(_ param: ModelParam_, _ kind: ParamKind) -> String {
        switch kind {
        case .effort: String(localized: "推理强度")
        case .fast: "Fast"
        case .max: String(localized: "MAX 模式")
        case .toggle: param.id == "thinking" ? String(localized: "深度思考") : paramTitle(param: param)
        default: paramTitle(param: param)
        }
    }

    /// Commits a model. A model of the provider being previewed carries that provider along, so
    /// the choice of provider and model is one write and a preview never resets mode or approval.
    private func chooseModel(_ info: ModelInfo) {
        guard !isActiveProvider || info.value != resolved.model else { return }
        let value = selectionForModel(catalog: shownModels, model: info.value)
        if let provider = shownProvider, provider.id != activeProviderId, let chooseInProvider {
            chooseInProvider(provider.id, value)
        } else {
            choose(value)
        }
    }

    private func modelRow(_ info: ModelInfo) -> some View {
        let on = isActiveProvider && info.value == resolved.model
        return Button { chooseModel(info) } label: {
            HStack(spacing: Space.sm) {
                Text(cleanLabel(value: info.name)).font(.riffet(size: S(13))).foregroundStyle(palette.fg).lineLimit(1).layoutPriority(1)
                Spacer(minLength: Space.sm)
                if isActiveProvider, let status = loaded?.models[info.value] { ModelStatusTags(status: status) }
                Image(icon: "checkmark").font(.riffet(size: S(11), weight: .semibold)).foregroundStyle(palette.fg2).opacity(on ? 1 : 0).frame(width: 14)
            }
            .padding(.horizontal, Space.sm).frame(maxWidth: .infinity).frame(height: 30)
            .background(hovered == info.value || (keyed && focusedModel == info.value) ? palette.bgHover : Color.clear, in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focused($focusedModel, equals: info.value).focusEffectDisabled()
        .accessibilityAddTraits(on ? .isSelected : [])
        .onKeyPress(.return) { chooseModel(info); return .handled }
        .onHover { entered in
            hovered = entered ? info.value : (hovered == info.value ? nil : hovered)
            if entered { keyed = false }
        }
    }
}

struct ModelAccountUsage: View {
    static let height: CGFloat = 40
    let account: AccountUsage?
    let loading: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            if let window = account?.windows.first {
                usageWindowView(window)
                    .padding(.horizontal, Space.md)
            } else if let account, account.limitReached {
                Label("已达用量上限", icon: "exclamationmark.circle")
                    .font(.riffet(size: S(11))).foregroundStyle(palette.danger)
            } else if let credits = account?.credits, credits.unlimited || credits.balance != nil {
                HStack {
                    Text("Credits 余额")
                    Spacer()
                    Text(credits.unlimited ? String(localized: "不限") : credits.balance!.doubleValue.rounded(.towardZero).formatted(.number.precision(.fractionLength(0))))
                        .monospacedDigit()
                }
                .font(.riffet(size: S(12))).foregroundStyle(palette.fg2)
                .padding(.horizontal, Space.md)
            } else if let plan = account?.plan, !plan.isEmpty {
                Text(plan.capitalized).font(RiffetFont.caption).foregroundStyle(palette.fg3)
            } else {
                HStack(spacing: Space.sm) {
                    if loading { Spinner(size: .mini) }
                    Text(loading ? "正在读取额度…" : "额度暂不可用").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }
        }
    }

    private func usageWindowView(_ window: UsageWindow) -> some View {
        let ratio = min(1, max(0, Double(window.usedPercent) / 100))
        let reached = account?.limitReached == true || window.usedPercent >= 100
        let tone = reached ? palette.danger : window.usedPercent >= 80 ? palette.warning : palette.fg3
        let title = window.windowMinutes == nil ? String(localized: "额度") : String(localized: "\(windowName(minutes: window.windowMinutes))额度")
        let reset = resetLabel(iso: window.resetsAt, now: platformNowMillis(), offsetOf: { KotlinLong(value: platformUtcOffsetMillis(epochMillis: $0.int64Value)) })
        return HStack(spacing: Space.sm) {
            Text(title).fixedSize()
            GeometryReader { geometry in
                Capsule().fill(palette.line)
                Capsule().fill(tone).frame(width: geometry.size.width * ratio)
            }
            .frame(height: 3)
            .accessibilityHidden(true)
            Text("剩余 \(max(0, 100 - window.usedPercent))%").monospacedDigit().fixedSize()
                .foregroundStyle(reached ? palette.danger : palette.fg2)
        }
        .font(.riffet(size: S(12))).foregroundStyle(palette.fg2)
        .help([reached ? String(localized: "已达用量上限") : nil, reset].compactMap { $0 }.joined(separator: " · "))
        .accessibilityElement(children: .combine)
        .accessibilityValue(reset ?? "")
    }
}

struct ModelStatusTags: View {
    let status: ModelStatus
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            if let quota = status.quota { tag(quotaLabel(quota: quota), tone: quota.depleted ? .danger : quota.usedPercent >= 80 ? .warning : .muted) }
            if let daily = status.dailyQuota {
                tag(dailyQuotaLabel(quota: daily), tone: .muted)
                if daily.depleted { tag(dailyQuotaLowPriorityLabel(), tone: .muted) }
            }
            if quotaUnavailable(status: status) { tag(quotaUnavailableLabel(), tone: .muted) }
            if let load = status.loadPercent?.intValue { tag(String(localized: "负载 \(load)%"), tone: loadTone(percent: Int32(load))) }
        }
        .fixedSize()
    }

    private func tag(_ text: String, tone: LoadTone) -> some View {
        let color: Color = switch tone {
        case .danger: palette.danger
        case .warning: palette.warning
        default: palette.fg3
        }
        return Text(text).font(.riffet(size: S(11)).monospacedDigit()).foregroundStyle(color)
    }
}
