import SwiftUI
import UIKit
import Observation

/// UIKit owns the scrolling geometry; each SwiftUI transcript entry is one self-sizing cell.
struct ConversationTranscriptList: UIViewControllerRepresentable {
    struct Row: Identifiable {
        let id: String
        let revision: AnyHashable
        let content: AnyView
    }

    enum Anchor: Equatable { case top, center, bottom }

    struct Request: Equatable {
        let id = UUID()
        let target: String?
        let anchor: Anchor
    }

    let rows: [Row]
    let request: Request?
    let followsTail: Bool
    let accessibilityValue: String
    let currentApprovalID: String?
    /// The floating composer's height. The list runs under it (so rows pass behind it while scrolling)
    /// but ends above it: the safe area it ignores to do so no longer reserves that space.
    var bottomInset: CGFloat = 0
    /// near bottom, at bottom, approval visible, within about two screens of the oldest loaded row.
    let onPosition: (Bool, Bool, Bool, Bool) -> Void
    let onBeginDragging: () -> Void
    let onEndDragging: (Bool) -> Void
    let onReady: () -> Void
    var onFeedbackVisibility: ((Bool) -> Void)? = nil

    func makeUIViewController(context: Context) -> Controller { Controller(configuration: self, environment: context.environment) }
    func updateUIViewController(_ controller: Controller, context: Context) { controller.update(self, environment: context.environment) }
    static func dismantleUIViewController(_ controller: Controller, coordinator: ()) { controller.tearDown() }

    @MainActor
    final class Controller: UIViewController, UICollectionViewDelegate, UIGestureRecognizerDelegate {
        private struct Position: Equatable {
            let nearBottom: Bool
            let atBottom: Bool
            let approvalVisible: Bool
            let nearTop: Bool
        }
        private struct Alignment { let target: String?; let anchor: Anchor }
        private struct ReadingAnchor { let id: String; let distanceFromTop: CGFloat }
        private enum InteractionEvent { case began, ended(Bool) }

        private var configuration: ConversationTranscriptList
        private let hostingEnvironment: TranscriptHostingEnvironment
        private var pendingParentEnvironment: EnvironmentValues?
        private var rowsByID: [String: Row] = [:]
        private var orderedIDs: [String] = []
        private var appliedRevisions: [String: AnyHashable] = [:]
        private var viewportHeight: CGFloat?
        private var lastSettledWidth: CGFloat = 0
        private var environmentRevision = 0
        private var appliedEnvironmentRevision = 0
        private var environmentRefreshScheduled = false
        private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
        private var registration: UICollectionView.CellRegistration<TranscriptCell, String>!
        private var layout: TranscriptLayout!
        private var collection: TranscriptCollectionView!
        private var applyingSnapshot = false
        private var needsSnapshot = false
        private var pendingRequest: Request?
        private var lastRequestID: UUID?
        private var pendingAlignment: Alignment?
        private var readingAnchor: ReadingAnchor?
        /// The row the reader last tapped stays where it was while what they opened settles: rows
        /// that land or fold above it, heights corrected late, the next streamed row. Released when
        /// they scroll or jump.
        private var heldRow: ReadingAnchor?
        /// Measures rows outside the list, so a row the reader opens enters at its real height.
        private var sizingHost: UIHostingController<TranscriptHostedRow>?
        /// Rows that arrived above the reader mid-fling; applied once the scroll rests, so the fling is not cut short.
        private var deferredRows = false
        private var initiallyPositioned = false
        private var positioning = false
        private var detachedByUser = false
        private var waitingForDeceleration = false
        private var active = true
        private var lifetime = UUID()
        private var readyDelivered = false
        private var readyPending = false
        private var callbacksScheduled = false
        private var pendingPosition: Position?
        private var deliveredPosition: Position?
        private var deliveredFeedbackVisibility: Bool?
        private var interactionEvents: [InteractionEvent] = []
        /// Content heights reported by hosted rows, adopted together once per run loop turn.
        private var reportedHeights: [String: CGFloat] = [:]
        private var heightFlushScheduled = false
        /// Until this time, height and row changes come from the reader's own tap and animate.
        private var animateChangesUntil: CFTimeInterval = 0
        private var appliedEnvironmentFingerprint: String?
        /// The revision each row's height was last fitted at.
        private var measuredFingerprints: [String: String] = [:]
        /// The list stays transparent until the first position and visible heights have settled.
        private var revealed = false
        private var feedbackRevealed = false
        private var revealDeadline: DispatchWorkItem?

