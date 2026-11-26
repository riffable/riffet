import SwiftUI
import UserNotifications
import RiffetKit

// First-launch pages (patterns.md §1.5): full screen, one decision a page, 跳过 on every page. Shown once
// per device, and only when no server was ever paired; skipping or finishing lands on 新会话, where the
// setup card carries on with what is left.

private enum OnboardingPage { case welcome, connect, notify }

/// The page title: larger than any text role, which are all for lists and bars.
private struct OnboardingTitle: ViewModifier {
    @ScaledMetric(relativeTo: .title) private var size: CGFloat = 28
    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: .semibold)) // design-rules: allow onboarding title is above the text scale
    }
}

struct OnboardingView: View {
    @Bindable var model: AppModel
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page = OnboardingPage.welcome
    @State private var asksNotifications = true
    @State private var discovery = BonjourDiscovery()
    @State private var target: PairingPrefill?
    @State private var requesting = false

    private var segments: Int { asksNotifications ? 2 : 1 }
    private var position: Int { page == .connect ? 1 : page == .notify ? 2 : 0 }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                topBar
                Group {
                    switch page {
                    case .welcome: welcome.riffetTypeBoundary()
                    case .connect: connect.riffetTypeBoundary()
                    case .notify: notify.riffetTypeBoundary()
                    }
                }
                .id(page)
                .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))
            }
            .background(palette.bg.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $target) { prefill in
                PairingView(model: model, initialAddress: prefill.address, initialName: prefill.name, initialScan: prefill.scan)
            }
        }
        .task {
            await RiffetNotifications.shared.refreshAuthorization()
            asksNotifications = RiffetNotifications.shared.authorization == .notDetermined
        }
        .onChange(of: page) { _, now in
            if now == .connect { discovery.start() } else { discovery.stop() }
        }
        // Pairing ends the connect page, however it was reached.
        .onChange(of: model.workbench != nil) { _, connected in
            if connected, page == .connect { target = nil; afterConnect() }
        }
        .onDisappear { discovery.stop() }
    }

    private func go(_ next: OnboardingPage) {
        withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) { page = next }
    }
    private func afterConnect() {
        if asksNotifications { go(.notify) } else { model.finishOnboarding() }
    }

    // MARK: Chrome

    private var topBar: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: 72, height: RiffetMetrics.hitTarget)
            HStack(spacing: 6) {
                if page != .welcome {
                    ForEach(1...segments, id: \.self) { index in
                        Capsule().fill(index <= position ? palette.fg : palette.fg4.opacity(0.4)).frame(width: 28, height: 3)
                    }
                }
            }
            .frame(maxWidth: .infinity)
            Button(String(localized: "跳过", bundle: .riffet)) { model.finishOnboarding() }
                .riffetFont(.body).foregroundStyle(palette.fg2)
                .frame(width: 72, height: RiffetMetrics.hitTarget, alignment: .trailing)
                .disabled(model.connectionBusy)
        }
        .padding(.horizontal, RiffetMetrics.pageInset)
    }

    private func heading(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).modifier(OnboardingTitle()).foregroundStyle(palette.fg)
            Text(subtitle).riffetFont(.body).foregroundStyle(palette.fg3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func bottom<Buttons: View>(@ViewBuilder _ buttons: () -> Buttons) -> some View {
        VStack(spacing: 8) { buttons() }
            .padding(.horizontal, RiffetMetrics.pageInset).padding(.bottom, RiffetMetrics.groupInset).padding(.top, RiffetMetrics.floatingGap)
    }

    // MARK: Pages

    private var welcome: some View {
        VStack(spacing: 0) {
            VStack(spacing: 16) {
                LiveBrandMark(front: palette.fg, back: palette.accent, style: .draw, once: true).frame(width: 120, height: 120)
                Text("Riffet").modifier(OnboardingTitle()).foregroundStyle(palette.fg) // i18n-ignore: product name
                Text(String(localized: "在任何设备上查看和接手电脑上的编程 Agent", bundle: .riffet))
                    .riffetFont(.body).foregroundStyle(palette.fg3).multilineTextAlignment(.center)
            }
            .padding(.horizontal, RiffetMetrics.pageInset)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            bottom {
                Button { go(.connect) } label: { Text(String(localized: "开始", bundle: .riffet)).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).tint(palette.primary).foregroundStyle(palette.primaryFg).controlSize(.large)
            }
        }
    }

    private var connect: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    heading(String(localized: "连接你的电脑", bundle: .riffet),
                            String(localized: "二维码在电脑上 Riffet 设置的「设备管理」里", bundle: .riffet))
                    ServerRowList {
                        ForEach(discovery.servers) { found in
                            LanServerRow(found: found) { target = PairingPrefill(address: found.baseURL, name: found.name) }
                        }
                    }
                    if let error = model.error { RiffetNotice(kind: .error, message: error, boxed: true) }
                }
                .padding(.horizontal, RiffetMetrics.pageInset).padding(.top, RiffetMetrics.pageInset * 1.5)
            }
            bottom {
                Button { target = PairingPrefill(scan: true) } label: {
                    Label(String(localized: "扫码配对", bundle: .riffet), systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).tint(palette.primary).foregroundStyle(palette.primaryFg).controlSize(.large)
                .accessibilityIdentifier("pairNew")
                Button { target = PairingPrefill() } label: {
                    Text(String(localized: "输入地址", bundle: .riffet)).frame(maxWidth: .infinity, minHeight: RiffetMetrics.hitTarget)
                }
                .buttonStyle(.borderless)
            }
        }
    }

    private var notify: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 28) {
                heading(String(localized: "需要你时通知你", bundle: .riffet),
                        String(localized: "Agent 等待审批、提问或完成时", bundle: .riffet))
                sampleNotification
            }
            .padding(.horizontal, RiffetMetrics.pageInset).padding(.top, RiffetMetrics.pageInset * 1.5)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            bottom {
                Button {
                    guard !requesting else { return }
                    requesting = true
                    Task {
                        _ = try? await RiffetNotifications.shared.requestAuthorization()
                        requesting = false
                        model.finishOnboarding()
                    }
                } label: { Text(String(localized: "允许通知", bundle: .riffet)).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).tint(palette.primary).foregroundStyle(palette.primaryFg).controlSize(.large).disabled(requesting)
                Button { model.finishOnboarding() } label: {
                    Text(String(localized: "以后再说", bundle: .riffet)).frame(maxWidth: .infinity, minHeight: RiffetMetrics.hitTarget)
                }
                .buttonStyle(.borderless).disabled(requesting)
            }
        }
    }

    /// What the permission is for, drawn as the banner it will be.
    private var sampleNotification: some View {
        HStack(spacing: 12) {
            AppIconTile(accent: palette.accent, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(String(localized: "kiln · 运行命令", bundle: .riffet)).riffetFont(.headline).foregroundStyle(palette.fg).lineLimit(1)
                Text(String(localized: "pnpm install 等待确认", bundle: .riffet)).riffetFont(.body).foregroundStyle(palette.fg2).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(RiffetMetrics.floatingGap * 1.5)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: RiffetMetrics.groupRadius, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}
