import XCTest
import RiffetKit
@testable import Riffet

final class RiffetTests: XCTestCase {
    @MainActor
    func testSharedHomeDraftMigratesOnceAndPreservesUnsentEdits() throws {
        let scope = "test.\(UUID().uuidString)"
        let keys = [scope, scope + ".task", scope + ".chat"]
        let defaults = UserDefaults.standard
        defer {
            for key in keys {
                defaults.removeObject(forKey: "riffet.draft.\(key)")
                defaults.removeObject(forKey: "riffet.draft.attachments.\(key)")
            }
        }
        let attachment: [String: Any] = ["id": "image", "name": "image.png", "mimeType": "image/png", "size": 4, "path": "/uploads/image.png"]
        let data = try JSONSerialization.data(withJSONObject: [attachment])
        defaults.set("task draft", forKey: "riffet.draft.\(keys[1])")
        defaults.set("chat draft", forKey: "riffet.draft.\(keys[2])")
        for key in keys.dropFirst() { defaults.set(data, forKey: "riffet.draft.attachments.\(key)") }

        let composer = ComposerModel(draftKey: scope)
        composer.migrateDrafts(from: Array(keys.dropFirst()))
        composer.migrateDrafts(from: Array(keys.dropFirst()))
        XCTAssertEqual(composer.text, "task draft\n\nchat draft")
        XCTAssertEqual(composer.uploaded.map(\.id), ["image"])
        for key in keys.dropFirst() {
            XCTAssertNil(defaults.object(forKey: "riffet.draft.\(key)"))
            XCTAssertNil(defaults.object(forKey: "riffet.draft.attachments.\(key)"))
        }

        let restored = ComposerModel(draftKey: scope)
        XCTAssertEqual(restored.text, composer.text)
        XCTAssertEqual(restored.uploaded.map(\.id), ["image"])
        let sent = restored.submission()
        restored.text = "next message"
        restored.clear(sent: sent)
        restored.flushDraft()
        XCTAssertEqual(ComposerModel(draftKey: scope).text, "next message")
        XCTAssertTrue(ComposerModel(draftKey: scope).uploaded.isEmpty)
    }

    @MainActor
    func testDraftMigrationKeepsUnreadableLegacyAttachments() {
        let shared = "test.\(UUID().uuidString)"
        let legacy = shared + ".legacy"
        let defaults = UserDefaults.standard
        defer {
            for key in [shared, legacy] {
                defaults.removeObject(forKey: "riffet.draft.\(key)")
                defaults.removeObject(forKey: "riffet.draft.attachments.\(key)")
            }
        }
        defaults.set("keep this", forKey: "riffet.draft.\(legacy)")
        defaults.set(Data("unreadable".utf8), forKey: "riffet.draft.attachments.\(legacy)")
        let composer = ComposerModel(draftKey: shared)
        composer.migrateDrafts(from: [legacy])
        XCTAssertEqual(defaults.string(forKey: "riffet.draft.\(legacy)"), "keep this")
        XCTAssertNotNil(defaults.data(forKey: "riffet.draft.attachments.\(legacy)"))
        XCTAssertTrue(composer.text.isEmpty)
    }