        init(configuration: ConversationTranscriptList, environment: EnvironmentValues) {
            self.configuration = configuration
            self.hostingEnvironment = TranscriptHostingEnvironment(values: environment)
            super.init(nibName: nil, bundle: nil)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

        override func loadView() {
            // Each cell's own fitted height is the only height the layout uses;
            // the layout keeps what is above the reader still while heights settle.
            layout = TranscriptLayout()
            collection = TranscriptCollectionView(frame: .zero, collectionViewLayout: layout)
            layout.identifier = { [weak self] path in self?.dataSource?.itemIdentifier(for: path) }
            collection.backgroundColor = .clear
            collection.alwaysBounceVertical = true
            collection.keyboardDismissMode = .interactive
            // A tap on the transcript also puts the composer away; buttons and links in the rows still get the tap.
            let dismissTap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
            dismissTap.cancelsTouchesInView = false
            dismissTap.delegate = self
            collection.addGestureRecognizer(dismissTap)
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillShow), name: UIResponder.keyboardWillShowNotification, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillHide), name: UIResponder.keyboardWillHideNotification, object: nil)
            // The list runs under the bars and the composer; the safe area becomes its inset, so rows
            // scroll beneath them and the system's soft edge fades them out.
            collection.contentInsetAdjustmentBehavior = .automatic
            if #available(iOS 26.0, *) {
                collection.topEdgeEffect.style = .soft
                collection.bottomEdgeEffect.style = .soft
            }
            // Hosted content that grows later (images, math, code viewports, disclosures) resizes its own cell.
            collection.selfSizingInvalidation = .enabledIncludingConstraints
            collection.delegate = self
            collection.allowsSelection = false
            collection.accessibilityIdentifier = "conversationScroll"
            // Keep hosted text, buttons and links as accessibility children of the scroll view.
            collection.isAccessibilityElement = false
            collection.accessibilityValue = configuration.accessibilityValue
            collection.didLayout = { [weak self] in self?.layoutDidSettle() }
            collection.willScrollForAccessibility = { [weak self] in self?.heldRow = nil }
            collection.didChangeContentSize = { [weak self] in
                guard let self, self.active else { return }
                self.collection.setNeedsLayout()
            }
            view = collection
            collection.alpha = 0
            let deadline = DispatchWorkItem { [weak self] in self?.reveal() }
            revealDeadline = deadline
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: deadline)
            registration = UICollectionView.CellRegistration<TranscriptCell, String> { [weak self] cell, _, id in
                guard let row = self?.rowsByID[id] else { cell.contentConfiguration = nil; return }
                self?.configure(cell, row: row)
            }
            dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: collection) { [weak self] collection, indexPath, id in
                guard let self else { return nil }
                return collection.dequeueConfiguredReusableCell(using: self.registration, for: indexPath, item: id)
            }
            update(configuration, environment: pendingParentEnvironment ?? hostingEnvironment.values)
        }

        override func viewSafeAreaInsetsDidChange() { super.viewSafeAreaInsetsDidChange(); if isViewLoaded { collection.setNeedsLayout() } }
        override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); layoutDidSettle() }
        override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); collection.setNeedsLayout() }
        override func viewDidLoad() {
            super.viewDidLoad()
            registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitPreferredContentSizeCategory.self, UITraitDisplayScale.self]) { (controller: Controller, _: UITraitCollection) in
                controller.environmentRevision &+= 1
                controller.scheduleEnvironmentRefresh()
            }
        }

        private func configure(_ cell: TranscriptCell, row: Row) {
            // A row already measured at this width and revision skips the SwiftUI fitting pass;
            // content that changes later still reports its own height.
            let width = TranscriptLayout.columnWidth(collection.bounds.width)
            let fingerprint = "\(row.revision)|\(environmentRevision)"
            cell.knownHeight = { [weak self] in
                guard let self, let known = self.layout.knownHeight(row.id), known.width == width, self.measuredFingerprints[row.id] == fingerprint else { return nil }
                return known.height
            }
            cell.didFit = { [weak self] in self?.measuredFingerprints[row.id] = fingerprint }
            cell.backgroundConfiguration = .clear()
            cell.contentConfiguration = UIHostingConfiguration {
                TranscriptHostedRow(row: row, environment: hostingEnvironment, onRead: { [weak self] in
                    self?.beginReading(row.id)
                }, onHeight: { [weak self] height in
                    self?.contentHeightChanged(row.id, height)
                })
            }.margins(.all, 0).minSize(width: 0, height: 0)
            cell.isAccessibilityElement = false
        }

        /// Content that settles after the cell is shown (a loaded image, rendered math, a disclosure)
        /// reports its own height; this does not depend on UIKit's self-sizing invalidation.
        private func contentHeightChanged(_ id: String, _ height: CGFloat) {
            guard active, height > 0 else { return }
            reportedHeights[id] = height
            guard !heightFlushScheduled else { return }
            heightFlushScheduled = true
            let token = lifetime
            DispatchQueue.main.async { [weak self] in
                guard let self, self.active, self.lifetime == token else { return }
                self.heightFlushScheduled = false
                self.adoptReportedHeights()
            }
        }

        private func adoptReportedHeights() {
            // The snapshot completion adopts them once index paths describe the new rows.
            guard active, !applyingSnapshot, !reportedHeights.isEmpty else { return }
            let heights = reportedHeights
            reportedHeights.removeAll(keepingCapacity: true)
            let scale = max(1, collection.traitCollection.displayScale)
            let adopt = {
                for (id, height) in heights {
                    guard let path = self.dataSource.indexPath(for: id) else { continue }
                    self.layout.adopt(height: (height * scale).rounded(.up) / scale, at: path)
                }
            }
            guard animatesReaderChange else { adopt(); return }
            // A row the reader opened grows (its content hangs from the top and is clipped) while
            // the rows below slide, instead of everything jumping in one frame.
            UIView.animate(withDuration: 0.28, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]) {
                adopt()
                self.collection.layoutIfNeeded()
            }
        }

        /// Opening a conversation shows it once, already at its reading position.
        private func reveal() {
            guard active, !revealed else { return }
            revealed = true
            revealDeadline?.cancel(); revealDeadline = nil
            UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
                self.collection.alpha = 1
            } completion: { [weak self] _ in
                self?.feedbackRevealed = true
                self?.queuePosition()
            }
        }

        /// Rows and heights changing now follow from the reader's own tap.
        private var readerChanging: Bool {
            revealed && !isInteracting && CACurrentMediaTime() < animateChangesUntil
        }
        private var animatesReaderChange: Bool { readerChanging && !UIAccessibility.isReduceMotionEnabled }

        /// A cell can invalidate its height before SwiftUI delivers the parent's updated
        /// followsTail value. Detach synchronously, before the disclosure changes its state.
        private func beginReading(_ id: String) {
            guard active else { return }
            animateChangesUntil = CACurrentMediaTime() + 0.6
            detachedByUser = true
            pendingRequest = nil; pendingAlignment = nil; readingAnchor = nil
            initiallyPositioned = true
            heldRow = dataSource.indexPath(for: id).flatMap { collection.layoutAttributesForItem(at: $0) }
                .map { ReadingAnchor(id: id, distanceFromTop: $0.frame.minY - collection.contentOffset.y) }
        }

        private func updateViewportHeight() {
            let insets = collection.adjustedContentInset
            let available = collection.bounds.height - insets.top - insets.bottom
            let scale = max(1, collection.traitCollection.displayScale)
            let height = available > 0 ? (available * scale).rounded() / scale : nil
            guard viewportHeight != height else { return }
            viewportHeight = height
            environmentRevision &+= 1
            scheduleEnvironmentRefresh()
        }

        /// Never reconfigure cells from inside a collection layout callback.
        private func scheduleEnvironmentRefresh() {
            guard active, !environmentRefreshScheduled else { return }
            environmentRefreshScheduled = true
            let token = lifetime
            DispatchQueue.main.async { [weak self] in
                guard let self, self.active, self.lifetime == token else { return }
                self.environmentRefreshScheduled = false
                if let values = self.pendingParentEnvironment {
                    self.pendingParentEnvironment = nil
                    self.hostingEnvironment.values = values
                }
                if self.hostingEnvironment.viewportHeight != self.viewportHeight { self.hostingEnvironment.viewportHeight = self.viewportHeight }
                guard self.isViewLoaded else { return }
                if self.appliedEnvironmentRevision != self.environmentRevision { self.applyLatestRows() }
                self.collection.setNeedsLayout()
            }
        }

        func update(_ value: ConversationTranscriptList, environment: EnvironmentValues) {
            guard active else { return }
            let resumedTail = value.followsTail && !configuration.followsTail
            configuration = value
            // The opaque NavigationStack authority is part of EnvironmentValues. Preserve it
            // along with presentation, appearance, locale and all other parent environment.
            // Republishing it re-renders every visible row, so only do so when what rows
            // read from it changes — not on each parent update (streaming, scroll position).
            let fingerprint = Self.fingerprint(environment)
            if fingerprint != appliedEnvironmentFingerprint {
                appliedEnvironmentFingerprint = fingerprint
                pendingParentEnvironment = environment
                scheduleEnvironmentRefresh()
            }
            if resumedTail && !isInteracting { detachedByUser = false; heldRow = nil }
            if let request = value.request, request.id != lastRequestID {
                lastRequestID = request.id
                pendingRequest = request
                pendingAlignment = nil
                readingAnchor = nil; heldRow = nil
                detachedByUser = request.target != nil
            }
            // Off-screen cells read the newest row when their provider is called.
            var nextRows: [String: Row] = [:]
            var nextIDs: [String] = []
            nextRows.reserveCapacity(value.rows.count); nextIDs.reserveCapacity(value.rows.count)
            for row in value.rows {
                // A malformed caller cannot hand duplicate identifiers to diffable data source.
                if nextRows.updateValue(row, forKey: row.id) == nil { nextIDs.append(row.id) }
            }
            rowsByID = nextRows; orderedIDs = nextIDs
            guard isViewLoaded else { return }
            applyBottomInset(value.bottomInset)
            collection.accessibilityValue = value.accessibilityValue
            applyLatestRows()
            collection.setNeedsLayout()
        }

        /// Only the composer raises the keyboard; transcript text is read-only, so its selection is left alone.
        private var keyboardVisible = false
        private var tapBegan: TimeInterval = 0
        @objc private func keyboardWillShow() { keyboardVisible = true }
        @objc private func keyboardWillHide() { keyboardVisible = false }
        /// A long press selects text, so only a short tap counts.
        @objc private func dismissKeyboard() {
            guard keyboardVisible, ProcessInfo.processInfo.systemUptime - tapBegan < 0.35 else { return }
            collection.window?.endEditing(true)
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            tapBegan = touch.timestamp
            return true
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        private func applyBottomInset(_ inset: CGFloat) {
            let inset = max(0, inset.rounded())
            guard abs(collection.contentInset.bottom - inset) > 0.5 else { return }
            collection.contentInset.bottom = inset
            collection.verticalScrollIndicatorInsets.bottom = inset
            // Following the tail, the newest row stays just above the composer as it grows or shrinks.
            collection.setNeedsLayout()
        }

        private static func fingerprint(_ environment: EnvironmentValues) -> String {
            "\(environment.colorScheme)|\(environment.dynamicTypeSize)|\(environment.locale.identifier)|\(environment.palette.values.id)|\(environment.layoutDirection)|\(String(describing: environment.legibilityWeight))|\(environment.displayScale)|\(environment.conversationFeedbackActive)"
        }

        private var isInteracting: Bool { collection != nil && (collection.isTracking || collection.isDragging || collection.isDecelerating || waitingForDeceleration) }
        private var shouldFollow: Bool { configuration.followsTail && !detachedByUser && !isInteracting }

        private func applyLatestRows() {
            guard active else { return }
            if applyingSnapshot { needsSnapshot = true; return }
            var snapshot = dataSource.snapshot()
            let previousIDs = snapshot.itemIdentifiers
            let identifiersChanged = previousIDs != orderedIDs
            let previousSet = Set(previousIDs)
            // UIKit can retain prepared/prefetched cells outside the visible index paths.
            // Reconfigure every changed existing ID so those cells cannot enter with stale data;
            // diffable data source decides which prepared cells need an actual configuration.
            let changedExisting = orderedIDs.filter { id in previousSet.contains(id) && (appliedRevisions[id] != rowsByID[id]?.revision || appliedEnvironmentRevision != environmentRevision) }
            if !identifiersChanged && changedExisting.isEmpty {
                appliedRevisions = rowsByID.mapValues(\.revision)
                appliedEnvironmentRevision = environmentRevision
                return
            }
            if identifiersChanged {
                // A held row is the anchor itself.
                if heldRow == nil && !shouldFollow && pendingRequest == nil && pendingAlignment == nil,
                   let anchor = captureReadingAnchor(), rowsByID[anchor.id] != nil {
                    // Older history is read while the reader scrolls, so the anchor is kept during a
                    // drag too. A fling cannot be adjusted without stopping it: rows landing above the
                    // reader then wait for the scroll to rest.
                    if collection.isDecelerating && !collection.isTracking,
                       let before = previousIDs.firstIndex(of: anchor.id), let after = orderedIDs.firstIndex(of: anchor.id), after > before {
                        deferredRows = true
                        return
                    }
                    // History inserts between fixed metadata rows, not necessarily at index zero.
                    // An anchor not restored yet (a snapshot queued behind an animated one) still
                    // describes what the reader saw; a capture now could already include that shift.
                    if readingAnchor.map({ rowsByID[$0.id] == nil }) ?? true { readingAnchor = anchor }
                }
                snapshot = NSDiffableDataSourceSnapshot<Int, String>()
                snapshot.appendSections([0]); snapshot.appendItems(orderedIDs, toSection: 0)
                // A row the reader opens enters at its real height, so its first frame is its last:
                // no estimate-sized gaps for the rows below to slide across.
                if readerChanging { measureEntering(orderedIDs.filter { !previousSet.contains($0) }) }
            }
            if !changedExisting.isEmpty { snapshot.reconfigureItems(changedExisting) }
            let revisions = rowsByID.mapValues(\.revision)
            let environment = environmentRevision
            let token = lifetime
            applyingSnapshot = true
            dataSource.apply(snapshot, animatingDifferences: identifiersChanged && animatesReaderChange) { [weak self] in
                guard let self, self.active, self.lifetime == token else { return }
                self.appliedRevisions = revisions
                self.appliedEnvironmentRevision = environment
                self.applyingSnapshot = false
                if self.needsSnapshot { self.needsSnapshot = false; self.applyLatestRows() }
                self.adoptReportedHeights()
                self.collection.setNeedsLayout()
            }
        }

        /// Fits rows without a height at this width and revision the way their cell would, and
        /// remembers it. Only what the reader opened, and at most about a screen and a half of it:
        /// the rest is below the viewport, where an estimate moves nothing they see.
        private func measureEntering(_ ids: [String]) {
            let width = TranscriptLayout.columnWidth(collection.bounds.width)
            guard width > 0, !ids.isEmpty else { return }
            let scale = max(1, collection.traitCollection.displayScale)
            let budget = collection.bounds.height * 1.5
            var measured: CGFloat = 0
            for id in ids.prefix(64) {
                guard measured < budget, let row = rowsByID[id] else { break }
                let fingerprint = "\(row.revision)|\(environmentRevision)"
                if let known = layout.knownHeight(id), known.width == width, measuredFingerprints[id] == fingerprint {
                    measured += known.height; continue
                }
                let content = TranscriptHostedRow(row: row, environment: hostingEnvironment, onRead: {})
                let host: UIHostingController<TranscriptHostedRow>
                if let sizingHost { sizingHost.rootView = content; host = sizingHost }
                else { host = UIHostingController(rootView: content); host.safeAreaRegions = []; sizingHost = host }
                let fitted = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
                guard fitted.isFinite, fitted > 0 else { continue }
                let height = max(1, (fitted * scale).rounded(.up) / scale)
                layout.remember(height: height, width: width, for: id)
                measuredFingerprints[id] = fingerprint
                measured += height
            }
        }

        private func captureReadingAnchor() -> ReadingAnchor? {
            let visibleTop = collection.contentOffset.y + collection.adjustedContentInset.top
            let attributes = collection.indexPathsForVisibleItems.compactMap { collection.layoutAttributesForItem(at: $0) }
                .filter { $0.frame.maxY > visibleTop }.sorted { $0.frame.minY < $1.frame.minY }
            guard let first = attributes.first, let id = dataSource.itemIdentifier(for: first.indexPath) else { return nil }
            return ReadingAnchor(id: id, distanceFromTop: first.frame.minY - collection.contentOffset.y)
        }

        /// Runs only after native layout. Requests have a two-stage native scroll then exact
        /// alignment; there is no timer, content-offset nudge, or retry loop.
        private func layoutDidSettle() {
            guard active, !applyingSnapshot, !positioning, collection.bounds.width > 0, collection.bounds.height > 0 else { return }
            updateViewportHeight()
            // The column, not the window: resizing a wide window around a capped column refits nothing.
            let column = TranscriptLayout.columnWidth(collection.bounds.width)
            if lastSettledWidth != column {
                // Heights measured at the old width remain estimates; reconfigure so every cell fits again.
                let hadWidth = lastSettledWidth > 0
                lastSettledWidth = column
                if hadWidth { environmentRevision &+= 1; scheduleEnvironmentRefresh() }
            }
            positioning = true
            defer { positioning = false }
            if isInteracting, let anchor = readingAnchor {
                readingAnchor = nil
                restore(anchor)
            }
            if !isInteracting {
                if let alignment = pendingAlignment {
                    pendingAlignment = nil
                    align(alignment)
                } else if let request = pendingRequest {
                    if request.target.map({ dataSource.indexPath(for: $0) != nil }) ?? true {
                        pendingRequest = nil
                        initiallyPositioned = true
                        startAlignment(Alignment(target: request.target, anchor: request.anchor))
                    }
                } else if let held = heldRow {
                    // Restored on every pass, not only after a snapshot: a row above settling to its
                    // height, or one crossing the top edge, would otherwise move what was tapped.
                    readingAnchor = nil
                    if !restore(held) { heldRow = nil }
                } else if let anchor = readingAnchor {
                    readingAnchor = nil
                    restore(anchor)
                } else if !initiallyPositioned {
                    initiallyPositioned = true
                    if shouldFollow { startAlignment(Alignment(target: nil, anchor: .bottom)) }
                } else if shouldFollow {
                    setOffset(maximumOffset)
                } else {
                    // A shrinking viewport or snapshot must not leave a resting offset outside
                    // native content bounds. Active drag/deceleration keeps normal UIKit bounce.
                    setOffset(collection.contentOffset.y)
                }
            }
            if pendingAlignment == nil && !readyDelivered { readyPending = true }
            if !revealed && initiallyPositioned && pendingAlignment == nil && pendingRequest == nil {
                // Give the visible rows one turn to report heights that settle after display.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
                    guard let self, !self.revealed, self.reportedHeights.isEmpty, !self.heightFlushScheduled else { return }
                    self.reveal()
                }
            }
            queuePosition()
        }

        @discardableResult private func restore(_ anchor: ReadingAnchor) -> Bool {
            guard let path = dataSource.indexPath(for: anchor.id), let frame = collection.layoutAttributesForItem(at: path)?.frame else { return false }
            setOffset(frame.minY - anchor.distanceFromTop)
            return true
        }

        private func startAlignment(_ alignment: Alignment) {
            let target = alignment.target ?? dataSource.snapshot().itemIdentifiers.last
            guard let target, let path = dataSource.indexPath(for: target) else { align(alignment); return }
            pendingAlignment = alignment
            let position: UICollectionView.ScrollPosition
            if alignment.target == nil { position = .bottom }
            else { switch alignment.anchor { case .top: position = .top; case .center: position = .centeredVertically; case .bottom: position = .bottom } }
            collection.scrollToItem(at: path, at: position, animated: false)
            collection.setNeedsLayout()
        }

        private func align(_ alignment: Alignment) {
            guard let target = alignment.target else { setOffset(maximumOffset); return }
            guard let path = dataSource.indexPath(for: target), let frame = collection.layoutAttributesForItem(at: path)?.frame else { return }
            let insets = collection.adjustedContentInset
            let height = max(0, collection.bounds.height - insets.top - insets.bottom)
            switch alignment.anchor {
            case .top: setOffset(frame.minY - insets.top)
            case .center: setOffset(frame.midY - insets.top - height / 2)
            case .bottom: setOffset(frame.maxY + insets.bottom - collection.bounds.height)
            }
        }

        /// How far above the viewport (in viewports) the oldest loaded row may be before older history is read.
        private static let olderPrefetchScreens: CGFloat = 2

        private var minimumOffset: CGFloat { -collection.adjustedContentInset.top }
        private var maximumOffset: CGFloat { max(minimumOffset, collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom) }
        private func setOffset(_ proposed: CGFloat) {
            guard proposed.isFinite else { return }
            let target = min(maximumOffset, max(minimumOffset, proposed))
            if abs(collection.contentOffset.y - target) > 0.5 { collection.setContentOffset(CGPoint(x: collection.contentOffset.x, y: target), animated: false) }
        }

        private func position() -> Position {
            let remaining = max(0, maximumOffset - collection.contentOffset.y)
            var approvalVisible = false
            if let id = configuration.currentApprovalID, let path = dataSource.indexPath(for: id), let frame = collection.layoutAttributesForItem(at: path)?.frame, frame.height > 0 {
                let insets = collection.adjustedContentInset
                let viewport = CGRect(x: collection.contentOffset.x, y: collection.contentOffset.y + insets.top, width: collection.bounds.width, height: max(0, collection.bounds.height - insets.top - insets.bottom))
                let intersection = frame.intersection(viewport)
                approvalVisible = !intersection.isNull && intersection.height / frame.height >= 0.1
            }
            let insets = collection.adjustedContentInset
            let viewport = max(0, collection.bounds.height - insets.top - insets.bottom)
            // Not before the first positioning: the list is laid out from the top before it jumps to the end.
            let settled = initiallyPositioned && pendingRequest == nil && pendingAlignment == nil && viewport > 0
            let nearTop = settled && collection.contentOffset.y + insets.top <= Self.olderPrefetchScreens * viewport
            return Position(nearBottom: remaining < 80, atBottom: remaining <= 2, approvalVisible: approvalVisible, nearTop: nearTop)
        }

        private func queuePosition() {
            guard active else { return }
            pendingPosition = position()
            scheduleCallbacks()
        }

        private func scheduleCallbacks() {
            guard active, !callbacksScheduled else { return }
            callbacksScheduled = true
            let token = lifetime
            DispatchQueue.main.async { [weak self] in
                guard let self, self.active, self.lifetime == token else { return }
                self.callbacksScheduled = false
                let events = self.interactionEvents
                self.interactionEvents.removeAll(keepingCapacity: true)
                for event in events {
                    switch event { case .began: self.configuration.onBeginDragging(); case let .ended(near): self.configuration.onEndDragging(near) }
                }
                if let position = self.pendingPosition {
                    self.pendingPosition = nil
                    if position != self.deliveredPosition {
                        self.deliveredPosition = position
                        self.configuration.onPosition(position.nearBottom, position.atBottom, position.approvalVisible, position.nearTop)
                    }
                }
                if self.configuration.onFeedbackVisibility != nil {
                    let visible: Bool
                    if self.feedbackRevealed,
                       let path = self.dataSource.indexPath(for: "meta.connection"),
                       let frame = self.collection.layoutAttributesForItem(at: path)?.frame, frame.height > 0 {
                        let insets = self.collection.adjustedContentInset
                        let viewport = self.collection.bounds.inset(by: insets)
                        let intersection = frame.intersection(viewport)
                        visible = !intersection.isNull && intersection.height > 0 && intersection.width > 0
                    } else { visible = false }
                    if visible != self.deliveredFeedbackVisibility {
                        self.deliveredFeedbackVisibility = visible
                        self.configuration.onFeedbackVisibility?(visible)
                    }
                }
                if self.readyPending && !self.readyDelivered {
                    self.readyPending = false; self.readyDelivered = true
                    self.configuration.onReady()
                }
            }
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) { if !applyingSnapshot { queuePosition() } }
        func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool { heldRow = nil; return true }
        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            detachedByUser = true
            pendingRequest = nil; pendingAlignment = nil; readingAnchor = nil; heldRow = nil
            initiallyPositioned = true
            waitingForDeceleration = false
            interactionEvents.append(.began); scheduleCallbacks()
            flushDeferredRows()
        }
        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            waitingForDeceleration = decelerate
            if !decelerate { finishDragging() }
        }
        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { waitingForDeceleration = false; finishDragging() }
        private func flushDeferredRows() {
            guard deferredRows else { return }
            deferredRows = false
            applyLatestRows()
        }
        private func finishDragging() {
            flushDeferredRows()
            let current = position()
            detachedByUser = !current.nearBottom
            interactionEvents.append(.ended(current.nearBottom))
            queuePosition()
            collection.setNeedsLayout()
        }

        func tearDown() {
            active = false; lifetime = UUID()
            collection?.delegate = nil
            collection?.didLayout = nil; collection?.didChangeContentSize = nil; collection?.willScrollForAccessibility = nil
            pendingRequest = nil; pendingAlignment = nil; readingAnchor = nil; heldRow = nil; deferredRows = false
            sizingHost = nil
            interactionEvents.removeAll(); pendingPosition = nil; reportedHeights.removeAll()
            revealDeadline?.cancel(); revealDeadline = nil
            pendingParentEnvironment = nil
        }
    }
}

