import SwiftUI

/// Arc-style colour canvas, the Mac twin of `apps/web/src/app/settings/ThemeCanvas.tsx`. The angle
/// around the centre is the hue and the distance from it is how much colour: the first point tints
/// the surfaces, the optional second one is the accent and the third the sidebar. Moving the surface
/// point carries the others round with it, so a pairing survives a change of hue.
struct ThemeCanvasView: View {
    let seed: CachedThemeSeed
    let onChange: (CachedThemeSeed) -> Void
    @Environment(\.palette) private var palette
    /// The point being dragged and the seed as the drag found it. Every step is computed from that
    /// snapshot, so steps that arrive before a redraw cannot build on a stale seed.
    @State private var drag: (index: Int, start: CachedThemeSeed)?

    /// The share of the canvas width between the centre and full colour.
    static let reach = 0.44
    /// A press this close to a point picks that point up instead of moving the surface point.
    private static let grab = 24.0

    private struct Preset {
        let name: LocalizedStringResource
        let points: [CachedThemeSeed.Point]
    }

    private static let presets: [Preset] = [
        Preset(name: "石墨", points: [.init(hue: 258, radius: 0.13), .init(hue: 265, radius: 0.96)]),
        Preset(name: "纸张", points: [.init(hue: 80, radius: 0.45), .init(hue: 45, radius: 0.75)]),
        Preset(name: "沙丘", points: [.init(hue: 65, radius: 0.5), .init(hue: 200, radius: 0.6)]),
        Preset(name: "苔藓", points: [.init(hue: 140, radius: 0.35), .init(hue: 150, radius: 0.6)]),
        Preset(name: "海", points: [.init(hue: 230, radius: 0.4), .init(hue: 235, radius: 0.8)]),
        Preset(name: "暮色", points: [.init(hue: 300, radius: 0.35), .init(hue: 290, radius: 0.7)]),
        Preset(name: "玫瑰", points: [.init(hue: 10, radius: 0.35), .init(hue: 15, radius: 0.8)]),
        Preset(name: "素", points: [.init(hue: 0, radius: 0), .init(hue: 0, radius: 0)]),
    ]

