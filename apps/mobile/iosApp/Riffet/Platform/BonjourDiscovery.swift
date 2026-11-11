import Foundation
import Observation

struct DiscoveredRiffetServer: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let host: String
    let port: Int

    var baseURL: String {
        var components = URLComponents()
        components.scheme = "http"
        components.host = host
        components.port = port
        return components.url?.absoluteString ?? ""
    }
}

/// Bonjour is an optional shortcut. Manual address/code pairing remains available on failure.
/// Retain this object while the pairing screen is visible and stop it when leaving that screen.
@MainActor @Observable
final class BonjourDiscovery: NSObject, @preconcurrency NetServiceBrowserDelegate, @preconcurrency NetServiceDelegate {
    private(set) var servers: [DiscoveredRiffetServer] = []
    private(set) var failure: String?
    private(set) var isSearching = false
    @ObservationIgnored private var browser: NetServiceBrowser?
    @ObservationIgnored private var services: [String: NetService] = [:]

    func start() {
        stop()
        servers = []
        failure = nil
        isSearching = true
        let browser = NetServiceBrowser()
        browser.delegate = self
        self.browser = browser
        browser.searchForServices(ofType: "_riffet._tcp.", inDomain: "local.")
    }

    func stop() {
        browser?.delegate = nil
        browser?.stop()
        browser = nil
        for service in services.values { service.delegate = nil; service.stop() }
        services = [:]
        isSearching = false
    }

    private func key(_ service: NetService) -> String { "\(service.domain)|\(service.type)|\(service.name)" }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        guard browser === self.browser else { return }
        services[key(service)] = service
        service.delegate = self
        service.resolve(withTimeout: 5)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        guard browser === self.browser else { return }
        let id = key(service)
        services.removeValue(forKey: id)?.stop()
        servers.removeAll { $0.id == id }
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        guard browser === self.browser else { return }
        let code = errorDict[NetService.errorCode]?.intValue ?? 0
        // NSNetServicesMissingRequiredConfigurationError / policy denial may be surfaced here.
        failure = String(localized: "无法搜索局域网设备（\(code)）。请检查本地网络权限，或输入 Mac 地址配对。", bundle: .riffet)
        stop()
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        let id = key(sender)
        guard services[id] === sender, let hostName = sender.hostName, sender.port > 0 else { return }
        let host = hostName.hasSuffix(".") ? String(hostName.dropLast()) : hostName
        let server = DiscoveredRiffetServer(id: id, name: sender.name, host: host, port: sender.port)
        servers.removeAll { $0.id == id }
        servers.append(server)
        servers.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        // One vanished server must not fail discovery of the others.
        guard services[key(sender)] === sender else { return }
        services.removeValue(forKey: key(sender))?.stop()
    }
}