/// A stable observed root forwards the complete parent environment without recreating cell
/// configurations on every SwiftUI update. Publication happens outside representable updates.
@MainActor @Observable
private final class TranscriptHostingEnvironment {
    var values: EnvironmentValues
    var viewportHeight: CGFloat?
    init(values: EnvironmentValues) { self.values = values }
}

private struct TranscriptHostedRow: View {
    let row: ConversationTranscriptList.Row
    let environment: TranscriptHostingEnvironment
    let onRead: () -> Void
    var onHeight: (CGFloat) -> Void = { _ in }
    var body: some View {
        // The row always takes its ideal height, never one squeezed by a stale cell frame, and
        // reports it so the layout can follow content that settles later.
        TranscriptTopAligned {
            row.content.id(row.id)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onHeight($0) }
        }
            .environment(\.conversationReadAction, {
                onRead()
                environment.values.conversationReadAction()
            })
            .environment(\.conversationViewportHeight, environment.viewportHeight)
            .environment(\.self, environment.values)
    }
}

/// Fills the cell's height and hangs the row from its top, so a cell that is momentarily the
/// wrong height clips or pads the row's end rather than centring it. Fitting probes (no height
/// proposed, or none to speak of) get the row's ideal height.
private struct TranscriptTopAligned: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let ideal = subviews.first?.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil)) ?? .zero
        let width = proposal.width ?? ideal.width
        if let height = proposal.height, height.isFinite, height >= 1 { return CGSize(width: width, height: height) }
        return CGSize(width: width, height: ideal.height)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(width: bounds.width, height: nil))
    }
}

