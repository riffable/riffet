import SwiftUI

/// The canvas's small floating pieces. Texts come from the layout engine's table so they match the web view; the pieces that
/// follow the camera are placed by `CanvasController`, never by anything they read, so none of them re-renders as the camera moves.

/// A floating panel's surface: elevated, hairline border, soft shadow.
struct CanvasPanelStyle: ViewModifier {
    var radius: CGFloat = 10
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        content
            .background(palette.bgElevated.opacity(0.95), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }
}

extension View {
    func canvasPanel(radius: CGFloat = 10) -> some View { modifier(CanvasPanelStyle(radius: radius)) }
}

// MARK: Action bar

/// What can be done at a card, above its top-right corner: what it cost, and the actions.
struct CanvasActionBar: View {
    var facts: [String]
    var strings: [String: String]
    var canCopy: Bool
    var canOpen: Bool
    /// nil: no fork from this card; otherwise whether one is being made.
    var forking: Bool?
    var onPoint: (Bool) -> Void
    var onCopy: () -> Void
    var onOpen: () -> Void
    var onFork: () -> Void
    var onDetails: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 2) {
            if !facts.isEmpty {
                HStack(spacing: 8) { ForEach(Array(facts.enumerated()), id: \.offset) { Text(verbatim: $0.element) } }
                    .font(.riffet(size: S(11)).monospacedDigit())
                    .foregroundStyle(palette.fg3)
                    .lineLimit(1)
                    .padding(.trailing, 4)
            }
            if canCopy { button("doc.on.doc", "copy", onCopy) }
            if canOpen { button("arrow.up.right.square", "openInChat", onOpen) }
            if let forking {
                Button(action: onFork) {
                    if forking { Spinner() } else { Image(icon: "arrow.triangle.branch") }
                }
                .buttonStyle(IconButtonStyle(size: 24))
                .disabled(forking)
                .help(strings["forkFromHere"] ?? "")
            }
            button("info.circle", "details", onDetails)
        }
        .padding(.leading, 10)
        .padding(.trailing, 2)
        .padding(.vertical, 2)
        .canvasPanel()
        .fixedSize()
        .onHover(perform: onPoint)
    }

    private func button(_ icon: String, _ key: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(icon: icon) }
            .buttonStyle(IconButtonStyle(size: 24))
            .help(strings[key] ?? "")
    }
}

// MARK: Call tip

/// One call of a strip, above its mark: what it was, how long it took, and the last of what it printed.
struct CanvasCallTip: View {
    var tip: CanvasTip
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(icon: Self.symbol(tip.tool)).font(.system(size: S(10))).foregroundStyle(tip.failed == true ? palette.danger : palette.fg4)
                Text(verbatim: tip.name).font(.riffet(size: S(11), weight: .medium)).foregroundStyle(palette.fg2)
                Spacer(minLength: 12)
                Text(verbatim: tip.time).font(.riffet(size: S(11)).monospacedDigit()).foregroundStyle(palette.fg4)
            }
            if let words = tip.words {
                Text(verbatim: words).font(.riffet(size: S(12))).foregroundStyle(palette.fg).lineLimit(2)
            }
            if let code = tip.code {
                Text(verbatim: code).font(.riffet(size: S(11), design: .monospaced)).foregroundStyle(palette.fg2).lineLimit(3)
            }
            if !tip.tail.isEmpty {
                Text(verbatim: tip.tail.joined(separator: "\n"))
                    .font(.riffet(size: S(10.5), design: .monospaced))
                    .foregroundStyle(tip.failed == true ? palette.danger.opacity(0.8) : palette.fg3)
                    .lineLimit(5)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: 380, alignment: .leading)
        .canvasPanel()
        .fixedSize()
    }

    static func symbol(_ tool: String) -> String {
        switch tool {
        case "read": "doc.text"
        case "search": "magnifyingglass"
        case "edit": "pencil"
        case "execute": "terminal"
        case "fetch": "globe"
        default: "wrench"
        }
    }
}

// MARK: Track labels

