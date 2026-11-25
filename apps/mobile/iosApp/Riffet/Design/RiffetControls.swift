import SwiftUI
import UIKit

// Controls of docs/design/system/ios.md §5–7 the system does not have: view tabs, the toggle chip, the
// unsaved-changes guard of an edit sheet, and motion that gives way to Reduce Motion.

// MARK: - Reduce Motion

extension RiffetMotion {
    /// `animation`, or none under Reduce Motion: a selection mark jumps instead of sliding, a chevron
    /// turns at once. Opacity changes stay with the system's own transitions.
    static func unlessReduced(_ animation: Animation, _ reduce: Bool) -> Animation? { reduce ? nil : animation }
}

struct RiffetAnimation<V: Equatable>: ViewModifier {
    let animation: Animation
    let value: V
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.animation(RiffetMotion.unlessReduced(animation, reduceMotion), value: value)
    }
}

extension View {
    /// `.animation(_:value:)` that stops moving things under Reduce Motion.
    /// Returns the concrete modified type, not `some View`: iOS 27's runtime crashed resolving the opaque
    /// type of this generic method (2026-11-15, see ios.md §2).
    func riffetAnimation<V: Equatable>(_ animation: Animation, value: V) -> ModifiedContent<Self, RiffetAnimation<V>> {
        modifier(RiffetAnimation(animation: animation, value: value))
    }
}

// MARK: - Type boundary

extension View {
    /// Ends the static view type here. SwiftUI resolves a page's whole view type when it first shows the
    /// page, recursively and on the main thread's stack; on iOS 27 a deep page overflowed it (ios.md §2,
    /// 2026-11-15). A page's large blocks (a composer card, a menu's items, a list's content) go behind this
    /// boundary so no single type grows deep. Not for rows of a list: it costs diffing there.
    func riffetTypeBoundary() -> AnyView { AnyView(self) }
}

// MARK: - View tabs

/// The views of one page (Git's changes, history, checkpoints, worktrees): a row of text tabs under the
/// bar that scrolls sideways, so a label is never cut. The selected tab is in ink with a bar under it
/// that slides between tabs; the rest in the second text colour. Two or three short options are a
/// segmented picker instead (ios.md §5).
struct RiffetViewTabs<Value: Hashable>: View {
    struct Item: Identifiable {
        let value: Value
        let title: String
        var id: Value { value }
    }
    let items: [Item]
    @Binding var selection: Value
    @Namespace private var indicator
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 22) {
                ForEach(items) { item in
                    let selected = item.value == selection
                    Button {
                        withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) { selection = item.value }
                    } label: {
                        Text(item.title)
                            .riffetFont(.label)
                            .foregroundStyle(selected ? palette.fg : palette.fg2)
                            .fixedSize()
                            .frame(minHeight: RiffetMetrics.hitTarget)
                            .overlay(alignment: .bottom) {
                                if selected {
                                    Capsule().fill(palette.fg).frame(height: 2)
                                        .matchedGeometryEffect(id: "tab", in: indicator)
                                }
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(RiffetDimPressStyle())
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .padding(.horizontal, RiffetMetrics.pageInset)
        }
        .scrollClipDisabled()
        .overlay(alignment: .bottom) { Rectangle().fill(palette.line).frame(height: 0.5) }
    }
}

// MARK: - Toggle chip

