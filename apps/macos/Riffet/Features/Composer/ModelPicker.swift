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
    /// Reserves the familiar account row before its first reading; returned account data always shows.
    var reserveAccountUsage = false
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
    /// Names the stored quota reading shown before the fresh one lands; stable across launches,
    /// unlike [scope]. Nil keeps readings in memory only.
    var usageStoreKey: String?
    /// Each provider's last full selection (provider id to selection): picking its remembered
    /// model brings its parameters back.
    var remembered: [String: String] = [:]
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
            if !open, usage != nil {
                loadingUsage = true
                // The stored reading is on the rows from the first frame; another scope's is dropped.
                if loadedKey != usageKey {
                    loaded = usageStoreKey.flatMap { storedModelUsage.load(scope: $0) }
                    loadedKey = usageKey
                }
            }
            open.toggle()
        } label: {
            HStack(spacing: 5) {
                Text(verbatim: modelLabel(catalog: activeModels, value: selection).ifEmpty("Select model"))
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
        .anchoredPopup(isPresented: $open, inset: PopoverSurface<EmptyView>.inset) {
            PopoverSurface {
                ModelPanel(catalog: catalog, selection: selection, resolved: resolved, params: params, loaded: loadedKey == usageKey ? loaded : nil,
                           reserveAccountUsage: reserveAccountUsage, loadingUsage: loadingUsage,
                           providers: providers, activeProviderId: activeProviderId, remembered: remembered,
                           choose: choose, chooseInProvider: chooseInProvider, retryProvider: retryProvider)
            }
        }
        // Directory and quota reads are independent; a slow catalog must not delay current quota.
        .task(id: open ? usageKey : nil) {
            guard open else { return }
            await refresh?()
        }
        // A provider switch writes a new usage read, so the popup's own quota follows it too.
        .task(id: open ? usageKey : nil) {
            guard open else { loadingUsage = false; return }
            let key = usageKey
            loadingUsage = true
            // Drop another provider's figures before awaiting the new read; this one's stay until
            // their replacement lands.
            if loadedKey != key {
                loaded = usageStoreKey.flatMap { storedModelUsage.load(scope: $0) }
                loadedKey = key
            }
            guard !Task.isCancelled, let usage else { loadingUsage = false; return }
            let snapshot = await usage()
            guard !Task.isCancelled else { return }
            if let snapshot {
                loaded = snapshot
                if let usageStoreKey { storedModelUsage.save(scope: usageStoreKey, usage: snapshot) }
            }
            loadingUsage = false
        }
    }

    @ViewBuilder
    private func mark(_ param: ModelParam_) -> some View {
        switch paramKind(param: param) {
        case .fast:
            // A word in the effort's own style, as the web's trigger says it.
            if isOn(param: param), !compact { Text(verbatim: "Fast").foregroundStyle(palette.fg3) }
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

/// Quota readings kept across launches, so a picker shows the last figures before its read lands (shared client).
let storedModelUsage = ModelUsageStore(preferences: createAppPreferences())

/// `pickedSelection` of the shared contract: the provider's remembered selection when it names the
/// picked model, else the parameters in force ([current]) wherever the picked model accepts them.
private func pickedSelection(catalog: [ModelInfo], model: String, current: [String: String], remembered: String?) -> String {
    if let remembered, !remembered.isEmpty,
       resolveModelSelection(catalog: catalog, selection: remembered).model == resolveModelSelection(catalog: catalog, selection: model).model {
        return remembered
    }
    return catalogSelection(catalog: catalog, model: model, overrides: current, preferredParam: nil)
}

struct ModelPanel: View {
    let catalog: [ModelInfo]
    let selection: String?
    let resolved: ParsedSelection
    let params: [ModelParam_]
    let loaded: NativeBackendUsage?
    let reserveAccountUsage: Bool
    let loadingUsage: Bool
    var providers: [ProviderModels] = []
    var activeProviderId: String?
    var remembered: [String: String] = [:]
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
    /// Beside the providers the lists are as tall as the longest provider's (a loading one is one
    /// row), so moving between providers never resizes the panel; a single list fits its catalog.
    private var rows: Int {
        guard twoColumn else { return catalog.count }
        return providers.reduce(providers.count) { max($0, $1.models?.count ?? 1) }
    }
    private var accountUsageHeight: CGFloat {
        reserveAccountUsage || loaded?.account != nil ? ModelAccountUsage.height(account: loaded?.account) : 0
    }
    /// The parameters and quota rows of the provider in force, whether or not they are shown.
    private var activeChrome: CGFloat { (params.isEmpty ? 0 : CGFloat(params.count) * 32 + 17) + (accountUsageHeight > 0 ? accountUsageHeight + 1 : 0) }
    private var chromeHeight: CGFloat { isActiveProvider ? activeChrome : 0 }
    /// While another provider is previewed its parameters are hidden, and the lists take their
    /// height: the panel keeps its size and its top edge, so the row under the pointer stays put.
    private var listHeight: CGFloat {
        min(300, CGFloat(max(1, rows)) * 30 + 12, max(42, availableSize.height - activeChrome)) + activeChrome - chromeHeight
    }
    private var orderedParams: [ModelParam_] { shownParams.sorted { Self.order($0) < Self.order($1) } }

    var body: some View {
        Group {
            if chromeHeight + 42 > availableSize.height {
                ScrollView { contents }.frame(height: availableSize.height)
            } else {
                contents
            }
        }
        // The provider column is wide enough for a name like "Claude Code" beside its check.
        .frame(width: min(twoColumn ? 440 : 320, availableSize.width), alignment: .leading)
    }

    private var contents: some View {
        VStack(alignment: .leading, spacing: 0) {
            if twoColumn {
                HStack(alignment: .top, spacing: 0) {
                    providerColumn.frame(width: 152)
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
            if accountUsageHeight > 0 && isActiveProvider {
                Divider().overlay(palette.line)
                ModelAccountUsage(account: loaded?.account, loading: loadingUsage)
                    .frame(height: accountUsageHeight)
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
                            Text(verbatim: provider.issue ?? "Loading…").font(RiffetFont.caption).foregroundStyle(palette.fg3).lineLimit(2)
                            Spacer(minLength: Space.xs)
                            if provider.issue != nil, let retryProvider {
                                Button { retryProvider(provider.id) } label: { Text(verbatim: "Retry") }
                                    .buttonStyle(.plain).font(.riffet(size: S(11))).foregroundStyle(palette.mark)
                            }
                        }
                        .padding(.horizontal, Space.sm).frame(maxWidth: .infinity, alignment: .leading).frame(height: 30)
                    }
                    ForEach(shownModels, id: \.value) { modelRow($0).id($0.value) }
                    if shownModels.isEmpty, !twoColumn || shownProvider?.models != nil {
                        Text(verbatim: "No models available").font(RiffetFont.caption).foregroundStyle(palette.fg3).frame(height: 30)
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

    private func row(_ param: ModelParam_) -> some View {
        let kind = paramKind(param: param)
        let quiet = DisplayPreferences.shared.style.ink == .quiet
        return HStack(spacing: Space.sm) {
            Text(Self.title(param, kind)).font(.riffet(size: S(13))).foregroundStyle(palette.fg2).lineLimit(1).layoutPriority(1)
            Spacer(minLength: Space.sm)
            switch kind {
            case .fast, .toggle:
                // Fast is a switch only, as on the web: a "Default" beside it was a third state with no visible effect.
                Toggle(Self.title(param, kind), isOn: Binding(get: { isOn(param: param) }, set: { value(for: param, toggledValue(param: param, on: $0, fallback: nil)) }))
                    .toggleStyle(.switch).controlSize(.mini).labelsHidden().tint(quiet ? palette.primary : palette.accent)
                    .accessibilityValue(Text(verbatim: isOn(param: param) ? "On" : "Off"))
            default:
                ChoiceMenu(options: (kind == .max ? param.options : listValues(param: param)).map { option in
                    ChoiceOption(title: optionLabel(param: param, value: option.value), selected: param.value == option.value) { value(for: param, option.value) }
                }) {
                    if quiet {
                        // A bare chip, as the composer's own: the value and a chevron, flush right.
                        HStack(spacing: Space.xs) {
                            Text(optionLabel(param: param, value: param.value)).lineLimit(1)
                            Image(icon: "chevron.down").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
                        }
                        .font(.riffet(size: S(13))).foregroundStyle(palette.fg)
                        .padding(.horizontal, Space.sm).frame(height: 26)
                        .contentShape(Rectangle())
                    } else {
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
                }
                .fixedSize()
                .accessibilityLabel(Self.title(param, kind))
            }
        }
        .frame(maxWidth: .infinity).frame(height: 32)
    }

    private static func title(_ param: ModelParam_, _ kind: ParamKind) -> String {
        switch kind {
        case .effort: "Effort"
        case .fast: "Fast"
        case .max: "Max"
        case .toggle: param.id == "thinking" ? "Thinking" : paramTitle(param: param)
        default: paramTitle(param: param)
        }
    }

    /// Commits a model. A model of the provider being previewed carries that provider along, so
    /// the choice of provider and model is one write and a preview never resets mode or approval.
    private func chooseModel(_ info: ModelInfo) {
        guard !isActiveProvider || info.value != resolved.model else { return }
        let value = pickedSelection(catalog: shownModels, model: info.value, current: resolved.params, remembered: remembered[shownProvider?.id ?? activeProviderId ?? ""])
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
    private static let rowHeight: CGFloat = 24
    private static let verticalInset: CGFloat = 8
    static func height(account: AccountUsage?) -> CGFloat {
        CGFloat(max(1, account?.windows.count ?? 0)) * rowHeight + verticalInset * 2
    }
    let account: AccountUsage?
    let loading: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            if let windows = account?.windows, !windows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(windows.enumerated()), id: \.offset) { _, window in
                        usageWindowView(window).frame(height: Self.rowHeight)
                    }
                }
                .padding(.horizontal, Space.md)
                .padding(.vertical, Self.verticalInset)
            } else if let account, account.limitReached {
                Label { Text(verbatim: "Usage limit reached") } icon: { Image(icon: "exclamationmark.circle") }
                    .font(.riffet(size: S(11))).foregroundStyle(palette.danger)
            } else if let credits = account?.credits, credits.unlimited || credits.balance != nil {
                HStack {
                    Text(verbatim: "Credits")
                    Spacer()
                    Text(verbatim: credits.unlimited ? "Unlimited" : credits.balance!.doubleValue.rounded(.towardZero).formatted(.number.precision(.fractionLength(0))))
                        .monospacedDigit()
                }
                .font(.riffet(size: S(12))).foregroundStyle(palette.fg2)
                .padding(.horizontal, Space.md)
            } else if let plan = account?.plan, !plan.isEmpty {
                Text(plan.capitalized).font(RiffetFont.caption).foregroundStyle(palette.fg3)
            } else {
                HStack(spacing: Space.sm) {
                    if loading { Spinner(size: .mini) }
                    Text(verbatim: loading ? "Reading quota…" : "Quota unavailable").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }
        }
    }

    private func usageWindowView(_ window: UsageWindow) -> some View {
        let ratio = min(1, max(0, Double(window.usedPercent) / 100))
        let reached = account?.limitReached == true || window.usedPercent >= 100
        let tone = reached ? palette.danger : window.usedPercent >= 80 ? palette.warning : palette.fg3
        let title = ModelUsageCopy.window(window.windowMinutes?.intValue)
        let reset = ModelUsageCopy.reset(window.resetsAt)
        return HStack(spacing: Space.sm) {
            Text(verbatim: title).fixedSize()
            GeometryReader { geometry in
                Capsule().fill(palette.line)
                Capsule().fill(tone).frame(width: geometry.size.width * ratio)
            }
            .frame(height: 3)
            .accessibilityHidden(true)
            Text(verbatim: "\(max(0, 100 - window.usedPercent))% left").monospacedDigit().fixedSize()
                .foregroundStyle(reached ? palette.danger : palette.fg2)
        }
        .font(.riffet(size: S(12))).foregroundStyle(palette.fg2)
        .help([reached ? "Usage limit reached" : nil, reset].compactMap { $0 }.joined(separator: " · "))
        .accessibilityElement(children: .combine)
        .accessibilityValue(reset ?? "")
    }
}

struct ModelStatusTags: View {
    let status: ModelStatus
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            if let quota = status.quota { tag(ModelUsageCopy.quota(quota), tone: quota.depleted ? .danger : quota.usedPercent >= 80 ? .warning : .muted) }
            if let daily = status.dailyQuota {
                tag("Daily \(formatQuotaAmount(value: daily.remaining))/\(formatQuotaAmount(value: daily.limit)) left", tone: .muted)
                if daily.depleted { tag("Low priority", tone: .muted) }
            }
            if quotaUnavailable(status: status) { tag("Quota unavailable", tone: .muted) }
            if let load = status.loadPercent?.intValue { tag("Load \(load)%", tone: loadTone(percent: Int32(load))) }
        }
        .fixedSize()
    }

    private func tag(_ text: String, tone: LoadTone) -> some View {
        let color: Color = switch tone {
        case .danger: palette.danger
        case .warning: palette.warning
        default: palette.fg3
        }
        return Text(verbatim: text).font(.riffet(size: S(11)).monospacedDigit()).foregroundStyle(color)
    }
}

/// Usage figures in the model panel, which reads in English throughout as the web's does (model,
/// parameter and provider names are English). Worded as the shared layer's `en` table.
enum ModelUsageCopy {
    static func window(_ minutes: Int?) -> String {
        switch minutes {
        case nil, 0: "Quota"
        case 300: "5 hours"
        case 1440: "Daily"
        case 10080: "Weekly"
        case let minutes? where (40320...44640).contains(minutes): "Monthly"
        case let minutes? where minutes % 60 == 0: "\(minutes / 60)h"
        case let minutes?: "\(minutes)m"
        }
    }

    static func quota(_ quota: ModelQuota) -> String {
        if quota.depleted { return "Quota used up" }
        if let remaining = quota.remaining, let limit = quota.limit { return "\(remaining.intValue) of \(limit.intValue) left" }
        return "\(max(0, 100 - quota.usedPercent))% left"
    }

    static func reset(_ iso: String?, now: Date = Date()) -> String? {
        guard let iso, let at = parse(iso) else { return nil }
        let left = at.timeIntervalSince(now)
        if left <= 0 { return "Resets soon" }
        if left < 3600 { return "Resets in \(max(1, Int((left / 60).rounded()))) min" }
        if left < 86400 { return "Resets in \(Int((left / 3600).rounded())) hr" }
        let day = Calendar.current.dateComponents([.month, .day], from: at)
        return "Resets on \(day.month ?? 0)/\(day.day ?? 0)"
    }

    private static func parse(_ iso: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: iso) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso)
    }
}
