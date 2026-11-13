import SwiftUI

/// Where the side panel floats over the conversation, and what it keeps of its place.
enum InspectorFloat {
    /// The reader's choice for every conversation; whether the panel is open stays per conversation.
    static let floatingKey = "riffet.inspector-floating"
    static let frameKey = "riffet.inspector-float-frame"
    static let inset: CGFloat = 8
    static let snap: CGFloat = 16
    static let minimum = CGSize(width: 320, height: 240)
}

/// The floating panel's place: the last rectangle, and which container edges it is attached to. An
/// attached edge keeps its inset when the area changes size; a free panel is only kept inside.
struct FloatFrame: Codable, Equatable {
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    /// 0 until the reader sizes it: most of the area's height.
    var height: CGFloat
    var leading = false
    var trailing = false
    var top = false
    var bottom = false

    static func initial(width: CGFloat) -> FloatFrame {
        FloatFrame(x: 0, y: 0, width: width, height: 0, trailing: true, top: true)
    }

    /// The rectangle in an area of `size`.
    func resolved(in size: CGSize) -> CGRect {
        let inset = InspectorFloat.inset
        let minW = min(InspectorFloat.minimum.width, size.width), minH = min(InspectorFloat.minimum.height, size.height)
        let w = leading && trailing ? size.width - inset * 2 : min(max(width, minW), max(minW, size.width - inset * 2))
        let rawH = height > 0 ? height : size.height * 0.7
        let h = top && bottom ? size.height - inset * 2 : min(max(rawH, minH), max(minH, size.height - inset * 2))
        let left = leading ? inset : trailing ? size.width - w - inset : min(max(x, inset), max(inset, size.width - w - inset))
        let upper = top ? inset : bottom ? size.height - h - inset : min(max(y, inset), max(inset, size.height - h - inset))
        return CGRect(x: left, y: upper, width: max(w, 0), height: max(h, 0))
    }

    /// The frame of a rectangle just placed: an edge at the inset is attached.
    init(_ rect: CGRect, in size: CGSize) {
        let inset = InspectorFloat.inset
        self.init(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
        leading = abs(rect.minX - inset) < 0.5
        trailing = abs(size.width - rect.maxX - inset) < 0.5
        top = abs(rect.minY - inset) < 0.5
        bottom = abs(size.height - rect.maxY - inset) < 0.5
    }

    init(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, leading: Bool = false, trailing: Bool = false, top: Bool = false, bottom: Bool = false) {
        self.x = x; self.y = y; self.width = width; self.height = height
        self.leading = leading; self.trailing = trailing; self.top = top; self.bottom = bottom
    }
}

/// The side panel drawn over its container: dragged by its header, resized from every edge and corner,
/// snapping to the container's edges. Only the panel's frame changes while the pointer moves; the
/// conversation under it is not laid out again.
struct FloatingPanel<Content: View>: View {
    let defaultWidth: CGFloat
    @ViewBuilder let content: Content
    @AppStorage(InspectorFloat.frameKey) private var stored = ""
    @State private var live: FloatFrame?
    /// The rectangle when the current gesture began.
    @State private var origin: CGRect?