@MainActor
private final class TranscriptCollectionView: UICollectionView {
    var didLayout: (() -> Void)?
    var didChangeContentSize: (() -> Void)?
    /// A VoiceOver page scroll is the reader scrolling, though nothing is dragged.
    var willScrollForAccessibility: (() -> Void)?
    override var contentSize: CGSize {
        didSet { if contentSize != oldValue { didChangeContentSize?() } }
    }
    override func layoutSubviews() { super.layoutSubviews(); didLayout?() }
    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        willScrollForAccessibility?()
        return super.accessibilityScroll(direction)
    }
}

/// Hosted rows are clipped to their frame: a height that has not been adopted yet can
/// never paint over the neighbouring row.
@MainActor
final class TranscriptCell: UICollectionViewCell {
    var knownHeight: () -> CGFloat? = { nil }
    var didFit: () -> Void = {}
    override init(frame: CGRect) { super.init(frame: frame); clipsToBounds = true }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    /// Fit the height at the layout's width; the width is never the cell's to choose.
    override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
        let fitted = layoutAttributes.copy() as! UICollectionViewLayoutAttributes
        let width = layoutAttributes.size.width
        if let known = knownHeight() {
            fitted.size = CGSize(width: width, height: known)
            return fitted
        }
        defer { didFit() }
        let size = contentView.systemLayoutSizeFitting(CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
                                                       withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        let scale = max(1, traitCollection.displayScale)
        fitted.size = CGSize(width: width, height: max(1, (size.height * scale).rounded(.up) / scale))
        return fitted
    }
}

