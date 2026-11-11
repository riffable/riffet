import SwiftUI
import WebKit

/// Uses the system print panel so pagination never depends on an installed browser.
@MainActor
@Observable
final class SessionSharePrinter: NSObject {
    private(set) var printing = false
    @ObservationIgnored private weak var webView: WKWebView?
    @ObservationIgnored private var expectedURL: URL?
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var operation: NSPrintOperation?
    @ObservationIgnored private var timeout: Task<Void, Never>?

    func attach(_ view: WKWebView, url: URL?) {
        revision += 1
        webView = view
        expectedURL = url
    }

    func detach(_ view: WKWebView) {
        guard webView === view else { return }
        revision += 1
        timeout?.cancel()
        timeout = nil
        webView = nil
        expectedURL = nil
        printing = false
    }

    func printDocument(title: String, onFailure: @escaping () -> Void) {
        guard !printing else { return }
        guard let view = webView, let expectedURL, let actual = view.url,
              sameSharePage(expectedURL, actual), view.window != nil else { onFailure(); return }
        printing = true
        let request = revision
        timeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(45))
            guard !Task.isCancelled, let self, self.revision == request, self.operation == nil else { return }
            self.revision += 1
            self.printing = false
            onFailure()
        }
        // callAsyncJavaScript awaits the reader's Promise; evaluateJavaScript cannot do that.
        view.callAsyncJavaScript("await window.riffetPreparePrint(); return true;", in: nil, in: .page) { [weak self, weak view] result in
            guard let self, let view, self.revision == request, self.webView === view else { return }
            self.timeout?.cancel()
            self.timeout = nil
            guard case .success = result, let actual = view.url, sameSharePage(expectedURL, actual), let window = view.window else {
                self.printing = false
                onFailure()
                return
            }
            let info = NSPrintInfo(dictionary: [:])
            let pointsPerMillimeter = 72.0 / 25.4
            info.paperSize = NSSize(width: 210 * pointsPerMillimeter, height: 297 * pointsPerMillimeter)
            info.orientation = .portrait
            // nativePrint=1 uses CSS @page auto values; WebKit preserves AppKit's paper and margins.
            info.topMargin = 16 * pointsPerMillimeter
            info.bottomMargin = 16 * pointsPerMillimeter
            info.leftMargin = 16 * pointsPerMillimeter
            info.rightMargin = 16 * pointsPerMillimeter
            info.horizontalPagination = .fit
            info.verticalPagination = .automatic
            info.isHorizontallyCentered = false
            info.isVerticallyCentered = false
            let operation = view.printOperation(with: info)
            operation.jobTitle = title
            operation.showsPrintPanel = true
            operation.canSpawnSeparateThread = false
            self.operation = operation
            operation.runModal(for: window, delegate: self, didRun: #selector(self.printOperationDidRun(_:success:contextInfo:)), contextInfo: nil)
        }
    }

    @objc private func printOperationDidRun(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        guard self.operation === operation else { return }
        self.operation = nil
        printing = false
    }
}

/// The frozen share reader has one read-only bridge. Device credentials stay in the first request.
struct SessionSharePreview: NSViewRepresentable {
    let request: URLRequest
    let capturedAt: String
    var printer: SessionSharePrinter?
    let onReady: () -> Void
    let onFailure: (_ expired: Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(url: request.url, capturedAt: capturedAt, printer: printer, onReady: onReady, onFailure: onFailure) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(context.coordinator, name: "riffetShare")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        printer?.attach(view, url: request.url)
        context.coordinator.armTimeout()
        view.load(request)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.invalidate(view)
        view.stopLoading()
        view.navigationDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "riffetShare")
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private let url: URL?
        private let capturedAt: String
        private let printer: SessionSharePrinter?
        private let onReady: () -> Void
        private let onFailure: (Bool) -> Void
        private var timeout: Task<Void, Never>?
        private var active = true
        private var completed = false
        private var failed = false

        init(url: URL?, capturedAt: String, printer: SessionSharePrinter?, onReady: @escaping () -> Void, onFailure: @escaping (Bool) -> Void) {
            self.url = url
            self.capturedAt = capturedAt
            self.printer = printer
            self.onReady = onReady
            self.onFailure = onFailure
        }

        func armTimeout() {
            timeout = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(self?.printer == nil ? 30 : 45))
                guard !Task.isCancelled else { return }
                self?.fail()
            }
        }

        func invalidate(_ view: WKWebView) {
            active = false
            timeout?.cancel()
            timeout = nil
            printer?.detach(view)
        }

        private func fail(expired: Bool = false) {
            guard active, !failed else { return }
            failed = true
            completed = true
            timeout?.cancel()
            onFailure(expired)
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard active, message.frameInfo.isMainFrame,
                  let expected = url, let actual = message.frameInfo.request.url,
                  sameSharePage(expected, actual), let current = message.webView?.url, sameSharePage(expected, current),
                  let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            let origin = message.frameInfo.securityOrigin
            let port = expected.port ?? (expected.scheme == "https" ? 443 : 80)
            guard origin.protocol.lowercased() == expected.scheme?.lowercased(), origin.host.lowercased() == expected.host?.lowercased(),
                  (origin.port == 0 ? (origin.protocol == "https" ? 443 : 80) : origin.port) == port else { return }
            if type == "riffet-share-ready", !completed, body["capturedAt"] as? String == capturedAt {
                completed = true
                timeout?.cancel()
                onReady()
            } else if type == "riffet-share-error", body["capturedAt"] == nil || body["capturedAt"] as? String == capturedAt {
                fail()
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // Renderer iframes remain isolated; only the main document can send a ready signal.
            if action.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
            guard active, let expected = url, let target = action.request.url, sameSharePage(expected, target) else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
                fail(expired: http.statusCode == 404 || http.statusCode == 410)
                decisionHandler(.cancel)
            } else { decisionHandler(.allow) }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail() }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail() }

    }
}

private func sameSharePage(_ lhs: URL, _ rhs: URL) -> Bool {
    guard var a = URLComponents(url: lhs, resolvingAgainstBaseURL: false), var b = URLComponents(url: rhs, resolvingAgainstBaseURL: false) else { return false }
    a.fragment = nil
    b.fragment = nil
    return a == b
}
