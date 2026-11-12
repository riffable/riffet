import Foundation
import Security
import RiffetKit

/// Device tokens, per server. A build signed with a Team ID keeps them in the Keychain. An ad-hoc
/// build cannot: its code signature changes on every build, so the Keychain would ask for access
/// after each one. Those builds use a 0600 file instead, the same protection the server gives its
/// own `access-token` and `devices.json`.
final class AppSecrets: NSObject, SecretStore {
    static let shared = AppSecrets()

    private let service = "io.github.riffable.mac"
    private let usesKeychain = AppSecrets.hasTeamIdentifier()
    private let lock = NSLock()

    var storageDescription: String {
        usesKeychain
            ? String(localized: "钥匙串")
            : "~/Library/Application Support/Riffet/secrets.json（0600）" // i18n-ignore: storage path and permissions, shown verbatim
    }

    func read(account: String) -> String? {
        usesKeychain ? keychainRead(account) : fileRead(account)
    }

    func write(account: String, value: String?) {
        if usesKeychain { keychainWrite(account, value) } else { fileWrite(account, value) }
    }

    // MARK: Keychain

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    private func keychainRead(_ account: String) -> String? {
        var item: CFTypeRef?
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func keychainWrite(_ account: String, _ value: String?) {
        SecItemDelete(query(account) as CFDictionary)
        guard let value, let data = value.data(using: .utf8) else { return }
        var item = query(account)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(item as CFDictionary, nil)
    }

    // MARK: File

    private var fileURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/Riffet/secrets.json")
    }

    private func loadFile() -> [String: String] {
        guard let data = try? Data(contentsOf: fileURL) else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    private func fileRead(_ account: String) -> String? {
        lock.withLock { loadFile()[account] }
    }

    private func fileWrite(_ account: String, _ value: String?) {
        lock.withLock {
            var entries = loadFile()
            entries[account] = value
            let directory = fileURL.deletingLastPathComponent()
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            guard let data = try? JSONEncoder().encode(entries) else { return }
            FileManager.default.createFile(atPath: fileURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
            try? data.write(to: fileURL, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        }
    }

    private static func hasTeamIdentifier() -> Bool {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return false }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return false }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dictionary = info as? [String: Any] else { return false }
        return (dictionary[kSecCodeInfoTeamIdentifier as String] as? String)?.isEmpty == false
    }
}