/// A single vertical column whose item heights come from the cells themselves. Heights are
/// remembered by row id, so reconfigured, reused and history-shifted rows keep their real
/// height; unseen rows start from an estimate. When a row above the reader settles to a
/// different height, the content offset absorbs the difference so nothing on screen moves.
@MainActor
final class TranscriptLayout: UICollectionViewLayout {
    var identifier: (IndexPath) -> String? = { _ in nil }
    private static let estimate: CGFloat = 96
    private var heights: [String: (width: CGFloat, height: CGFloat)] = [:]
    private var frames: [UICollectionViewLayoutAttributes] = []
    private var contentHeight: CGFloat = 0
    /// The column rows are laid out and measured at, centred in `boundsWidth`.
    private var width: CGFloat = 0
    private var boundsWidth: CGFloat = 0
    private var columnX: CGFloat = 0
    private var rebuild = true
    private var reflowFrom: Int?
    /// The frames before a batch update, kept until the update's animation is set up.
    private var previousFrames: [UICollectionViewLayoutAttributes] = []

    override var collectionViewContentSize: CGSize { CGSize(width: boundsWidth, height: contentHeight) }

    /// Rows keep a readable measure on a wide window; the scroll view still spans it, so the margins scroll too.
    static func columnWidth(_ boundsWidth: CGFloat) -> CGFloat { min(boundsWidth, RiffetMetrics.readingWidth) }

