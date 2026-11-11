import XCTest
@testable import Riffet

final class ConversationResourceIsolationTests: XCTestCase {
    func testMathNavigationCannotEscapeTheCredentialFreeEndpoint() {
        let origin = URL(string: "http://mac.local:4337/math#tex=x")!
        for allowed in ["http://mac.local:4337/math#tex=y", "http://MAC.local:4337/math"] {
            XCTAssertTrue(ConversationMathPolicy.allows(URL(string: allowed)!, expected: origin))
        }
        for denied in ["http://mac.local:4337/api/settings", "https://mac.local:4337/math", "http://mac.local:4338/math", "http://evil.example/math", "http://user:password@mac.local:4337/math", "javascript:alert(1)"] {
            XCTAssertFalse(ConversationMathPolicy.allows(URL(string: denied)!, expected: origin), denied)
        }
    }

    func testInlineMathRequestDoesNotLeakTexInQueryOrAllowCredentials() throws {
        let origin = URL(string: "http://mac.local:4337")!
        let request = ConversationInlineMathRequest(origin: origin, tex: #"x+y < z & \alpha = 2"#, fontSize: 17, dark: false)
        let url = try XCTUnwrap(request.url)
        XCTAssertEqual(url.path, "/math")
        XCTAssertNil(url.query)
        let fragment = try XCTUnwrap(url.fragment)
        XCTAssertTrue(fragment.contains("tex="))
        XCTAssertTrue(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedFragment?.contains("%2B") == true, "URLSearchParams must not turn a literal plus into a space")
        let reloaded = ConversationMathPolicy.reloadURL(url, generation: 2)
        XCTAssertFalse(try XCTUnwrap(reloaded.query).contains("alpha"))
        XCTAssertEqual(reloaded.fragment, url.fragment)
        XCTAssertTrue(ConversationMathPolicy.hasGeneration(reloaded, generation: 2))
        XCTAssertFalse(ConversationMathPolicy.hasGeneration(reloaded, generation: 3))
        XCTAssertFalse(ConversationMathPolicy.hasGeneration(url, generation: 2))
        XCTAssertNotEqual(request.cacheKey, ConversationInlineMathRequest(origin: URL(string: "http://other.local:4337")!, tex: request.tex, fontSize: 17, dark: false).cacheKey)
        XCTAssertNil(ConversationInlineMathRequest(origin: URL(string: "http://user:secret@mac.local")!, tex: "x", fontSize: 17, dark: false).url)
    }
}
