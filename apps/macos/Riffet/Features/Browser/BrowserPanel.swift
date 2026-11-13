import SwiftUI
import RiffetKit

// The browser plugin's side panel (docs/BROWSER.md §5): the open conversation's browser, live. The web panel
// (`plugins/riffet/browser/web/BrowserPanel.tsx`) is the reference; this one is native, frames drawn by a layer.

struct BrowserPanel: View {
    let workbench: Workbench
    let project: Project

    var body: some View {
        if let session = workbench.selected, session.projectId == project.id {
            BrowserContent(sessionId: session.id).id(session.id)
        } else {
            Color.clear
        }
    }
}

private struct BrowserContent: View {
    @State private var live: BrowserLive
    @State private var address = ""
    @FocusState private var editing: Bool
    @Environment(\.inspectorPanelVisible) private var visible
    @Environment(\.palette) private var palette

    init(sessionId: String) { _live = State(initialValue: BrowserLive(sessionId: sessionId)) }

    private var state: BrowserLiveState? { live.state }
    private var running: Bool { !(state?.tabs.isEmpty ?? true) }
    private var activeURL: String { state?.tabs.first(where: \.active)?.url ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            PanelRule()
            if let tabs = state?.tabs, tabs.count > 1 {
                tabStrip(tabs)
                PanelRule()
            }
            if let pending = state?.pending {
                pendingBar(pending)
                PanelRule()
            }
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // Connected only while the panel is on screen.
        .task(id: visible) {
            guard visible else { return }
            await live.run()
        }
        .onChange(of: activeURL, initial: true) { _, url in if !editing { address = url } }
    }

    private var toolbar: some View {
        HStack(spacing: Space.xs) {
            navButton("chevron.left", label: "后退") { live.command("back") }
            navButton("chevron.right", label: "前进") { live.command("forward") }
            navButton("arrow.clockwise", label: "刷新") { live.command("reload") }
            TextField("地址", text: $address)
                .textFieldStyle(.plain)
                .font(.riffet(size: S(12)))
                .focused($editing)
                .disabled(!(state?.installed ?? false))
                .onSubmit {
                    let url = address.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !url.isEmpty { live.navigate(url) }
                    editing = false
                }
                .padding(.horizontal, Space.sm)
                .frame(height: 26)
                .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, Space.xs + 2)
    }

    private func navButton(_ icon: String, label: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(icon: icon).font(.riffet(size: S(12))) }
            .buttonStyle(IconButtonStyle(size: 24))
            .disabled(!running)
            .help(Text(label))
            .accessibilityLabel(Text(label))
    }

    private func tabStrip(_ tabs: [BrowserLiveTab]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.xs) {
                ForEach(tabs) { tab in
                    Button { live.select(tab.id) } label: {
                        Text(verbatim: tab.title.isEmpty ? tab.url : tab.title)
                            .lineLimit(1).truncationMode(.tail)
                            .font(.riffet(size: S(12)))
                            .foregroundStyle(tab.active ? palette.fg : palette.fg3)
                            .frame(maxWidth: 160)
                            .padding(.horizontal, Space.sm)
                            .frame(height: 22)
                            .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(tab.active ? palette.bgHover : .clear))
                    }
                    .buttonStyle(.plain)
                    .help(Text(verbatim: tab.url))
                }
            }
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs)
        }
    }

    private func pendingBar(_ pending: BrowserPending) -> some View {
        HStack(spacing: Space.sm) {
            if pending.kind == "confirm" {
                (Text(category(pending.category)) + Text(verbatim: " · \(pending.target ?? "")"))
                    .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                Button("拒绝") { live.answer(pending.id, allow: false) }.buttonStyle(SolidButtonStyle(kind: .secondary))
                Button("允许") { live.answer(pending.id, allow: true) }.buttonStyle(SolidButtonStyle(kind: .primary))
            } else {
                Text(verbatim: pending.reason ?? "").lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                Button("完成") { live.command("done") }.buttonStyle(SolidButtonStyle(kind: .primary))
            }
        }
        .font(.riffet(size: S(12)))
        .foregroundStyle(palette.fg)
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(palette.warning.opacity(0.12))
    }

    private func category(_ value: String?) -> LocalizedStringKey {
        switch value {
        case "send": "发送"
        case "submit": "提交"
        case "delete": "删除"
        case "order": "下单"
        default: "付款"
        }
    }

    @ViewBuilder private var content: some View {
        ZStack {
            palette.bgSubtle
            if let state, !state.installed {
                Text("需要先选择或下载浏览器").font(.riffet(size: S(13))).foregroundStyle(palette.fg3)
                    .multilineTextAlignment(.center).padding(Space.lg)
            } else if !running {
                Image(icon: "globe").font(.riffet(size: S(28))).foregroundStyle(palette.fg4)
            } else {
                BrowserCanvas(live: live, image: live.frame, viewport: CGSize(width: state?.viewport.width ?? 1280, height: state?.viewport.height ?? 800))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