    override func invalidateLayout(with context: UICollectionViewLayoutInvalidationContext) {
        if context.invalidateEverything || context.invalidateDataSourceCounts { rebuild = true }
        super.invalidateLayout(with: context)
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        if newBounds.width != boundsWidth { rebuild = true; return true }
        return false
    }

    override func prepare() {
        super.prepare()
        guard let collectionView else { return }
        let count = collectionView.numberOfSections > 0 ? collectionView.numberOfItems(inSection: 0) : 0
        if collectionView.bounds.width != boundsWidth || count != frames.count { rebuild = true }
        boundsWidth = collectionView.bounds.width
        width = Self.columnWidth(boundsWidth)
        let scale = max(1, collectionView.traitCollection.displayScale)
        columnX = ((boundsWidth - width) / 2 * scale).rounded() / scale
        let start: Int
        if rebuild { start = 0; previousFrames = frames; frames.removeAll(keepingCapacity: true) }
        else if let from = reflowFrom, from < frames.count { start = from; frames.removeSubrange(from...) }
        else { reflowFrom = nil; return }
        rebuild = false; reflowFrom = nil
        var y = start > 0 ? frames[start - 1].frame.maxY : 0
        frames.reserveCapacity(count)
        for item in start..<count {
            let path = IndexPath(item: item, section: 0)
            let attributes = UICollectionViewLayoutAttributes(forCellWith: path)
            let height = height(for: identifier(path))
            attributes.frame = CGRect(x: columnX, y: y, width: width, height: height)
            frames.append(attributes)
            y += height
        }
        contentHeight = y
        if heights.count > 8192 {
            let live = Set((0..<count).compactMap { identifier(IndexPath(item: $0, section: 0)) })
            heights = heights.filter { live.contains($0.key) }
        }
    }

