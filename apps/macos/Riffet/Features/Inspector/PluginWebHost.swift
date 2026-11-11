import AppKit
import SwiftUI
import WebKit

/// What a plugin's web view needs to know of its package. The registry builds it from the integration.
struct PluginWebPackage {
    let id: String
    /// Names the package in what it shows the user.
    let title: String
    let entryPath: String
    let integrity: String?
    /// The package's version; with no `integrity` it keys the entry's address.
    let version: String?
    let capabilities: Set<String>
    let commands: Set<String>

    var network: Bool { capabilities.contains("network") }
    var grant: PluginBridgeGrant { PluginBridgeGrant(packageId: id, capabilities: capabilities, commands: commands) }

    /// Changes when the page or what the package holds changes, so a running view is rebuilt: a
    /// revoked capability must not outlive the page that was opened with it.
    var fingerprint: String {
        [id, entryPath, integrity ?? "", version ?? "", capabilities.sorted().joined(separator: ","), commands.sorted().joined(separator: ",")].joined(separator: "|")
    }
}

/// Reads the package's entry through the authenticated client.
typealias PluginEntryFetch = @MainActor (URL) async throws -> Data

/// The content rules a plugin page loads under, compiled once per variant: every network load is
/// blocked unless the package holds `network`, which opens `https:` only. WebSockets are blocked
/// either way. (The page's policy limits it too; this holds if the policy were lifted.)
@MainActor
enum PluginContentRules {
    private static var compiled: [Bool: Task<WKContentRuleList, Error>] = [:]

    static func list(network: Bool) async throws -> WKContentRuleList {
        if let task = compiled[network] { return try await task.value }
        let schemes = (network ? ["^http://"] : ["^https?://", "^ftps?://"]) + ["^wss?://"]
        let rules = schemes.map { ["trigger": ["url-filter": $0], "action": ["type": "block"]] as [String: Any] }
        let json = String(decoding: try JSONSerialization.data(withJSONObject: rules), as: UTF8.self)
        let task = Task { @MainActor () -> WKContentRuleList in
            guard let store = WKContentRuleListStore.default() else { throw PluginPageFailure("The content rules could not be compiled") }
            let identifier = network ? "io.github.riffetai.plugin.network-https" : "io.github.riffetai.plugin.network-closed"
            guard let list = try await store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: json) else {
                throw PluginPageFailure("The content rules could not be compiled")
            }
            return list
        }
        compiled[network] = task
        do { return try await task.value } catch {
            compiled[network] = nil
            throw error
        }
    }
}

