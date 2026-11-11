import XCTest
import WebKit
@testable import Riffet

/// Runs the production preview wrapper in WebKit, rather than inferring sandbox behavior
/// from HTML strings. The message handler exists only in this test configuration.
@MainActor
final class PreviewIsolationTests: XCTestCase {
    private var fixture: URL {
        URL(string: ProcessInfo.processInfo.environment["RIFFET_E2E_BASE_URL"] ?? "http://127.0.0.1:19471")!
    }

    func testWrapperKeepsTheServerResourceAllowlistAndRestrictiveDirectives() {
        // Mirrors apps/server/src/visualization.ts. No CDN is contacted by these tests.
        let resources = Set(ConversationPreviewDocument.visualizationResources.split(separator: " ").map(String.init))
        XCTAssertEqual(resources, Set([
            "data:", "blob:", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://esm.sh",
            "https://fonts.bunny.net", "https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://unpkg.com"
        ]))
        let html = ConversationPreviewDocument.html(source: "<p>Preview</p>", url: fixture.appendingPathComponent("preview"))
        for directive in ["default-src 'none'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'"] {
            XCTAssertTrue(html.contains(directive), directive)
        }
        XCTAssertTrue(html.contains("sandbox=\"allow-scripts\""))
        XCTAssertFalse(html.contains("allow-same-origin"))
        XCTAssertFalse(html.contains("allow-top-navigation"))
        XCTAssertFalse(html.contains("allow-forms"))
        XCTAssertFalse(html.contains("webkit.messageHandlers"), "production previews must not acquire the test observer bridge")
    }

    func testOpaquePreviewKeepsParentAndStorageIsolated() async throws {
        let probe = PreviewProbe(expected: ["inlineReady", "parentDenied", "storageDenied"])
        defer { probe.close() }
        let source = """
        <script>
        const report = name => window.dispatchEvent(new CustomEvent('riffetPreviewStatus', {detail: {name}}));
        report('inlineReady');
        try { parent.document.body.dataset.escaped = 'yes'; report('parentEscaped'); }
        catch (_) { report('parentDenied'); }
        try { localStorage.setItem('preview-escape', 'yes'); report('storageEscaped'); }
        catch (_) { report('storageDenied'); }
        </script>
        """
        probe.load(source: source, url: fixture.appendingPathComponent("preview"))
        await fulfillment(of: probe.expectations, timeout: 8)
        XCTAssertFalse(probe.statuses.contains("parentEscaped"))
        XCTAssertFalse(probe.statuses.contains("storageEscaped"))
        XCTAssertTrue(probe.navigationErrors.isEmpty, probe.navigationErrors.joined(separator: "\n"))
        // In particular, frame-src 'self' must permit the host's opaque srcdoc frame.
        // inlineReady is the positive script control: a policy blocking all scripts must
        // not make the parent/storage isolation assertions pass without exercising them.
        XCTAssertEqual(probe.webView.url?.scheme, "about")
    }