    func knownHeight(_ id: String) -> (width: CGFloat, height: CGFloat)? { heights[id] }
    /// A height fitted before the row is inserted (see `measureEntering`).
    func remember(height: CGFloat, width: CGFloat, for id: String) { heights[id] = (width, height) }

    // MARK: Opening and closing
    // The stock insert fades rows in at their place while the rows below slide across them: text
    // over text. Here an inserted run of rows unfolds from the line above it, each row clipped to its
    // growing frame (the cell clips and hangs its content from the top), so the run always fills
    // exactly the gap the rows below have opened. A removed run folds back the same way.

    /// An update made only of inserts and deletes; any other keeps the stock animation.
    private struct Update {
        let previous: [UICollectionViewLayoutAttributes]
        /// Sorted; after and before the update respectively.
        let inserted: [Int]
        let deleted: [Int]
        var unfoldLines: [Int: CGFloat] = [:]
        var foldLines: [Int: CGFloat] = [:]

        func new(forOld old: Int) -> Int {
            var new = old - deleted.prefix { $0 < old }.count
            for item in inserted where item <= new { new += 1 }
            return new
        }
        func old(forNew new: Int) -> Int {
            var old = new - inserted.prefix { $0 < new }.count
            for item in deleted where item <= old { old += 1 }
            return old
        }
    }
    private var update: Update?

    override func prepare(forCollectionViewUpdates updateItems: [UICollectionViewUpdateItem]) {
        super.prepare(forCollectionViewUpdates: updateItems)
        update = nil
        defer { previousFrames = [] }
        var inserted: [Int] = [], deleted: [Int] = []
        for item in updateItems {
            switch item.updateAction {
            case .insert: guard let path = item.indexPathAfterUpdate, path.section == 0 else { return }; inserted.append(path.item)
            case .delete: guard let path = item.indexPathBeforeUpdate, path.section == 0 else { return }; deleted.append(path.item)
            default: return
            }
        }
        guard previousFrames.count == frames.count - inserted.count + deleted.count else { return }
        var update = Update(previous: previousFrames, inserted: inserted.sorted(), deleted: deleted.sorted())
        for run in Self.runs(update.inserted) where run.upperBound < frames.count {
            let line = frames[run.lowerBound].frame.minY
            for item in run { update.unfoldLines[item] = line }
        }
        for run in Self.runs(update.deleted) {
            // The row above the run, where it is after the update.
            let above = run.lowerBound > 0 ? update.new(forOld: run.lowerBound - 1) : -1
            guard above < frames.count else { continue }
            if update.unfoldLines[above + 1] != nil {
                // Replaced in place: both runs would share one gap, so both keep the stock crossfade.
                var item = above + 1
                while update.unfoldLines.removeValue(forKey: item) != nil { item += 1 }
                continue
            }
            let line = above >= 0 ? frames[above].frame.maxY : 0
            for item in run { update.foldLines[item] = line }
        }
        self.update = update
    }

    override func finalizeCollectionViewUpdates() {
        super.finalizeCollectionViewUpdates()
        update = nil
    }

