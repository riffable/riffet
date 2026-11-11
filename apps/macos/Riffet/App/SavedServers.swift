import Foundation

/// A server this Mac paired with by address. The Mac's own server is not listed: its address
/// follows the running service, and its token is minted locally.
struct SavedServer: Codable, Equatable, Identifiable {
    /// Scheme, host and port without a trailing slash. The device token in the Keychain is keyed by it.
    let base: String
    var name: String?

    var id: String { base.lowercased() }
    var url: URL? { URL(string: base) }
    var title: String { name ?? base }
    /// Only a named server needs its address spelled out beside the name.
    var detail: String? { name == nil ? nil : base }

    static func base(of url: URL) -> String {
        url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}

/// The paired servers, in the order they were added. Which one is current stays in
/// `ConnectionTarget` (the same key as before the list existed).
enum SavedServers {
    private static let key = "riffet.remote-servers"

    /// Reads the list. The single server a version without a list remembered joins it here, once:
    /// after that the list is the record.
    static func load(defaults: UserDefaults = .standard) -> [SavedServer] {
        var list = (defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([SavedServer].self, from: $0) } ?? [])
            .filter { $0.url?.host != nil }
        if case let .remote(url) = ConnectionTarget.load(defaults: defaults) {
            let legacy = SavedServer(base: SavedServer.base(of: url))
            if !list.contains(where: { $0.id == legacy.id }) {
                list.append(legacy)
                save(list, defaults: defaults)
            }
        }
        return list
    }

    static func save(_ list: [SavedServer], defaults: UserDefaults = .standard) {
        defaults.set(try? JSONEncoder().encode(list), forKey: key)
    }
}

/// What `riffet pair` and the pairing QR encode: `{"v":1,"scheme":"http","host":"…","port":4337,"code":"…","name":"…"}`.
/// The checks are those of the web client (`apps/web/src/lib/pairing-qr.ts`).
struct PairingPayload: Equatable {
    let address: String
    let code: String
    let name: String?

    private struct Raw: Decodable {
        let v: Int
        let scheme: String?
        let host: String
        let port: Int
        let code: String
        let name: String?
    }

    private static let alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

    init?(parsing text: String) {
        guard let data = text.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let raw = try? JSONDecoder().decode(Raw.self, from: data),
              raw.v == 1, (1...65535).contains(raw.port) else { return nil }
        let scheme = raw.scheme ?? "http"
        let code = raw.code.trimmingCharacters(in: .whitespaces).uppercased()
        guard scheme == "http" || scheme == "https",
              !raw.host.isEmpty,
              raw.host.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "_.:-[]".contains($0)) }),
              code.count == 8, code.allSatisfy({ Self.alphabet.contains($0) }) else { return nil }
        let host = raw.host.contains(":") && !raw.host.hasPrefix("[") ? "[\(raw.host)]" : raw.host
        let address = "\(scheme)://\(host):\(raw.port)"
        guard let url = URL(string: address), url.host != nil else { return nil }
        self.address = address
        self.code = code
        self.name = raw.name?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty.map { String($0.prefix(64)) }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