    private var storedFrame: FloatFrame {
        (try? JSONDecoder().decode(FloatFrame.self, from: Data(stored.utf8))) ?? .initial(width: defaultWidth)
    }

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let rect = (live ?? storedFrame).resolved(in: size)
            content
                .environment(\.panelDrag, { translation, ended in
                    change(size: size, ended: ended) { start in
                        var moved = start.offsetBy(dx: translation.width, dy: translation.height)
                        moved.origin.x = Self.snapped(moved.minX, length: moved.width, limit: size.width)
                        moved.origin.y = Self.snapped(moved.minY, length: moved.height, limit: size.height)
                        return moved
                    }
                })
                .frame(width: rect.width, height: rect.height)
                .floatingSurface(cornerRadius: Radius.floating)
                .overlay { resizeZones(size: size) }
                .offset(x: rect.minX, y: rect.minY)
        }
    }

    // MARK: Gestures

    /// Applies one step of a drag or resize to the rectangle the gesture began with.
    private func change(size: CGSize, ended: Bool, _ step: (CGRect) -> CGRect) {
        let start = origin ?? (live ?? storedFrame).resolved(in: size)
        origin = start
        live = FloatFrame(step(start), in: size)
        if ended {
            if let live, let data = try? JSONEncoder().encode(live) { stored = String(decoding: data, as: UTF8.self) }
            live = nil
            origin = nil
        }
    }

    /// A position within the snap distance of the container's edge goes to the inset; the container bounds it.
    private static func snapped(_ position: CGFloat, length: CGFloat, limit: CGFloat) -> CGFloat {
        let inset = InspectorFloat.inset, snap = InspectorFloat.snap
        let p = min(max(position, 0), max(limit - length, 0))
        if p < snap { return inset }
        if limit - (p + length) < snap { return limit - length - inset }
        return p
    }

    private func resize(_ edges: Edge.Set, translation: CGSize, size: CGSize, start: CGRect) -> CGRect {
        let inset = InspectorFloat.inset, snap = InspectorFloat.snap
        let minW = min(InspectorFloat.minimum.width, size.width), minH = min(InspectorFloat.minimum.height, size.height)
        var minX = start.minX, maxX = start.maxX, minY = start.minY, maxY = start.maxY
        if edges.contains(.leading) {
            minX = min(max(start.minX + translation.width, 0), start.maxX - minW)
            if minX < snap { minX = min(inset, start.maxX - minW) }
        }
        if edges.contains(.trailing) {
            maxX = min(max(start.maxX + translation.width, start.minX + minW), size.width)
            if size.width - maxX < snap { maxX = max(size.width - inset, start.minX + minW) }
        }
        if edges.contains(.top) {
            minY = min(max(start.minY + translation.height, 0), start.maxY - minH)
            if minY < snap { minY = min(inset, start.maxY - minH) }
        }
        if edges.contains(.bottom) {
            maxY = min(max(start.maxY + translation.height, start.minY + minH), size.height)
            if size.height - maxY < snap { maxY = max(size.height - inset, start.minY + minH) }
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    // MARK: Resize zones

    private func resizeZones(size: CGSize) -> some View {
        let edge: CGFloat = 6, corner: CGFloat = 14
        return ZStack {
            zone([.leading], .leading, size).frame(width: edge).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            zone([.trailing], .trailing, size).frame(width: edge).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
            zone([.top], .top, size).frame(height: edge).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            zone([.bottom], .bottom, size).frame(height: edge).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            zone([.top, .leading], .topLeading, size).frame(width: corner, height: corner).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            zone([.top, .trailing], .topTrailing, size).frame(width: corner, height: corner).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            zone([.bottom, .leading], .bottomLeading, size).frame(width: corner, height: corner).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            zone([.bottom, .trailing], .bottomTrailing, size).frame(width: corner, height: corner).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        }
    }

    private func zone(_ edges: Edge.Set, _ position: FrameResizePosition, _ size: CGSize) -> some View {
        Color.clear
            .contentShape(Rectangle())
            .pointerStyle(.frameResize(position: position))
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { value in
                        change(size: size, ended: false) { resize(edges, translation: value.translation, size: size, start: $0) }
                    }
                    .onEnded { value in
                        change(size: size, ended: true) { resize(edges, translation: value.translation, size: size, start: $0) }
                    }
            )
    }
}

// MARK: Header

/// Set by the floating panel: moves it by a drag's translation, and settles it when the drag ends.
typealias PanelDrag = (CGSize, Bool) -> Void

extension EnvironmentValues {
    @Entry var panelDrag: PanelDrag?
    /// Set where the panel's bar carries its float toggle.
    @Entry var panelFloat: PanelFloat?
}

struct PanelFloat {
    let on: Bool
    let toggle: () -> Void
}

private struct PanelDragHandle: ViewModifier {
    @Environment(\.panelDrag) private var drag

    func body(content: Content) -> some View {
        if let drag {
            // On the background only: the bar's own buttons keep their clicks.
            content.background {
                Color.clear
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 2, coordinateSpace: .global)
                            .onChanged { drag($0.translation, false) }
                            .onEnded { drag($0.translation, true) }
                    )
            }
        } else {
            content
        }
    }
}

extension View {
    /// Lets the floating panel be dragged by this bar's background; nothing in a docked panel.
    func panelDragHandle() -> some View { modifier(PanelDragHandle()) }
}

/// The panel's own drag strip, for a panel whose views draw their own top bars.
struct PanelGrip: View {
    @Environment(\.palette) private var palette

    var body: some View {
        Capsule().fill(palette.line)
            .frame(width: 32, height: 3)
            .frame(maxWidth: .infinity)
            .frame(height: 14)
            .panelDragHandle()
    }
}