    override func initialLayoutAttributesForAppearingItem(at itemIndexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        let item = itemIndexPath.item
        guard let update, itemIndexPath.section == 0, item < frames.count else { return super.initialLayoutAttributesForAppearingItem(at: itemIndexPath) }
        if let line = update.unfoldLines[item] {
            let attributes = frames[item].copy() as! UICollectionViewLayoutAttributes
            attributes.frame = CGRect(x: attributes.frame.minX, y: line, width: attributes.frame.width, height: 0)
            attributes.alpha = 0
            return attributes
        }
        // A row that comes in from beyond the edge slides from where it was, not in place.
        let old = update.old(forNew: item)
        guard update.inserted.firstIndex(of: item) == nil, old < update.previous.count else { return super.initialLayoutAttributesForAppearingItem(at: itemIndexPath) }
        let attributes = UICollectionViewLayoutAttributes(forCellWith: itemIndexPath)
        attributes.frame = update.previous[old].frame
        return attributes
    }

    override func finalLayoutAttributesForDisappearingItem(at itemIndexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        let item = itemIndexPath.item
        guard let update, itemIndexPath.section == 0, item < update.previous.count else { return super.finalLayoutAttributesForDisappearingItem(at: itemIndexPath) }
        let attributes = UICollectionViewLayoutAttributes(forCellWith: itemIndexPath)
        if let line = update.foldLines[item] {
            let frame = update.previous[item].frame
            attributes.frame = CGRect(x: frame.minX, y: line, width: frame.width, height: 0)
            attributes.alpha = 0
            return attributes
        }
        // A row that leaves past the edge slides to where it now is.
        let new = update.new(forOld: item)
        guard update.deleted.firstIndex(of: item) == nil, new < frames.count else { return super.finalLayoutAttributesForDisappearingItem(at: itemIndexPath) }
        attributes.frame = frames[new].frame
        return attributes
    }

    /// Consecutive items of a sorted list, as ranges.
    private static func runs(_ items: [Int]) -> [ClosedRange<Int>] {
        var result: [ClosedRange<Int>] = []
        for item in items {
            if let last = result.last, last.upperBound + 1 == item { result[result.count - 1] = last.lowerBound...item }
            else { result.append(item...item) }
        }
        return result
    }

    private func height(for id: String?) -> CGFloat {
        guard let id, let known = heights[id] else { return Self.estimate }
        // A height from another width is still a better guess than the estimate.
        return known.height
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        var low = 0, high = frames.count
        while low < high {
            let mid = (low + high) / 2
            if frames[mid].frame.maxY <= rect.minY { low = mid + 1 } else { high = mid }
        }
        var result: [UICollectionViewLayoutAttributes] = []
        var index = low
        while index < frames.count, frames[index].frame.minY < rect.maxY { result.append(frames[index]); index += 1 }
        return result
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        indexPath.section == 0 && indexPath.item < frames.count ? frames[indexPath.item] : nil
    }

    override func shouldInvalidateLayout(forPreferredLayoutAttributes preferredAttributes: UICollectionViewLayoutAttributes,
                                         withOriginalAttributes originalAttributes: UICollectionViewLayoutAttributes) -> Bool {
        guard preferredAttributes.representedElementCategory == .cell, preferredAttributes.size.width == width else { return false }
        let path = originalAttributes.indexPath
        guard path.item < frames.count else { return false }
        if abs(preferredAttributes.size.height - frames[path.item].frame.height) > 0.5 { return true }
        // Same height: remember it as measured so it is no longer an estimate.
        if let id = identifier(path) { heights[id] = (width, frames[path.item].frame.height) }
        return false
    }

    override func invalidationContext(forPreferredLayoutAttributes preferredAttributes: UICollectionViewLayoutAttributes,
                                      withOriginalAttributes originalAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutInvalidationContext {
        let context = super.invalidationContext(forPreferredLayoutAttributes: preferredAttributes, withOriginalAttributes: originalAttributes)
        record(height: preferredAttributes.size.height, at: originalAttributes.indexPath, in: context)
        return context
    }

    /// Adopt a height a row reported after display (see `adoptReportedHeights`).
    func adopt(height: CGFloat, at path: IndexPath) {
        guard height > 0, path.section == 0, path.item < frames.count, abs(height - frames[path.item].frame.height) > 0.5 else { return }
        let context = UICollectionViewLayoutInvalidationContext()
        context.invalidateItems(at: [path])
        record(height: height, at: path, in: context)
        invalidateLayout(with: context)
    }

    private func record(height: CGFloat, at path: IndexPath, in context: UICollectionViewLayoutInvalidationContext) {
        guard path.section == 0, path.item < frames.count, let id = identifier(path) else { return }
        let frame = frames[path.item].frame
        heights[id] = (width, height)
        reflowFrom = min(reflowFrom ?? path.item, path.item)
        let delta = height - frame.height
        if delta != 0, keepsReaderStill(for: frame) { context.contentOffsetAdjustment.y += delta }
        if delta != 0 { invalidateFollowing(path.item, in: context) }
    }

    /// A partial invalidation only refreshes the items it names; the rows below a row that changed
    /// height move too, or a grown row (an opened thought, a loaded image) paints under the next one.
    private func invalidateFollowing(_ item: Int, in context: UICollectionViewLayoutInvalidationContext) {
        guard let collectionView, item + 1 < frames.count else { return }
        let lastVisible = collectionView.indexPathsForVisibleItems.lazy.filter { $0.section == 0 }.map(\.item).max() ?? item
        let end = min(frames.count - 1, max(lastVisible, item) + 8)
        guard end > item else { return }
        context.invalidateItems(at: (item + 1...end).map { IndexPath(item: $0, section: 0) })
    }

    /// A row entirely above the viewport always grows upward. A row crossing the top edge
    /// does so only while the reader is scrolling (it is being revealed); at rest it grows
    /// downward, so a tapped disclosure stays where the finger is.
    private func keepsReaderStill(for frame: CGRect) -> Bool {
        guard let collectionView else { return false }
        let top = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
        if frame.maxY <= top + 0.5 { return true }
        return frame.minY < top && (collectionView.isTracking || collectionView.isDragging || collectionView.isDecelerating)
    }
}