/// One plugin web view with its bridge. It owns the `WKWebView`, serves its page, answers the bridge
/// for exactly this view, and ends all of it on `close()`.
///
/// The bridge reaches the page through a shim installed in a content world of its own: the page's
/// scripts cannot see the script message handler or the shim's functions, and the shim emulates the
/// `MessageChannel` handshake the web host performs with an iframe (`window.parent` is the window
/// itself here, so the client's `event.source === window.parent` check holds). Requests reach native
/// as JSON text, replies and pushes go back through `evaluateJavaScript`.
@MainActor
final class PluginWebSession: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    static let handlerName = "riffetBridge"
    private static let world = WKContentWorld.world(name: "io.github.riffetai.plugin-bridge")

    let webView: WKWebView
    /// Called once when the page cannot be loaded or its process ends.
    var onFailure: ((String) -> Void)?

    private let package: PluginWebPackage
    private let services: PluginBridgeServices
    private let scheme: PluginSchemeHandler
    private let pageURL: URL?
    private var dataTask: Task<Void, Never>?
    private var bridge: PluginBridge?
    /// The number of the channel the page opened; the only one that is answered.
    private var channel = 0
    private var allowedLoad = false
    private var finished = false
    private var closed = false

    init(package: PluginWebPackage, base: String, rules: WKContentRuleList, services: PluginBridgeServices, fetch: @escaping PluginEntryFetch) {
        self.package = package
        self.services = services
        pageURL = PluginPageDocument.url(pluginId: package.id)
        scheme = PluginSchemeHandler(pluginId: package.id) { [weak services] in
            guard let services, let url = PluginEntry.url(base: base, pluginId: package.id, path: package.entryPath, key: package.integrity ?? package.version) else {
                throw PluginPageFailure("The view's script has no address")
            }
            let data = try await fetch(url)
            if data.count > PluginEntry.maxBytes { throw PluginPageFailure("The view's script is too large") }
            try PluginEntry.verify(data, integrity: package.integrity)
            let html = PluginPageDocument.bootstrap(code: PluginEntry.code(data), network: package.network, theme: services.theme, locale: services.context.locale)
            return PluginSchemeHandler.Page(html: html, policy: PluginPageDocument.policy(network: package.network))
        }
        let configuration = WKWebViewConfiguration()
        // Nothing the page stores outlives this view or is shared with another one.
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(rules)
        configuration.userContentController.addUserScript(WKUserScript(source: Self.shim, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: Self.world))
        configuration.setURLSchemeHandler(scheme, forURLScheme: PluginPageDocument.scheme)
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsLinkPreview = false
        super.init()
        services.attach(webView)
        configuration.userContentController.add(self, contentWorld: Self.world, name: Self.handlerName)
        webView.navigationDelegate = self
    }

    func start() {
        guard let pageURL else { return fail("The package id cannot be used as a page address") }
        webView.load(URLRequest(url: pageURL))
    }

    /// The context and palette the view is shown with now; a change is pushed to the page.
    func update(context: PluginBridgeContext, theme: PluginBridgeTheme) {
        guard !closed else { return }
        if services.context != context {
            services.context = context
            bridge?.push("context", context.json)
        }
        if services.theme != theme {
            services.theme = theme
            bridge?.push("theme", theme.json)
        }
    }

    /// Ends the bridge and the web view: pending calls are cancelled and nothing is answered after.
    func close() {
        guard !closed else { return }
        closed = true
        dataTask?.cancel(); dataTask = nil
        bridge?.close()
        bridge = nil
        scheme.cancelAll()
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.handlerName, contentWorld: Self.world)
        controller.removeAllUserScripts()
        controller.removeAllContentRuleLists()
        webView.navigationDelegate = nil
        webView.stopLoading()
    }

    // MARK: Bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !closed, message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
              PluginPageDocument.isPage(url, pluginId: package.id), let text = message.body as? String else { return }
        if let opened = Self.channelNumber(text) {
            openChannel(opened)
        } else {
            bridge?.receive(text)
        }
    }

    /// The page asked for a channel. Only the first request opens one: a later handshake would hand a
    /// script a bridge with a full token bucket and no pending calls.
    private func openChannel(_ number: Int) {
        guard bridge == nil else { return }
        channel = number
        bridge = PluginBridge(grant: package.grant, services: services) { [weak self] text in self?.deliver(text, channel: number) }
        if package.capabilities.contains("sessions.read") {
            dataTask = Task { [weak self] in
                var previous = ""
                while !Task.isCancelled {
                    guard let self, !self.closed else { return }
                    if self.services.context.visible, let projectId = self.services.context.projectId {
                        let revision = self.services.sessions().map { $0.id + ":" + $0.updatedAt }.joined(separator: "|")
                        if revision != previous { previous = revision; self.bridge?.push("data", ["kind": "sessions", "projectId": projectId]) }
                    }
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                }
            }
        }
    }

    private func deliver(_ text: String, channel number: Int) {
        guard !closed, channel == number else { return }
        webView.evaluateJavaScript("window.__riffetDeliver(\(number),\(PluginPageDocument.literal(text)))", in: nil, in: Self.world) { _ in }
    }

    /// The shim's control message `{"ready":<n>}`.
    private static func channelNumber(_ text: String) -> Int? {
        guard text.utf8.count < 32, text.hasPrefix("{\"ready\":"), text.hasSuffix("}") else { return nil }
        return Int(text.dropFirst(9).dropLast())
    }

    // MARK: Navigation

    /// Only the first load of the page is allowed. Links, redirects, reloads by script, new windows and
    /// form posts are all other navigations.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if !allowedLoad, navigationAction.targetFrame?.isMainFrame == true, let url = navigationAction.request.url,
           PluginPageDocument.isPage(url, pluginId: package.id) {
            allowedLoad = true
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finished = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadFailed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadFailed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fail("The view's process ended")
    }

    /// A refused navigation reports as cancelled or interrupted, and a failure after the page has
    /// loaded belongs to such an attempt: only the load of the page itself fails the view.
    private func loadFailed(_ error: Error) {
        let nsError = error as NSError
        if finished || (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled) || (nsError.domain == "WebKitErrorDomain" && nsError.code == 102) { return }
        fail(error.localizedDescription)
    }

    private func fail(_ message: String) {
        guard !closed, let report = onFailure else { return }
        onFailure = nil
        report(message)
    }

    // MARK: Shim

    /// Runs in the bridge's content world at document start, in the main frame. The first `ready` message
    /// the page posts to its own window (its bootstrap script does, before the view's code exists)
    /// opens a `MessageChannel`, keeps one end and hands the other to the page as the host's `init`;
    /// a later one is ignored. The page's requests go to native as JSON text, and what native
    /// answers or pushes is posted back on the channel it was meant for.
    private static let shim = """
    (function () {
      var post = function (text) { window.webkit.messageHandlers.riffetBridge.postMessage(text); };
      var port = null, generation = 0;
      window.__riffetDeliver = function (channel, text) {
        if (port !== null && channel === generation) port.postMessage(JSON.parse(text));
      };
      window.addEventListener('message', function (event) {
        var data = event.data;
        if (event.source !== window || data === null || typeof data !== 'object' || data.type !== 'riffet-plugin:ready' || data.version !== 1) return;
        if (port !== null) return;
        var channel = new MessageChannel();
        var mine = channel.port1;
        port = mine;
        generation += 1;
        mine.onmessage = function (message) {
          var text;
          try { text = JSON.stringify(message.data); } catch (error) { text = undefined; }
          if (typeof text === 'string') post(text);
          else if (message.data && typeof message.data.id === 'number') mine.postMessage({ id: message.data.id, error: { code: 'invalid_request', message: 'The request is not plain data' } });
        };
        post('{"ready":' + generation + '}');
        window.postMessage({ type: 'riffet-plugin:init', version: 1 }, '*', [channel.port2]);
      });
    })();
    """
}

/// Hosts a `PluginWebSession`; the session is the coordinator, so it lives and dies with the view.
struct PluginWebHost: NSViewRepresentable {
    let package: PluginWebPackage
    let base: String
    let rules: WKContentRuleList
    let bridgeContext: PluginBridgeContext
    let theme: PluginBridgeTheme
    let background: NSColor
    let makeServices: @MainActor (PluginBridgeContext, PluginBridgeTheme) -> PluginBridgeServices
    let fetch: PluginEntryFetch
    let onFailure: (String) -> Void

    func makeCoordinator() -> PluginWebSession {
        PluginWebSession(package: package, base: base, rules: rules, services: makeServices(bridgeContext, theme), fetch: fetch)
    }

    func makeNSView(context: Context) -> WKWebView {
        let session = context.coordinator
        session.onFailure = onFailure
        session.webView.underPageBackgroundColor = background
        session.start()
        return session.webView
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        let session = context.coordinator
        session.onFailure = onFailure
        view.underPageBackgroundColor = background
        session.update(context: bridgeContext, theme: theme)
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: PluginWebSession) {
        coordinator.close()
    }
}