/// A track's name at the start of its row.
struct CanvasTrackLabel: View {
    var name: String
    var kind: CanvasTrackKind
    var external: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            Image(icon: Self.symbol(kind)).font(.system(size: S(10))).foregroundStyle(palette.fg4)
            Text(verbatim: name)
                .font(kind == .write && external ? .riffet(size: S(10.5), design: .monospaced) : .riffet(size: S(11)))
                .foregroundStyle(kind == .write && external ? palette.fg2 : palette.fg3)
                .lineLimit(1)
                .truncationMode(external ? .head : .tail)
        }
        .padding(.horizontal, 8).padding(.vertical, 2)
        .frame(maxWidth: 180)
        .background(palette.bgSubtle.opacity(0.9), in: Capsule())
        .overlay(Capsule().strokeBorder(palette.lineSoft, lineWidth: 1))
        .fixedSize()
    }

    static func symbol(_ kind: CanvasTrackKind) -> String {
        switch kind {
        case .write: "folder"
        case .artifacts: "photo"
        case .actors: "sparkles"
        case .shell: "terminal"
        case .explore: "magnifyingglass"
        case .web: "globe"
        case .ask: "questionmark.bubble"
        case .other: "wrench"
        }
    }
}

// MARK: Controls

/// Zoom, fit, replay and latest, bottom right; clear of the inspector when it is open.
struct CanvasZoomControls: View {
    var percent: Int
    var strings: [String: String]
    var canReplay: Bool
    var canLatest: Bool
    var replaying: Bool
    var onZoom: (CGFloat) -> Void
    var onReset: () -> Void
    var onFit: () -> Void
    var onReplay: () -> Void
    var onLatest: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 2) {
            if !replaying { button("play.fill", "replay", enabled: canReplay, onReplay) }
            button("scope", "latest", enabled: canLatest, onLatest)
            button("minus", "zoomOut", enabled: true) { onZoom(1 / 1.25) }
            Button(action: onReset) {
                Text(verbatim: "\(percent)%").font(.riffet(size: S(12)).monospacedDigit()).foregroundStyle(palette.fg3).frame(width: 48)
            }
            .buttonStyle(.plain)
            button("plus", "zoomIn", enabled: true) { onZoom(1.25) }
            button("arrow.up.left.and.arrow.down.right", "showAll", enabled: true, onFit)
        }
        .padding(2)
        .canvasPanel()
    }

    private func button(_ icon: String, _ key: String, enabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(icon: icon) }
            .buttonStyle(IconButtonStyle(size: 26))
            .disabled(!enabled)
            .help(strings[key] ?? "")
    }
}

/// The replay's transport, bottom left.
struct CanvasReplayBar: View {
    var strings: [String: String]
    var count: Int
    @Binding var index: Int
    var playing: Bool
    var stamp: String
    var onToggle: () -> Void
    var onEnd: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onToggle) { Image(icon: playing ? "pause.fill" : "play.fill") }
                .buttonStyle(IconButtonStyle(size: 26))
                .help(strings[playing ? "pause" : "play"] ?? "")
            Slider(value: Binding(get: { Double(min(index, count - 1)) }, set: { index = Int($0.rounded()) }), in: 0...Double(max(count - 1, 1)))
                .controlSize(.small)
                .accessibilityLabel(strings["replayPosition"] ?? "")
            Text(verbatim: stamp).font(.riffet(size: S(11)).monospacedDigit()).foregroundStyle(palette.fg3).frame(width: 96, alignment: .trailing)
            Button(action: onEnd) { Image(icon: "xmark") }
                .buttonStyle(IconButtonStyle(size: 26))
                .help(strings["endReplay"] ?? "")
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .frame(maxWidth: 520)
        .canvasPanel(radius: 12)
    }
}

/// How fast the focus conversation is writing, while it runs.
struct CanvasPulseBadge: View {
    var pulse: CanvasPulse
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            CanvasSparkline(series: pulse.series).stroke(palette.accent, style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round)).frame(width: 36, height: 12)
            Text(verbatim: "\(Int(pulse.rate.rounded())) t/s").font(.riffet(size: S(11)).monospacedDigit())
        }
        .foregroundStyle(palette.accent)
        .padding(.horizontal, 8).padding(.vertical, 2)
        .background(palette.accentSoft, in: Capsule())
    }
}

/// The rate over the last samples, scaled to its own peak.
struct CanvasSparkline: Shape {
    var series: [Double]

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard series.count > 1, let peak = series.max(), peak > 0 else { return path }
        for (i, value) in series.enumerated() {
            let p = CGPoint(x: rect.minX + rect.width * CGFloat(i) / CGFloat(series.count - 1), y: rect.maxY - rect.height * CGFloat(value / peak))
            i == 0 ? path.move(to: p) : path.addLine(to: p)
        }
        return path
    }
}
