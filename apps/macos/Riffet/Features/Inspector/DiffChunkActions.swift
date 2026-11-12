import AppKit
import RiffetKit

/// What a run of changed lines in a diff can be told: the `action` the server's line route takes.
enum ChunkActionKind: String {
    case stage, unstage, discard

    var title: String {
        switch self {
        case .stage: GitCopy.stage
        case .unstage: GitCopy.unstage
        case .discard: GitCopy.discard
        }
    }
}

/// Small buttons at the first changed line of each run of a diff, kept at the viewport's right edge.
/// Everything else on the layer lets the pointer through to the lines underneath.
final class ChunkActionsLayer: NSView {
    private struct Spot {
        let row: Int
        let chunk: Int
    }

    private var spec: DiffSpec?
    private var spots: [Spot] = []
    private var kinds: [ChunkActionKind] = []
    private var buttons: [NSButton] = []
    private var key = ""
    private var onAction: ((Int, ChunkActionKind) -> Void)?

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit === self ? nil : hit
    }

    func configure(spec: DiffSpec, chunks: [GitPatchChunk], kinds: [ChunkActionKind], disabled: Bool, onAction: ((Int, ChunkActionKind) -> Void)?) {
        self.spec = spec
        self.onAction = onAction
        buttons.forEach { $0.isEnabled = !disabled }
        let next = "\(spec.lines.count)|\(spec.lines.first?.text.hashValue ?? 0)|\(spec.lines.last?.text.hashValue ?? 0)|\(spec.contentWidth)|\(spec.lineHeight)|\(kinds.map(\.rawValue))|" + chunks.map { "\($0.change.before)\($0.change.after)" }.joined()
        guard next != key else { return }
        key = next
        self.kinds = kinds
        buttons.forEach { $0.removeFromSuperview() }
        buttons = []
        spots = onAction == nil ? [] : Self.spots(spec: spec, chunks: chunks)
        for (spotIndex, _) in spots.enumerated() {
            for (kindIndex, kind) in kinds.enumerated() {
                let button = NSButton(title: kind.title, target: self, action: #selector(pressed(_:)))
                button.bezelStyle = .inline
                button.controlSize = .mini
                button.font = .systemFont(ofSize: 10, weight: .medium)
                button.tag = spotIndex * 10 + kindIndex
                button.isEnabled = !disabled
                if kind == .discard { button.contentTintColor = .systemRed }
                button.sizeToFit()
                addSubview(button)
                buttons.append(button)
            }
        }
        needsLayout = true
    }

    /// The row of each run's first changed line: a deleted line is found by its old number, an added one by its new.
    private static func spots(spec: DiffSpec, chunks: [GitPatchChunk]) -> [Spot] {
        var old: [Int: Int] = [:]
        var new: [Int: Int] = [:]
        for (row, line) in spec.lines.enumerated() {
            switch line.kind {
            case .del: if let number = Int(line.old) { old[number] = row }
            case .add: if let number = Int(line.new) { new[number] = row }
            default: break
            }
        }
        var found: [Spot] = []
        for (index, chunk) in chunks.enumerated() {
            guard chunk.change.before.count == 2, chunk.change.after.count == 2 else { continue }
            let before = Int(chunk.change.before[0].int64Value)..<Int(chunk.change.before[1].int64Value)
            let after = Int(chunk.change.after[0].int64Value)..<Int(chunk.change.after[1].int64Value)
            // Line numbers in the diff are one-based.
            let rows = [before.lazy.compactMap { old[$0 + 1] }.first, after.lazy.compactMap { new[$0 + 1] }.first].compactMap { $0 }
            if let row = rows.min() { found.append(Spot(row: row, chunk: index)) }
        }
        return found
    }

    override func layout() {
        super.layout()
        guard let spec else { return }
        let right = visibleRect.isEmpty ? bounds.maxX : visibleRect.maxX
        let perSpot = max(1, kinds.count)
        for (index, button) in buttons.enumerated() {
            let spot = spots[index / perSpot]
            let slot = index % perSpot
            let base = (index / perSpot) * perSpot
            let trailing = buttons[base + slot + 1..<base + perSpot].reduce(CGFloat(0)) { $0 + $1.frame.width + 4 }
            let height = min(button.frame.height, spec.lineHeight)
            button.frame = NSRect(x: right - 10 - button.frame.width - trailing, y: 4 + CGFloat(spot.row) * spec.lineHeight + (spec.lineHeight - height) / 2, width: button.frame.width, height: height)
        }
    }

    @objc private func pressed(_ sender: NSButton) {
        let spot = sender.tag / 10
        guard spots.indices.contains(spot), kinds.indices.contains(sender.tag % 10) else { return }
        onAction?(spots[spot].chunk, kinds[sender.tag % 10])
    }
}