    func testPreviewBlocksNetworkSubresourcesFormsAndTopNavigation() async throws {
        // Observe requests without resetting the shared fixture or changing its behavior.
        do { _ = try await recordedRequests() } catch {
            if ProcessInfo.processInfo.environment["RIFFET_REQUIRE_E2E"] == "1" { throw error }
            throw XCTSkip("Start iosApp/scripts/e2e-server.mjs for preview network isolation: \(error.localizedDescription)")
        }
        let path = "/preview-isolation/" + UUID().uuidString.lowercased()
        let base = fixture.appendingPathComponent(String(path.dropFirst())).absoluteString
        let encoded = String(data: try JSONEncoder().encode(base), encoding: .utf8)!
        let probe = PreviewProbe(expected: [
            "inlineReady", "fetchBlocked", "xhrBlocked", "socketBlocked", "topAttempted", "settled",
            "csp:connect-src", "csp:script-src", "csp:img-src", "csp:frame-src"
        ])
        defer { probe.close() }
        let source = """
        <script>
        const report = name => window.dispatchEvent(new CustomEvent('riffetPreviewStatus', {detail: {name}}));
        const probeURL = \(encoded);
        report('inlineReady');
        fetch(probeURL + '/fetch').then(() => report('fetchEscaped')).catch(() => report('fetchBlocked'));
        const xhr = new XMLHttpRequest();
        xhr.onerror = () => report('xhrBlocked');
        xhr.onload = () => report('xhrEscaped');
        try { xhr.open('GET', probeURL + '/xhr'); xhr.send(); }
        catch (_) { report('xhrBlocked'); }
        try {
          const socket = new WebSocket(probeURL.replace(/^http/, 'ws') + '/socket');
          socket.onerror = () => report('socketBlocked');
          socket.onopen = () => { report('socketEscaped'); socket.close(); };
        } catch (_) { report('socketBlocked'); }
        const script = document.createElement('script'); script.src = probeURL + '/script'; document.body.append(script);
        const image = new Image(); image.src = probeURL + '/image'; document.body.append(image);
        const frame = document.createElement('iframe'); frame.src = probeURL + '/frame'; document.body.append(frame);
        const form = document.createElement('form'); form.action = probeURL + '/form'; form.method = 'GET'; document.body.append(form);
        try { form.submit(); } catch (_) {}
        report('topAttempted');
        try { top.location.href = probeURL + '/top-navigation'; } catch (_) { report('topDenied'); }
        // Leave enough time for CSP errors, denied navigations and a mistaken local request
        // to reach the fixture before the zero-request assertion.
        setTimeout(() => report('settled'), 1200);
        </script>
        """
        probe.load(source: source, url: fixture.appendingPathComponent("preview"))
        await fulfillment(of: probe.expectations, timeout: 8)
        for escaped in ["fetchEscaped", "xhrEscaped", "socketEscaped"] {
            XCTAssertFalse(probe.statuses.contains(escaped), escaped)
        }
        XCTAssertEqual(probe.webView.url?.scheme, "about", "the trusted host must remain in place after top-navigation attempts")
        let requests = try await recordedRequests()
        XCTAssertFalse(requests.contains { ($0["path"] as? String)?.hasPrefix(path) == true }, "a denied resource/form/navigation reached the local server: \(requests.filter { ($0["path"] as? String)?.hasPrefix(path) == true })")
        XCTAssertTrue(probe.navigationErrors.isEmpty, probe.navigationErrors.joined(separator: "\n"))
    }

    private func recordedRequests() async throws -> [[String: Any]] {
        var request = URLRequest(url: fixture.appendingPathComponent("__test/state"))
        request.timeoutInterval = 3
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let state = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let requests = state["requests"] as? [[String: Any]] else {
            throw NSError(domain: "PreviewIsolationTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Fixture state is unavailable"])
        }
        return requests
    }
}

@MainActor
private final class PreviewProbe: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private let expected: [String: XCTestExpectation]
    private(set) var statuses: Set<String> = []
    private(set) var navigationErrors: [String] = []
    let webView: WKWebView
    var expectations: [XCTestExpectation] { Array(expected.values) }

    init(expected names: [String]) {
        expected = Dictionary(uniqueKeysWithValues: names.map { ($0, XCTestExpectation(description: "Preview: " + $0)) })
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        super.init()
        webView.configuration.userContentController.add(self, name: "previewProbe")
        webView.configuration.userContentController.addUserScript(WKUserScript(source: """
        window.addEventListener('riffetPreviewStatus', event => {
          window.webkit.messageHandlers.previewProbe.postMessage({kind:'status', name:event.detail.name});
        });
        document.addEventListener('securitypolicyviolation', event => {
          window.webkit.messageHandlers.previewProbe.postMessage({kind:'csp', name:event.effectiveDirective, blocked:event.blockedURI});
        });
        """, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        webView.navigationDelegate = self
    }

    func load(source: String, url: URL) {
        webView.loadHTMLString(ConversationPreviewDocument.html(source: source, url: url), baseURL: nil)
    }

    func close() {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "previewProbe")
        webView.configuration.userContentController.removeAllUserScripts()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let value = message.body as? [String: Any], let name = value["name"] as? String else { return }
        let key: String
        if value["kind"] as? String == "csp" {
            // WebKit versions differ on whether element directives retain the -elem suffix.
            key = "csp:" + name.replacingOccurrences(of: "-elem", with: "")
        } else { key = name }
        if statuses.insert(key).inserted { expected[key]?.fulfill() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Match the production host's external-navigation guard, in addition to sandbox/CSP.
        decisionHandler(action.request.url?.scheme == "about" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { record(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { record(error) }
    private func record(_ error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { navigationErrors.append(error.localizedDescription) }
    }
}
