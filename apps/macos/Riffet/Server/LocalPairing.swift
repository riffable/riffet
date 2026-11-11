import Foundation
import RiffetKit

/// Pairs this Mac with the server running on it, without a QR code (docs/MACOS.md, "本机免配对").
///
/// The same path `riffet pair` takes to print its pairing code: a cookie session (token-free on
/// loopback, or the 0600 `access-token` from the state directory), a pairing code, and the code
/// redeemed for a long-lived device token. Only the device token is kept; the master token is read
/// once and never stored.
enum LocalPairing {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private struct AuthStatus: Decodable {
        let authenticated: Bool
        let tokenRequired: Bool
        let csrfToken: String?
    }

    private struct PairingCode: Decodable {
        let code: String
    }

    private struct ErrorEnvelope: Decodable {
        struct Body: Decodable { let message: String }
        let error: Body
    }

    @MainActor
    static func pair(baseURL: URL, stateDirectory: URL, deviceName: String, host: MacHost) async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let jar = CookieJar()

        var status: AuthStatus = try await request(session, baseURL, "api/auth/status", jar: jar)
        var csrf = status.csrfToken
        if status.tokenRequired && !status.authenticated {
            let tokenURL = stateDirectory.appending(path: "access-token")
            guard let token = try? String(contentsOf: tokenURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
                throw Failure(message: String(localized: "读不到 \(tokenURL.path)，无法免配对登录本机服务器"))
            }
            status = try await request(session, baseURL, "api/auth/login", body: ["token": token], jar: jar)
            csrf = status.csrfToken
        }
        guard let csrf else { throw Failure(message: String(localized: "本机服务器没有返回 CSRF 令牌")) }
        let pairing: PairingCode = try await request(session, baseURL, "api/pairing/code", body: ["name": deviceName], csrf: csrf, jar: jar)
        _ = try await host.pair(baseUrl: baseURL.absoluteString, code: pairing.code, deviceName: deviceName)
    }

    private static func request<T: Decodable>(
        _ session: URLSession,
        _ base: URL,
        _ path: String,
        body: [String: String]? = nil,
        csrf: String? = nil,
        jar: CookieJar
    ) async throws -> T {
        var request = URLRequest(url: base.appending(path: path))
        request.timeoutInterval = 8
        request.httpShouldHandleCookies = false
        if let cookie = jar.session { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        if let csrf { request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token") }
        let (data, response) = try await session.data(for: request)
        jar.take(response as? HTTPURLResponse)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode(ErrorEnvelope.self, from: data))?.error.message ?? "HTTP \(status)"
            throw Failure(message: message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// The `cw_session` cookie, carried by hand: one short exchange does not need a cookie store.
    private final class CookieJar {
        var session: String?

        func take(_ response: HTTPURLResponse?) {
            guard let header = response?.value(forHTTPHeaderField: "Set-Cookie") else { return }
            for part in header.components(separatedBy: CharacterSet(charactersIn: ";,")) {
                let trimmed = part.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("cw_session=") { session = trimmed }
            }
        }
    }
}