    func testBareUrlsFollowGfmBoundaries() {
        func pieces(_ text: String, includeEmails: Bool = true) -> [(String, String?)] {
            BareURLs.split(text, includeEmails: includeEmails).map { ($0.text, $0.link?.absoluteString) }
        }
        XCTAssertEqual(pieces("见 http://131.0.0.1:4311，然后").map(\.0), ["见 ", "http://131.0.0.1:4311", "，然后"])
        XCTAssertEqual(pieces("www.x.dev").map(\.0), ["www.x.dev"])
        XCTAssertEqual(pieces("www.x.dev").first?.1, "http://www.x.dev")
        XCTAssertEqual(pieces("www.x").map(\.1), [nil])
        XCTAssertEqual(pieces("xhttp://a").map(\.1), [nil])
        XCTAssertEqual(pieces("a@b.co").first?.1, "mailto:a@b.co")
        XCTAssertEqual(pieces("a@b.co", includeEmails: false).map(\.1), [nil])
        XCTAssertEqual(pieces("a@b").map(\.1), [nil])
        XCTAssertEqual(pieces("http://x/a.").map(\.0), ["http://x/a", "."])
        XCTAssertEqual(pieces("http://x/a_(b)").map(\.0), ["http://x/a_(b)"])
        XCTAssertEqual(pieces("http://x/wiki/北京，好").map(\.0), ["http://x/wiki/北京", "，好"])
        XCTAssertEqual(pieces("访问https://example.com看看").map(\.0), ["访问", "https://example.com", "看看"])
        XCTAssertEqual(pieces("把http://改成https://").map(\.1), [nil])
        XCTAssertEqual(pieces("(https://a.com/x)和(https://b.com/y)").compactMap(\.1), ["https://a.com/x", "https://b.com/y"])
        XCTAssertEqual(pieces("[https://a.com/x](https://b.com/y)").compactMap(\.1), ["https://a.com/x", "https://b.com/y"])
        XCTAssertEqual(pieces("http://[::1]:8080/api?a[0]=1, HTTPS://Example.COM/P").filter { $0.1 != nil }.map(\.0), ["http://[::1]:8080/api?a[0]=1", "HTTPS://Example.COM/P"])
        XCTAssertEqual(pieces("http://[::1]:8080/api?a[0]=1, HTTPS://Example.COM/P").compactMap(\.1), ["http://[::1]:8080/api?a%5B0%5D=1", "https://Example.COM/P"])
        XCTAssertEqual(pieces("https://example.com.: 说明, http://example.com,a@example.com", includeEmails: false).compactMap(\.1), ["https://example.com", "http://example.com"])
        XCTAssertEqual(pieces("a.www.example.com http://localhost:99999 www.foo.1").compactMap(\.1), [])
    }

    func testFootnoteReferencesNumberByFirstUse() {
        let result = Footnotes.rewrite(document: "见[^b]，再[^a]，又[^b]，缺[^z]。\n\n[^a]: A\n[^b]: B\n[^unused]: C")
        XCTAssertEqual(result.document, "见[1]\u{200B}，再[2]\u{200B}，又[1]\u{200B}，缺[^z]。\n")
        XCTAssertEqual(result.notes, ["B", "A"])
    }

    func testFootnotesKeepContinuationsAndReadQuotes() {
        let result = Footnotes.rewrite(document: "正文[^1]\n\n> [^1]: 第一段\n\n    第二段")
        XCTAssertEqual(result.document, "正文[1]\u{200B}\n")
        XCTAssertEqual(result.notes, ["第一段\n\n第二段"])
    }

    func testFootnoteRewriteLeavesCodeAlone() {
        let result = Footnotes.rewrite(document: "`[^a]`\n\n```\n[^a]\n[^b]: B\n```\n\n[^a]: A")
        XCTAssertEqual(result.document, "`[^a]`\n\n```\n[^a]\n[^b]: B\n```\n")
        XCTAssertEqual(result.notes, [])
    }

    func testFootnoteNotesRenderAfterTheProse() {
        let segments = MarkdownModel.segments("见[^1]\n\n[^1]: 说明")
        guard case let .blocks(parts)? = segments.last else { return XCTFail("no trailing blocks") }
        let blocks = parts.flatMap { part -> [MarkdownBlock] in
            switch part {
            case let .prose(run): return run.blocks
            case let .block(block): return [block]
            }
        }
        XCTAssertTrue(blocks.contains { if case .rule = $0 { return true } else { return false } })
        guard case let .list(ordered, start, items)? = blocks.last else { return XCTFail("no note list") }
        XCTAssertTrue(ordered)
        XCTAssertEqual(start, 1)
        XCTAssertEqual(items.count, 1)
        guard case let .paragraph(text)? = items[0].blocks.first else { return XCTFail("no note text") }
        XCTAssertEqual(String(text.characters), "说明")
    }

    func testUnderscoreEmphasisBesideCjkBecomesAsterisks() {
        func relaxed(_ line: String) -> String {
            var backticks: Int?
            return UnderscoreEmphasis.relax(line, backticks: &backticks)
        }
        XCTAssertEqual(relaxed("__加粗__中文"), "**加粗**中文")
        XCTAssertEqual(relaxed("中文_斜体_"), "中文*斜体*")
        XCTAssertEqual(relaxed("调用__init__方法"), "调用__init__方法")
        XCTAssertEqual(relaxed("snake_case_name"), "snake_case_name")
        XCTAssertEqual(relaxed("`__x__中文`"), "`__x__中文`")
        XCTAssertEqual(UnderscoreEmphasis.rewrite(document: "```\n__x__中文\n```"), "```\n__x__中文\n```")
    }