/// A chip that is a switch (Fast, Max): same capsule, height and press as `RiffetChipBar`; on, it takes
/// the selected fill. Never a check: chips mark selection by fill alone.
struct RiffetToggleChip: View {
    let title: String
    @Binding var isOn: Bool
    var symbol: String? = nil
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            withAnimation(RiffetMotion.unlessReduced(RiffetMotion.effects, reduceMotion)) { isOn.toggle() }
        } label: {
            HStack(spacing: 6) {
                if let symbol { Image(systemName: symbol).accessibilityHidden(true) }
                Text(title).lineLimit(1)
            }
            .riffetFont(.label)
            .foregroundStyle(isOn ? palette.fg : palette.fg2)
            .padding(.horizontal, RiffetMetrics.chipInset)
            .frame(minHeight: RiffetMetrics.chipHeight)
            .background(Capsule().fill(isOn ? palette.selected : palette.press))
            .frame(minHeight: RiffetMetrics.hitTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(RiffetDimPressStyle())
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

// MARK: - Unsaved changes

/// The edit sheet's guard (ios.md §3.2): while `dirty`, the sheet will not swipe away, and both the
/// swipe and Cancel ask "放弃未保存的修改？" with Discard and Keep Editing. Cancel sets `confirming`
/// when dirty; the page saves from its bar, never from here.
struct RiffetUnsavedGuard: ViewModifier {
    let dirty: Bool
    let locked: Bool
    @Binding var confirming: Bool
    let discard: () -> Void

    func body(content: Content) -> some View {
        content
            .interactiveDismissDisabled(dirty || locked)
            .background(DismissAttemptObserver(enabled: dirty && !locked) { confirming = true }.frame(width: 0, height: 0))
            .confirmationDialog(String(localized: "放弃未保存的修改？", bundle: .riffet), isPresented: $confirming, titleVisibility: .visible) {
                Button(String(localized: "放弃", bundle: .riffet), role: .destructive) { discard() }
                Button(String(localized: "继续编辑", bundle: .riffet), role: .cancel) {}
            }
    }
}

extension View {
    /// Guards an edit sheet with unsaved changes; `discard` usually dismisses it. `locked` (a save in
    /// flight) keeps the sheet in place without asking. The one place a sheet's swipe-to-close is decided.
    func riffetUnsavedGuard(dirty: Bool, locked: Bool = false, confirming: Binding<Bool>, discard: @escaping () -> Void) -> ModifiedContent<Self, RiffetUnsavedGuard> {
        modifier(RiffetUnsavedGuard(dirty: dirty, locked: locked, confirming: confirming, discard: discard))
    }
}

/// Tells when a swipe tried to close the sheet this view sits in. SwiftUI has no hook for it: this
/// stands in front of the sheet's own presentation delegate, answers the attempt, and passes every
/// other call through to the delegate SwiftUI installed.
private struct DismissAttemptObserver: UIViewControllerRepresentable {
    let enabled: Bool
    let onAttempt: () -> Void

    func makeCoordinator() -> Proxy { Proxy() }
    func makeUIViewController(context: Context) -> UIViewController { Probe(proxy: context.coordinator) }
    func updateUIViewController(_ controller: UIViewController, context: Context) {
        context.coordinator.onAttempt = enabled ? onAttempt : nil
        (controller as? Probe)?.install()
    }
    static func dismantleUIViewController(_ controller: UIViewController, coordinator: Proxy) { coordinator.uninstall() }

    final class Probe: UIViewController {
        let proxy: Proxy
        init(proxy: Proxy) { self.proxy = proxy; super.init(nibName: nil, bundle: nil) }
        required init?(coder: NSCoder) { nil }
        override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); install() }
        /// Only once in the sheet's hierarchy: reading `presentationController` before that makes UIKit
        /// create one for this probe alone, and the sheet's own would never be found.
        func install() {
            guard parent != nil, viewIfLoaded?.window != nil, let presentation = presentationController else { return }
            proxy.install(on: presentation)
        }
    }

    final class Proxy: NSObject, UIAdaptivePresentationControllerDelegate {
        var onAttempt: (() -> Void)?
        private weak var original: UIAdaptivePresentationControllerDelegate?
        private weak var presentation: UIPresentationController?

        func install(on presentation: UIPresentationController) {
            guard presentation.delegate !== self else { return }
            original = presentation.delegate
            self.presentation = presentation
            presentation.delegate = self
        }
        func uninstall() {
            if let presentation, presentation.delegate === self { presentation.delegate = original }
        }

        func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) {
            onAttempt?()
            original?.presentationControllerDidAttemptToDismiss?(presentationController)
        }
        override func responds(to selector: Selector!) -> Bool {
            super.responds(to: selector) || (original?.responds(to: selector) ?? false)
        }
        override func forwardingTarget(for selector: Selector!) -> Any? {
            original?.responds(to: selector) == true ? original : super.forwardingTarget(for: selector)
        }
    }
}

// MARK: - Search

/// A page's search field in the navigation bar's drawer, folded away until the reader pulls the list down
/// (mobile.md §7.3). `.navigationBarDrawer(displayMode: .automatic)` alone starts folded or open depending
/// on where the list lands after its first layout; this folds it once, before the page is first drawn.
/// Picker sheets keep theirs open (`displayMode: .always`) and do not use this.
struct RiffetSearchable: ViewModifier {
    @Binding var text: String
    let prompt: String
    func body(content: Content) -> some View {
        content
            .searchable(text: $text, placement: .navigationBarDrawer(displayMode: .automatic), prompt: prompt)
            .background(SearchFold())
    }
}

extension View {
    func riffetSearchable(text: Binding<String>, prompt: String) -> ModifiedContent<Self, RiffetSearchable> {
        modifier(RiffetSearchable(text: text, prompt: prompt))
    }
}

