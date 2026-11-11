import Foundation

/// The socket's output chunks, fed to the terminal once per turn of the main loop: a burst of
/// small chunks is parsed and drawn as one, instead of one main-actor task each.
final class TerminalOutputInbox: @unchecked Sendable {
    private let lock = NSLock()
    private var data = ""
    private var fresh = false
    private var scheduled = false
    private var cols = 100
    private var rows = 40
    private let deliver: @MainActor (String, Bool, Int, Int) -> Void

    init(deliver: @escaping @MainActor (String, Bool, Int, Int) -> Void) {
        self.deliver = deliver
    }

    /// Called from whichever thread the connection reports on. A fresh snapshot replaces whatever
    /// was still waiting, which it would have cleared anyway.
    func append(_ chunk: String, fresh: Bool, cols: Int, rows: Int) {
        lock.lock()
        if fresh {
            data = chunk
            self.fresh = true
            self.cols = cols
            self.rows = rows
        } else {
            data += chunk
        }
        let schedule = !scheduled
        scheduled = true
        lock.unlock()
        guard schedule else { return }
        DispatchQueue.main.async { MainActor.assumeIsolated { self.drain() } }
    }

    @MainActor
    private func drain() {
        lock.lock()
        let data = self.data
        let fresh = self.fresh
        let cols = self.cols
        let rows = self.rows
        self.data = ""
        self.fresh = false
        scheduled = false
        lock.unlock()
        if fresh || !data.isEmpty { deliver(data, fresh, cols, rows) }
    }
}
