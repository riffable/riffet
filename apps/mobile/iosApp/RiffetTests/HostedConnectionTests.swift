import XCTest
import Security
import RiffetKit
@testable import Riffet

/// This test runs inside Riffet.app, providing the Keychain identity missing from standalone kexe tests.
@MainActor
final class HostedConnectionTests: XCTestCase {
    private var endpoint: URL { URL(string: ProcessInfo.processInfo.environment["RIFFET_E2E_BASE_URL"] ?? "http://127.0.0.1:19471")! }
    private func resetFixture() async throws {
        var request = URLRequest(url: endpoint.appendingPathComponent("__test/reset"))
        request.httpMethod = "POST"; request.httpBody = Data("{}".utf8)
        request.timeoutInterval = 3
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
    private var credentialQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "io.github.riffetai.iphone.credentials",
         kSecAttrAccount as String: "paired-server"]
    }
    private func credentialData() throws -> Data {
        var query = credentialQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        return try XCTUnwrap(result as? Data)
    }
    private func replaceCredentialData(_ data: Data) throws {
        let status = SecItemUpdate(credentialQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
    private func assertIncompleteSnapshotIsPreserved(_ host: IOSHost) async throws {
        let original = try credentialData()
        var incomplete = try XCTUnwrap(JSONSerialization.jsonObject(with: original) as? [String: Any])
        incomplete.removeValue(forKey: "version")
        let damaged = try JSONSerialization.data(withJSONObject: incomplete)
        defer {
            do { try replaceCredentialData(original) }
            catch { XCTFail("Could not restore the fixture Keychain item") }
        }
        try replaceCredentialData(damaged)
        do {
            _ = try await host.pairedServers()
            XCTFail("A snapshot missing its version must fail to load")
        } catch { XCTAssertTrue(error.riffetMessage == "无法读取配对记录", "Unreadable snapshots must report a safe error") }
        XCTAssertTrue(try credentialData() == damaged, "A failed history read must preserve the Keychain bytes")
        do {
            _ = try await host.restore()
            XCTFail("A snapshot missing its version must fail to restore")
        } catch { XCTAssertTrue(error.riffetMessage == "无法读取配对记录", "Unreadable snapshots must report a safe error") }
        XCTAssertTrue(try credentialData() == damaged, "A failed restore must preserve the Keychain bytes")
    }
    func testPairingPersistsInTheAppKeychainAndFailedPairingDoesNotReplaceIt() async throws {
        do { try await resetFixture() } catch {
            if ProcessInfo.processInfo.environment["RIFFET_REQUIRE_E2E"] == "1" { throw error }
            throw XCTSkip("Start scripts/e2e-server.mjs for the App-hosted Keychain test: \(error.localizedDescription)")
        }
        let address = endpoint.absoluteString
        let first = IOSHost()
        for server in try await first.pairedServers() { _ = try await first.forgetServer(origin: server.origin) }
        do {
            let issued = try await first.pair(baseUrl: address, code: "123456", deviceName: "App-hosted storage test", name: "Fixture Mac")
            XCTAssertEqual(issued.device.id, "device-e2e")
            XCTAssertTrue(try first.hasToken(baseUrl: address))
            first.close()
            let restored = IOSHost()
            defer { restored.close() }
            XCTAssertTrue(try restored.hasToken(baseUrl: address), "a new host must read the persisted Keychain item")
            let saved = try await restored.pairedServers()
            XCTAssertEqual(saved.count, 1)
            XCTAssertEqual(saved.first?.name, "Fixture Mac")
            let store = try await restored.restore()
            XCTAssertNotNil(store)
            XCTAssertEqual(restored.api?.baseUrl, address)
            let allowed = try await restored.authorizationFor(url: address + "/api/sessions")
            XCTAssertEqual(allowed, "Bearer riffet-native-e2e-device-token")
            let foreign = try await restored.authorizationFor(url: "http://other.invalid:19471/api/sessions")
            XCTAssertNil(foreign)
            do {
                _ = try await restored.pair(baseUrl: address, code: "invalid", deviceName: "Rejected pairing")
                XCTFail("the server must reject an invalid one-time pairing code")
            } catch { /* failure is expected and must preserve the previous credential */ }
            XCTAssertTrue(try restored.hasToken(baseUrl: address))
            let afterFailedPairing = try await restored.authorizationFor(url: address + "/api/bootstrap")
            XCTAssertEqual(afterFailedPairing, allowed)
            let afterFailure = try await restored.pairedServers()
            XCTAssertEqual(afterFailure.count, 1)
            XCTAssertEqual(afterFailure.first?.name, "Fixture Mac")
            try await assertIncompleteSnapshotIsPreserved(restored)

            // One loopback fixture can represent two credential origins without a second service.
            var secondAddress: String?
            if let host = endpoint.host?.lowercased(), ["localhost", "127.0.0.1"].contains(host) {
                var alternate = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
                alternate.host = host == "localhost" ? "127.0.0.1" : "localhost"
                let alternateAddress = alternate.url!.absoluteString
                secondAddress = alternateAddress
                _ = try await restored.pair(baseUrl: alternateAddress, code: "123456", deviceName: "Second origin", name: "Fixture Remote")
                _ = try restored.install(baseUrl: alternateAddress)
                let both = try await restored.pairedServers()
                XCTAssertEqual(both.count, 2)
                let original = try XCTUnwrap(both.first { $0.baseUrl == address })
                let second = try XCTUnwrap(both.first { $0.baseUrl == alternateAddress })
                _ = try await restored.switchServer(origin: original.origin)
                XCTAssertEqual(restored.api?.baseUrl, address)
                _ = try await restored.switchServer(origin: second.origin)
                XCTAssertEqual(restored.api?.baseUrl, alternateAddress)
                let forgotOther = try await restored.forgetServer(origin: original.origin)
                XCTAssertFalse(forgotOther.boolValue)
                XCTAssertEqual(restored.api?.baseUrl, alternateAddress)
                XCTAssertFalse(try restored.hasToken(baseUrl: address))
                XCTAssertTrue(try restored.hasToken(baseUrl: alternateAddress))
                let remaining = try await restored.pairedServers()
                XCTAssertEqual(remaining.map(\.origin), [second.origin])
            }
            try await restored.forget()
            XCTAssertFalse(try restored.hasToken(baseUrl: address))
            if let secondAddress { XCTAssertFalse(try restored.hasToken(baseUrl: secondAddress)) }
            let afterForget = try await restored.restore()
            XCTAssertNil(afterForget)
            let afterForgetHistory = try await restored.pairedServers()
            XCTAssertTrue(afterForgetHistory.isEmpty)
        } catch {
            if let saved = try? await first.pairedServers() {
                for server in saved { _ = try? await first.forgetServer(origin: server.origin) }
            }
            first.close()
            throw error
        }
    }
}
