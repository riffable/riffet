import SwiftUI

/// Rows the reader orders by hand (docs/design/system/components/navigation.md, 可排序列表). Each row is the caller's
/// own, with the `SortHandle` placed before its title. Dragging the handle lifts the row and the others make room;
/// ↑ ↓ on a focused handle swap with the neighbour. `onMove` gets the new order of ids once, when the row has
/// settled; the caller shows it in the same render (an optimistic save), or the row snaps back and then jumps.
/// The list adds no container, so a `Form` keeps drawing its rows and separators.
struct SortableList<Item, ID: Hashable, Row: View>: View {
    let items: [Item]
    let id: KeyPath<Item, ID>
    let title: (Item) -> String
    let onMove: ([ID]) -> Void
    @ViewBuilder let row: (Item, SortHandle) -> Row

    @State private var drag: Drag?
    @State private var rowHeight: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.palette) private var palette

    private struct Drag {
        let id: ID
        let start: Int
        var translation: CGFloat = 0
        var settling = false
    }

    var body: some View {
        ForEach(items, id: id) { item in
            let key = item[keyPath: id]
            let index = items.firstIndex { $0[keyPath: id] == key } ?? 0
            let lifted = drag?.id == key
            row(item, handle(for: item, index: index))
                .background {
                    if lifted {
                        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                            .fill(palette.bgElevated)
                            .padding(.horizontal, -Space.sm)
                            .elevation(.pop)
                    }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowHeight = $0 }
                .offset(y: offset(at: index))
                .animation(animation(lifted: lifted), value: offset(at: index))
                .zIndex(lifted ? 1 : 0)
        }
    }

    private var animated: Bool { !reduceMotion }

    private func animation(lifted: Bool) -> Animation? {
        guard animated else { return nil }
        return lifted && drag?.settling != true ? nil : Motion.fast
    }

    private func target(of drag: Drag) -> Int {
        guard rowHeight > 0 else { return drag.start }
        return min(max(drag.start + Int((drag.translation / rowHeight).rounded()), 0), items.count - 1)
    }

    private func offset(at index: Int) -> CGFloat {
        guard let drag else { return 0 }
        let target = target(of: drag)
        if index == drag.start {
            if drag.settling { return CGFloat(target - drag.start) * rowHeight }
            return min(max(drag.translation, -CGFloat(drag.start) * rowHeight), CGFloat(items.count - 1 - drag.start) * rowHeight)
        }
        if target > drag.start, index > drag.start, index <= target { return -rowHeight }
        if target < drag.start, index < drag.start, index >= target { return rowHeight }
        return 0
    }

    private func handle(for item: Item, index: Int) -> SortHandle {
        let key = item[keyPath: id]
        let name = title(item)
        return SortHandle(
            title: name,
            canMoveUp: index > 0,
            canMoveDown: index < items.count - 1,
            dragChanged: { dy in
                guard drag == nil || drag?.id == key, drag?.settling != true else { return }
                if drag == nil { drag = Drag(id: key, start: index) }
                drag?.translation = dy
            },
            dragEnded: { settle(key) },
            step: { delta in step(key, by: delta, title: name) }
        )
    }

    private func settle(_ key: ID) {
        guard let current = drag, current.id == key, !current.settling else { return }
        let finish = {
            guard let last = drag, last.id == key else { return }
            let to = target(of: last)
            var ids = items.map { $0[keyPath: id] }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                if to != last.start { ids.insert(ids.remove(at: last.start), at: to); onMove(ids) }
                drag = nil
            }
        }
        if animated {
            withAnimation(Motion.fast, completionCriteria: .logicallyComplete) { drag?.settling = true } completion: { finish() }
        } else {
            drag?.settling = true
            finish()
        }
    }

    private func step(_ key: ID, by delta: Int, title: String) {
        guard drag == nil, let from = items.firstIndex(where: { $0[keyPath: id] == key }) else { return }
        let to = from + delta
        guard items.indices.contains(to) else { return }
        var ids = items.map { $0[keyPath: id] }
        ids.insert(ids.remove(at: from), at: to)
        withAnimation(animated ? Motion.fast : nil) { onMove(ids) }
        AccessibilityNotification.Announcement(String(localized: "\(title)：第 \(to + 1) 项，共 \(items.count) 项")).post()
    }
}

/// The grip before a sortable row's title. Focusable: ↑ ↓ move the row and the focus stays on it.
struct SortHandle: View {
    let title: String
    let canMoveUp: Bool
    let canMoveDown: Bool
    let dragChanged: (CGFloat) -> Void
    let dragEnded: () -> Void
    let step: (Int) -> Void

    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        Image(icon: "line.3.horizontal")
            .font(.riffet(size: S(DisplayPreferences.shared.style.text.body)))
            .foregroundStyle(hovering ? palette.fg2 : palette.fg4)
            .frame(width: Space.xl, height: Space.xl)
            .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(hovering ? palette.bgHover : .clear))
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .pointerStyle(.grabIdle)
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { dragChanged($0.translation.height) }
                    .onEnded { _ in dragEnded() }
            )
            .focusable()
            .onKeyPress(.upArrow) { canMoveUp ? { step(-1); return .handled }() : .ignored }
            .onKeyPress(.downArrow) { canMoveDown ? { step(1); return .handled }() : .ignored }
            .accessibilityElement()
            .accessibilityLabel(String(localized: "调整\(title)的顺序"))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(named: Text("上移")) { if canMoveUp { step(-1) } }
            .accessibilityAction(named: Text("下移")) { if canMoveDown { step(1) } }
    }
}