    var body: some View {
        VStack(spacing: Space.md) {
            GeometryReader { geometry in
                let side = geometry.size.width
                ZStack {
                    ThemeCanvasWheel()
                    ForEach(seed.points.indices, id: \.self) { index in
                        dot(index, side: side)
                    }
                }
                .frame(width: side, height: side)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in move(to: value.location, from: value.startLocation, side: side) }
                        .onEnded { _ in drag = nil }
                )
                .overlay(alignment: .bottom) { controls.padding(.bottom, Space.sm) }
            }
            .aspectRatio(1, contentMode: .fit)
            .background(palette.bgSubtle)
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.line))

            HStack(spacing: 0) {
                ForEach(Self.presets.indices, id: \.self) { index in
                    let preset = Self.presets[index]
                    if index > 0 { Spacer(minLength: Space.xxs) }
                    Button {
                        onChange(CachedThemeSeed(points: preset.points, softness: seed.softness))
                    } label: {
                        Circle()
                            .fill(LinearGradient(
                                stops: [
                                    .init(color: color(ThemeSeedMath.pointColor(preset.points[0])), location: 0.5),
                                    .init(color: color(ThemeSeedMath.pointColor(preset.points[1])), location: 0.5),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ))
                            .overlay(Circle().strokeBorder(palette.line))
                            .frame(width: 22, height: 22)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .help(Text(preset.name))
                    .accessibilityLabel(Text(preset.name))
                }
            }

            Slider(value: Binding(get: { seed.softness }, set: { value in
                var next = seed
                next.softness = value
                onChange(next)
            }), in: 0...1)
            .labelsHidden()
            .controlSize(.small)
            .tint(palette.accent)
            .accessibilityLabel(Text("柔和度"))
        }
    }

    // MARK: - Points

    private func role(_ index: Int) -> String {
        [String(localized: "底色"), String(localized: "强调色"), String(localized: "侧栏色")][index]
    }

    private func offset(_ point: CachedThemeSeed.Point, side: Double) -> CGSize {
        let angle = point.hue * .pi / 180
        let reach = point.radius * side * Self.reach
        return CGSize(width: reach * sin(angle), height: -reach * cos(angle))
    }

    private func dot(_ index: Int, side: Double) -> some View {
        let point = seed.points[index]
        let size: CGFloat = index == 0 ? 28 : 22
        return Circle()
            .fill(color(ThemeSeedMath.pointColor(point)))
            .overlay(Circle().strokeBorder(.white, lineWidth: index == 0 ? 3 : 2.5))
            .frame(width: size, height: size)
            .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
            .offset(offset(point, side: side))
            .accessibilityElement()
            .accessibilityLabel(Text(role(index)))
            .accessibilityAdjustableAction { direction in
                var next = point
                next.hue = (point.hue + (direction == .increment ? 5 : 355)).truncatingRemainder(dividingBy: 360)
                place(index, at: next, from: seed)
            }
    }

    private func move(to location: CGPoint, from start: CGPoint, side: Double) {
        let current = drag ?? (index: nearest(start, side: side), start: seed)
        drag = current
        let x = location.x - side / 2
        let y = location.y - side / 2
        let hue = (atan2(x, -y) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
        let radius = min(1, hypot(x, y) / (side * Self.reach))
        place(current.index, at: .init(hue: hue, radius: radius), from: current.start)
    }

    /// The point under [location], or the surface point when the press is on open canvas.
    private func nearest(_ location: CGPoint, side: Double) -> Int {
        let distances = seed.points.indices.map { index -> (Int, Double) in
            let at = offset(seed.points[index], side: side)
            return (index, hypot(location.x - side / 2 - at.width, location.y - side / 2 - at.height))
        }
        return distances.filter { $0.1 <= Self.grab }.min { $0.1 < $1.1 }?.0 ?? 0
    }

    private func place(_ index: Int, at point: CachedThemeSeed.Point, from start: CachedThemeSeed) {
        var points = start.points
        if index == 0 {
            let turn = point.hue - start.points[0].hue
            for other in points.indices.dropFirst() {
                points[other].hue = (points[other].hue + turn + 360).truncatingRemainder(dividingBy: 360)
            }
        }
        points[index] = point
        onChange(CachedThemeSeed(points: points, softness: start.softness))
    }

    // MARK: - Controls

    private var controls: some View {
        let count = seed.points.count
        let remove = count == 3 ? String(localized: "移除侧栏色") : String(localized: "移除强调色")
        let add = count == 1 ? String(localized: "添加强调色") : String(localized: "添加侧栏色")
        return HStack(spacing: Space.xxs) {
            Button {
                onChange(CachedThemeSeed(points: Array(seed.points.dropLast()), softness: seed.softness))
            } label: { Image(icon: "minus") }
            .disabled(count == 1)
            .help(remove)
            .accessibilityLabel(remove)
            if count > 1 {
                Button {
                    onChange(ThemeSeedMath.nextHarmony(seed))
                } label: { Image(icon: "arrow.triangle.2.circlepath") }
                .help(Text("换一种搭配"))
                .accessibilityLabel(Text("换一种搭配"))
            }
            Button {
                onChange(ThemeSeedMath.addPoint(seed))
            } label: { Image(icon: "plus") }
            .disabled(count == 3)
            .help(add)
            .accessibilityLabel(add)
        }
        .buttonStyle(IconButtonStyle(size: 24))
        .padding(Space.xxs)
        .background(palette.bgElevated, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
        .shadow(color: .black.opacity(0.08), radius: 1.5, y: 1)
    }
}

/// The dotted colour field behind the points: each dot shows the colour a point would take there.
/// It has no inputs, so a drag redraws the points and never this.
private struct ThemeCanvasWheel: View {
    var body: some View {
        Canvas { context, size in
            let spacing = 11.0
            let radius = 1.3
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let columns = Int(size.width / spacing)
            let rows = Int(size.height / spacing)
            let origin = CGPoint(x: center.x - Double(columns / 2) * spacing, y: center.y - Double(rows / 2) * spacing)
            for row in 0...rows {
                for column in 0...columns {
                    let x = origin.x + Double(column) * spacing
                    let y = origin.y + Double(row) * spacing
                    guard x > 2, y > 2, x < size.width - 2, y < size.height - 2 else { continue }
                    let dx = x - center.x
                    let dy = y - center.y
                    let hue = (atan2(dx, -dy) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
                    let reach = min(1, hypot(dx, dy) / (size.width * ThemeCanvasView.reach))
                    let rgba = ThemeSeedMath.pointColor(.init(hue: hue, radius: reach))
                    context.fill(
                        Path(ellipseIn: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)),
                        with: .color(color(rgba))
                    )
                }
            }
        }
        .accessibilityHidden(true)
    }
}

private func color(_ rgba: ThemeSeedMath.Rgba) -> Color {
    Color(.sRGB, red: rgba.r / 255, green: rgba.g / 255, blue: rgba.b / 255, opacity: rgba.a)
}

/// The live preview: a small Riffet window — sidebar, a conversation with a diff, the composer —
/// painted by the draft, so a palette is judged where it will live. It mirrors the web preview in
/// `ThemeEditor.tsx`.
struct ThemeWindowPreview: View {
    let colors: DraftColors

    var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 128)
            main
                .padding([.vertical, .trailing], 6)
        }
        .font(.riffet(size: S(11)))
        .foregroundStyle(colors.fg)
        .frame(maxWidth: .infinity, minHeight: 300, alignment: .topLeading)
        .background(colors.bgSidebar)
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(colors.line))
        .accessibilityHidden(true)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 6) {
                BrandMark(front: colors.fg, back: colors.accent).frame(width: 14, height: 14)
                Text(verbatim: "Riffet").font(.riffet(size: S(12), weight: .semibold))
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 6)
            navRow("square.and.pencil", "新会话")
            navRow("magnifyingglass", "搜索内容")
            navRow("calendar.badge.clock", "自动化")
            Text("项目")
                .font(.riffet(size: S(10)))
                .foregroundStyle(colors.fg4)
                .padding(.horizontal, 6)
                .padding(.top, 10)
                .padding(.bottom, 4)
            navRow("folder", nil, verbatim: "riffet")
            sessionRow("主题画板", active: true)
            sessionRow("同步失败排查", active: false)
            sessionRow("发布说明", active: false)
            Spacer(minLength: 0)
        }
        .padding(8)
    }

    private func navRow(_ symbol: String, _ title: LocalizedStringKey?, verbatim: String? = nil) -> some View {
        HStack(spacing: 6) {
            Image(icon: symbol)
                .font(.riffet(size: S(10)))
                .foregroundStyle(colors.fg3)
                .frame(width: 12)
            if let title { Text(title) } else { Text(verbatim: verbatim ?? "") }
        }
        .foregroundStyle(colors.fg2)
        .lineLimit(1)
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
    }

    private func sessionRow(_ title: LocalizedStringKey, active: Bool) -> some View {
        HStack(spacing: 4) {
            Text(title).lineLimit(1)
            Spacer(minLength: 0)
            if active {
                Circle().fill(colors.accent).frame(width: 5, height: 5)
            }
        }
        .foregroundStyle(active ? colors.fg : colors.fg2)
        .padding(.leading, 24)
        .padding(.trailing, 6)
        .padding(.vertical, 4)
        .background(active ? colors.bgActive : .clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }

    private var main: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text("主题画板").font(.riffet(size: S(11), weight: .medium))
                Spacer(minLength: 0)
                Circle().fill(colors.agentClaude).frame(width: 5, height: 5)
                Text(verbatim: "Claude").foregroundStyle(colors.fg3)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            Rectangle().fill(colors.lineSoft).frame(height: 1)
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Spacer(minLength: 40)
                    Text("把配色改成画板")
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(colors.bgBubble, in: RoundedRectangle(cornerRadius: Radius.floating, style: .continuous))
                }
                Text("改好了，入口在 \(Text(verbatim: "ThemeCanvas.swift").foregroundStyle(colors.accent))。")
                diff
                Text("2 个文件 · 用时 1 分钟").foregroundStyle(colors.fg3)
                Spacer(minLength: 0)
            }
            .padding(12)
            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.bg, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
    }

    private var diff: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: "theme-seed.ts")
                .foregroundStyle(colors.fg3)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(colors.bgSubtle)
            Rectangle().fill(colors.lineSoft).frame(height: 1)
            diffLine("+ ", "points: [surface, accent]", marker: colors.diffAddMarker, fill: colors.diffAdd)
            diffLine("- ", "palette: copy(builtin)", marker: colors.diffDelMarker, fill: colors.diffDel)
        }
        .font(.riffet(size: S(10), design: .monospaced))
        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(colors.line))
    }

    private func diffLine(_ sign: String, _ code: String, marker: Color, fill: Color) -> some View {
        (Text(verbatim: sign).foregroundColor(marker) + Text(verbatim: code))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("继续描述…").foregroundStyle(colors.fg4)
            HStack(spacing: 8) {
                Image(icon: "plus").font(.riffet(size: S(10))).foregroundStyle(colors.fg3)
                Spacer(minLength: 0)
                Text(verbatim: "Claude").foregroundStyle(colors.fg3)
                Image(icon: "arrow.up")
                    .font(.riffet(size: S(9), weight: .bold))
                    .foregroundStyle(colors.primaryFg)
                    .frame(width: 20, height: 20)
                    .background(colors.primary, in: Circle())
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(colors.bgElevated, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(colors.line))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
    }
}