private struct SearchFold: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Probe { Probe() }
    func updateUIViewController(_ controller: Probe, context: Context) {}

    final class Probe: UIViewController {
        private var settled = false
        private var sizeObservation: NSKeyValueObservation?
        private var offsetObservation: NSKeyValueObservation?
        override func loadView() { view = UIView(); view.isUserInteractionEnabled = false }

        /// Laid out, not yet on screen. A list whose rows have not arrived is tried again as they do,
        /// until the reader touches it.
        override func viewIsAppearing(_ animated: Bool) {
            super.viewIsAppearing(animated)
            guard !settled, let scroll = pageScrollView() else { return }
            if !fold(scroll) {
                sizeObservation = scroll.observe(\.contentSize, options: [.new]) { [weak self] scroll, _ in
                    MainActor.assumeIsolated { if let self, self.fold(scroll) { self.sizeObservation = nil } }
                }
            }
        }

        /// Scrolls the open search bar away when the list sits at its top; true once nothing is left to do.
        private func fold(_ scroll: UIScrollView) -> Bool {
            guard !settled else { return true }
            if scroll.isTracking || scroll.isDragging { settled = true; return true }
            guard let bar = page?.navigationItem.searchController?.searchBar else { return false }
            let top = -scroll.adjustedContentInset.top
            guard bar.bounds.height > 0 else {
                // Folded already. UIKit can fold it with the list pushed a bar's height under the title.
                settled = true
                snapToTop(scroll)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self, weak scroll] in if let scroll { self?.snapToTop(scroll) } }
                return true
            }
            guard abs(scroll.contentOffset.y - top) < 1,
                  scroll.contentSize.height + scroll.adjustedContentInset.top + scroll.adjustedContentInset.bottom > scroll.bounds.height + bar.bounds.height
            else { return false }
            settled = true
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: top + bar.bounds.height), animated: false)
            // Folding the bar takes its height out of the inset and moves the list by it once more, while the
            // bar is still animating shut; for a moment after, a list left under its top goes back on it.
            // The snap waits for the layout pass that moved the list to finish: setting the offset from inside
            // it fights UIKit's own scroll-position restore, and the list loops until UIKit breaks it (~1.5 s).
            offsetObservation = scroll.observe(\.contentOffset, options: [.new]) { [weak self] scroll, _ in
                MainActor.assumeIsolated { self?.snapAfterLayout(scroll) }
            }
            for delay in [0.3, 0.8] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self, weak scroll] in
                    guard let self, let scroll else { return }
                    self.snapToTop(scroll)
                    if delay == 0.8 { self.offsetObservation = nil }
                }
            }
            return true
        }

        private var snapPending = false
        private func snapAfterLayout(_ scroll: UIScrollView) {
            guard !snapPending else { return }
            snapPending = true
            DispatchQueue.main.async { [weak self, weak scroll] in
                guard let self else { return }
                snapPending = false
                if let scroll { snapToTop(scroll) }
            }
        }

        /// Puts a list that sits just under its top (by up to a bar's height) back on it.
        private func snapToTop(_ scroll: UIScrollView) {
            guard !scroll.isTracking, !scroll.isDragging, !scroll.isDecelerating else { offsetObservation = nil; return }
            let top = -scroll.adjustedContentInset.top
            guard scroll.contentOffset.y > top + 0.5, scroll.contentOffset.y < top + 80 else { return }
            scroll.contentOffset.y = top
        }

        /// The page's controller: the nearest ancestor that carries the search bar.
        private var page: UIViewController? {
            var ancestor = parent
            while let current = ancestor, current.navigationItem.searchController == nil { ancestor = current.parent }
            return ancestor
        }

        /// The page's own list: the tallest scroll view in the page.
        private func pageScrollView() -> UIScrollView? {
            guard let root = page?.view else { return nil }
            var queue: [UIView] = [root], found: UIScrollView?
            while !queue.isEmpty {
                let view = queue.removeFirst()
                if let scroll = view as? UIScrollView, scroll.bounds.height > (found?.bounds.height ?? 0) { found = scroll }
                queue += view.subviews
            }
            return found
        }
    }
}

// MARK: - Deferred menu

/// An icon button whose menu is built when it opens. SwiftUI's `Menu` builds the whole menu, resolving
/// every item's symbol in the asset catalog, each time the row holding it is built; one under every reply
/// did that for each row scrolled in (ios-performance.md §2.18).
final class RiffetDeferredMenuButton: UIButton {
    /// The menu's items, asked for each time it opens.
    var items: () -> [UIMenuElement] = { [] }

    init() {
        super.init(frame: .zero)
        var configuration = UIButton.Configuration.plain()
        configuration.contentInsets = .zero
        self.configuration = configuration
        contentHorizontalAlignment = .leading
        showsMenuAsPrimaryAction = true
        menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in completion(self?.items() ?? []) }])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    /// Shows `symbol` in the role's font and `color`; the same image is not set twice.
    func show(symbol: String, font: UIFont, color: UIColor) {
        guard symbol != shownSymbol || font != shownFont || color != shownColor else { return }
        shownSymbol = symbol; shownFont = font; shownColor = color
        configuration?.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(font: font))
        configuration?.baseForegroundColor = color
    }
    private var shownSymbol: String?
    private var shownFont: UIFont?
    private var shownColor: UIColor?
}

/// `RiffetDeferredMenuButton` in SwiftUI.
struct RiffetDeferredMenu: UIViewRepresentable {
    let symbol: String
    var role: RiffetText = .label
    var weight: Font.Weight? = nil
    let color: Color
    let accessibilityLabel: String
    let items: () -> [UIMenuElement]
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func makeUIView(context: Context) -> RiffetDeferredMenuButton {
        let button = RiffetDeferredMenuButton()
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return button
    }
    func updateUIView(_ button: RiffetDeferredMenuButton, context: Context) {
        button.items = items
        button.show(symbol: symbol, font: role.uiFont(weight: weight, compatibleWith: button.traitCollection), color: UIColor(color))
        button.accessibilityLabel = accessibilityLabel
    }
}