    func testTokenAccountsAreKeyedByServer() {
        XCTAssertEqual(tokenAccount(baseUrl: "http://127.0.0.1:4337/"), tokenAccount(baseUrl: "HTTP://127.0.0.1:4337"))
        XCTAssertNotEqual(tokenAccount(baseUrl: "http://a:4337"), tokenAccount(baseUrl: "http://b:4337"))
    }

    func testPairedServerListAbsorbsTheSingleRememberedServerOnce() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("http://devbox.local:4317", forKey: "riffet.connection-target")
        XCTAssertEqual(SavedServers.load(defaults: defaults).map(\.base), ["http://devbox.local:4317"])
        // Forgetting it and returning to the local server must not bring it back.
        SavedServers.save([], defaults: defaults)
        ConnectionTarget.local.save(defaults: defaults)
        XCTAssertEqual(SavedServers.load(defaults: defaults), [])
        let payload = PairingPayload(parsing: #"{"v":1,"scheme":"https","host":"devbox","port":443,"code":"abcd2345","name":"devbox"}"#)
        XCTAssertEqual(payload?.address, "https://devbox:443")
        XCTAssertEqual(payload?.code, "ABCD2345")
        XCTAssertNil(PairingPayload(parsing: #"{"v":1,"host":"devbox","port":4317,"code":"ABCDEFGI"}"#))
    }

    @MainActor
    func testDeviceAuthorizationStaysWithinServerOriginAndBasePath() throws {
        let base = "https://riffet.example/service/"
        for raw in ["https://riffet.example/service", "HTTPS://RIFFET.EXAMPLE:443/service/api/attachments/1", "https://riffet.example/service/api?next=https://other.example"] {
            XCTAssertTrue(ProjectDownloads.allowsAuthorization(try XCTUnwrap(URL(string: raw)), baseURL: base), raw)
        }
        for raw in [
            "https://riffet.example.attacker/service/api", "https://attacker.example/service/api",
            "http://riffet.example/service/api", "https://riffet.example:444/service/api",
            "https://user@riffet.example/service/api", "https://riffet.example/service-other/api",
            "https://riffet.example/service/../outside", "https://riffet.example/service/%2e%2e/outside",
            "https://riffet.example/service%2f..%2foutside", "https://riffet.example/service%5c..%5coutside",
            "file://riffet.example/service/api", "data:text/plain,test"
        ] {
            XCTAssertFalse(ProjectDownloads.allowsAuthorization(try XCTUnwrap(URL(string: raw)), baseURL: base), raw)
        }
        XCTAssertTrue(ProjectDownloads.allowsAuthorization(URL(string: "http://localhost:80/api")!, baseURL: "http://LOCALHOST"))
        XCTAssertFalse(ProjectDownloads.allowsAuthorization(URL(string: "https://riffet.example/api")!, baseURL: "https://user@riffet.example"))
    }

    @MainActor
    func testImageExportsDoNotOverwriteSameNamedOriginalsAndStayPrivate() async throws {
        let firstData = Data("first original".utf8)
        let secondData = Data("second original".utf8)
        let firstResult = await ImageLoader.shared.file(for: .local(firstData), projectId: nil, name: "diagram.png")
        let secondResult = await ImageLoader.shared.file(for: .local(secondData), projectId: nil, name: "diagram.png")
        let first = try XCTUnwrap(firstResult)
        let second = try XCTUnwrap(secondResult)
        defer {
            try? FileManager.default.removeItem(at: first.deletingLastPathComponent())
            try? FileManager.default.removeItem(at: second.deletingLastPathComponent())
        }
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(first.lastPathComponent, "diagram.png")
        XCTAssertEqual(second.lastPathComponent, "diagram.png")
        XCTAssertEqual(try Data(contentsOf: first), firstData)
        XCTAssertEqual(try Data(contentsOf: second), secondData)
        let permissions = try FileManager.default.attributesOfItem(atPath: first.path)[.posixPermissions] as? NSNumber
        let directoryPermissions = try FileManager.default.attributesOfItem(atPath: first.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        XCTAssertEqual(directoryPermissions?.intValue, 0o700)
        let failed = await ImageLoader.shared.file(for: .local(firstData), projectId: nil, name: String(repeating: "a", count: 300) + ".png")
        XCTAssertNil(failed)
    }

    func testGitUpdateCheckUsesReleaseTagsAndDoesNotMutateClone() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let remote = directory.appendingPathComponent("origin")
        let clone = directory.appendingPathComponent("clone")
        try FileManager.default.createDirectory(at: remote.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try Data("{\"name\":\"riffet\"}".utf8).write(to: remote.appendingPathComponent("package.json"))
        try Data("// fixture".utf8).write(to: remote.appendingPathComponent("scripts/riffet.mjs"))
        func git(_ root: URL, _ arguments: [String]) throws -> String {
            try GitReleaseCheck.git(root.path, arguments).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        _ = try git(remote, ["init", "--initial-branch=main"])
        _ = try git(remote, ["config", "user.name", "Riffet Test"])
        _ = try git(remote, ["config", "user.email", "test@localhost"])
        _ = try git(remote, ["add", "."])
        _ = try git(remote, ["commit", "-m", "first release"])
        let first = try git(remote, ["rev-parse", "HEAD"])
        _ = try git(remote, ["tag", "v0.9.0"])
        _ = try git(remote, ["tag", "-a", "v0.8.0", "-m", "older annotation"])
        let olderObject = try git(remote, ["rev-parse", "refs/tags/v0.8.0"])
        _ = try git(remote, ["commit", "--allow-empty", "-m", "second release"])
        _ = try git(remote, ["tag", "-a", "v0.10.0", "-m", "release"])
        _ = try git(remote, ["tag", "v01.99.0"])
        _ = try git(remote, ["commit", "--allow-empty", "-m", "unreleased changes"])
        _ = try git(directory, ["clone", remote.path, clone.path])
        let beforeRefs = try git(clone, ["show-ref"])
        let beforeHead = try git(clone, ["rev-parse", "HEAD"])
        let current = AppBuildRecord.Identity(version: "0.9.0", buildNumber: 1, tag: "v0.9.0", commit: first, dirty: false)
        let result = try GitReleaseCheck.check(sourceRoot: clone.path, current: current)
        XCTAssertEqual(result.latest, "v0.10.0")
        XCTAssertEqual(result.status, .updateAvailable)
        XCTAssertEqual(try git(clone, ["show-ref"]), beforeRefs)
        XCTAssertEqual(try git(clone, ["rev-parse", "HEAD"]), beforeHead)
        XCTAssertEqual(try git(clone, ["status", "--porcelain"]), "")

        let mismatched = AppBuildRecord.Identity(version: "0.8.0", buildNumber: 1, tag: "v0.9.0", commit: first, dirty: false)
        XCTAssertEqual(try GitReleaseCheck.check(sourceRoot: clone.path, current: mismatched).status, .developmentBuild)
        let invalidCommit = AppBuildRecord.Identity(version: "0.9.0", buildNumber: 1, tag: "v0.9.0", commit: "invalid", dirty: false)
        XCTAssertEqual(try GitReleaseCheck.check(sourceRoot: clone.path, current: invalidCommit).status, .developmentBuild)

        // Even an older annotated tag changing only its annotation invalidates immutability.
        _ = try git(remote, ["tag", "-f", "-a", "v0.8.0", first, "-m", "changed annotation"])
        XCTAssertEqual(try GitReleaseCheck.check(sourceRoot: clone.path, current: current).status, .tagConflict)
        _ = try git(remote, ["update-ref", "refs/tags/v0.8.0", olderObject])

        // A moved older tag is still a release identity conflict when a newer tag exists.
        _ = try git(remote, ["tag", "-f", "v0.9.0", "HEAD"])
        let conflict = try GitReleaseCheck.check(sourceRoot: clone.path, current: current)
        XCTAssertEqual(conflict.status, .tagConflict)
        XCTAssertEqual(try git(clone, ["show-ref"]), beforeRefs)
    }
}
