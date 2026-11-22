package riffet.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

class ToolRowPresentationTest {
    private val root = "/Users/dev/workspace/riffet"

    private fun obj(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(
        pairs.associate { (k, v) ->
            k to when (v) {
                is JsonObject -> v
                is JsonArray -> v
                is String -> JsonPrimitive(v)
                is Number -> JsonPrimitive(v)
                is Boolean -> JsonPrimitive(v)
                else -> JsonPrimitive(v.toString())
            }
        },
    )

    @Test
    fun compactsSearchGlobRgFilesAndSqlite() {
        assertEquals("additive|latest…", compactSearchQuery("'additive|latest|tag|version'"))

        val rgChained = describeToolRow(
            obj(
                "kind" to "execute",
                "rawInput" to obj("command" to "rg -n 'additive|latest|tag|version' scripts/gen-contracts.ts | tail -35; git config --get core.hooksPath; git tag --list"),
            ),
            "Tool",
            root,
        )
        assertEquals("search", rgChained.icon)
        assertEquals("Search", rgChained.verb)
        assertEquals("additive|latest…", rgChained.primary)
        assertEquals("gen-contracts.ts", rgChained.secondary)
        assertEquals(2, rgChained.extraCommands)

        val globAll = describeToolRow(
            obj(
                "kind" to "search",
                "toolName" to "Glob",
                "rawInput" to obj("glob_pattern" to "*", "target_directory" to "$root/apps/mobile/client/src/commonMain/kotlin/riffet/ui/timeline"),
            ),
            "Tool",
            root,
        )
        assertEquals("List", globAll.verb)
        assertEquals("ui/timeline", globAll.primary)
        assertEquals("code", globAll.primaryKind)

        val rgFiles = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "rg --files apps/server/src/backends/claude")),
            "Tool",
            root,
        )
        assertEquals("List", rgFiles.verb)
        assertEquals("backends/claude", rgFiles.primary)
        assertEquals("code", rgFiles.primaryKind)

        val sqlite = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "sqlite3 /Users/dev/.local/share/riffet/workbench.db \"SELECT id FROM sessions\"")),
            "Tool",
            root,
        )
        assertEquals("Run", sqlite.verb)
        assertEquals("sqlite3", sqlite.prefix)
        assertEquals("~/.local/…/riffet/workbench.db", sqlite.primary)
        assertEquals("path", sqlite.primaryKind)
    }

    @Test
    fun appliesFiveTierInlineScriptExtraction() {
        val edited = describeToolRow(
            obj(
                "kind" to "execute",
                "rawInput" to obj("command" to "python3 - <<'PY'\nfrom pathlib import Path\nPY"),
                "content" to JsonArray(
                    listOf(
                        obj("type" to "diff", "path" to "$root/CHANGELOG.md", "oldText" to "a", "newText" to "b"),
                        obj("type" to "diff", "path" to "$root/CHANGELOG.zh-CN.md", "oldText" to "a", "newText" to "b"),
                    ),
                ),
            ),
            "Tool",
            root,
        )
        assertEquals("Edit", edited.verb)
        assertEquals("python3", edited.prefix)
        assertEquals("CHANGELOG.md, CHANGELOG.zh-CN.md", edited.primary)

        val commented = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "python3 - <<'PY'\n# Verify release tarball excludes internal paths\nimport tarfile\nPY")),
            "Tool",
            root,
        )
        assertEquals("Run", commented.verb)
        assertEquals("python3", commented.prefix)
        assertEquals("Verify release tarball excludes internal paths", commented.primary)
        assertEquals("prose", commented.primaryKind)

        val scanned = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "python3 - <<'PY'\nimport pathlib\npathlib.Path('apps/macos/Riffet/Resources/Localizable.xcstrings').read_text()\nPY")),
            "Tool",
            root,
        )
        assertEquals("Run", scanned.verb)
        assertEquals("python3", scanned.prefix)
        assertEquals("apps/macos/Riffet/Resources/Localizable.xcstrings", scanned.primary)
        assertEquals("path", scanned.primaryKind)

        val fallback = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "python3 - <<'PY'\na = 1\nb = 2\nc = a + b\nprint(c)\nPY")),
            "Tool",
            root,
        )
        assertEquals("Run", fallback.verb)
        assertEquals("python3", fallback.primary)
        assertEquals(4, fallback.lineCount)
    }

    @Test
    fun normalizesGitGhJobsAndOutsidePaths() {
        val merge = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "git fetch --quiet --no-tags . refs/heads/main && git merge --no-edit FETCH_HEAD")),
            "Tool",
            root,
        )
        assertEquals("git", merge.icon)
        assertEquals("Git", merge.verb)
        assertEquals("merge", merge.primary)
        assertEquals("main", merge.secondary)
        assertEquals(1, merge.extraCommands)

        val gh1 = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "gh api repos/riffable/riffet/actions/runs/44989512781/jobs --jq '.jobs[]'")),
            "Tool",
            root,
        )
        val gh2 = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "gh api repos/riffable/riffet/actions/runs/44989512777/jobs --jq '.jobs[]'")),
            "Tool",
            root,
        )
        assertEquals("gh-api:actions/runs/…/jobs", gh1.mergeKey)
        assertEquals(gh1.mergeKey, gh2.mergeKey)
        assertEquals("actions/runs/…/jobs", gh1.mergedSecondary)

        assertEquals("~/.cursor/…/terminals/426378.txt", compactDisplayPath("/Users/dev/.cursor/projects/Users-dev-workspace-riffet/terminals/426378.txt", root))
        assertEquals("/tmp/…/pack.log", compactDisplayPath("/tmp/riffet-release-0.10.0.QkaHBlRC/pack.log", root))

        val gradleJob = describeJobRow(
            "./gradlew :client:jvmTest --tests \"riffet.ui.timeline.TimelineRowsTest\" :shared:compileCommonMainKotlinMetadata",
            "./gradlew :client:jvmTest --tests \"riffet.ui.timeline.TimelineRowsTest\" :shared:compileCommonMainKotlinMetadata",
            root,
        )
        assertEquals("gradlew :client:jvmTest", gradleJob.primary)
        assertEquals("TimelineRowsTest", gradleJob.secondary)
        assertEquals(1, gradleJob.extraCommands)

        assertEquals(ToolPathParts("Timeline.tsx", "apps/web/src/app/session"), splitToolPath("apps/web/src/app/session/Timeline.tsx"))
    }

    @Test
    fun handlesQuotedOperatorsMultilineScriptsFlagsAndTruncatedJobTitles() {
        val rgRegex = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to """rg "\bfoo\b" apps/web/src/app/session/Timeline.tsx""")),
            "Tool",
            root,
        )
        assertEquals("Search", rgRegex.verb)
        assertEquals("foo", rgRegex.primary)
        assertEquals("Timeline.tsx", rgRegex.secondary)

        val rgArrow = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "rg 'a->b' apps/web/src/app/session/Timeline.tsx")),
            "Tool",
            root,
        )
        assertEquals("Search", rgArrow.verb)
        assertEquals("a->b", rgArrow.primary)
        assertEquals("Timeline.tsx", rgArrow.secondary)

        val multilinePy = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "python3 -c \"\n# Inspect session timeline\nprint(1 << 2)\n\"")),
            "Tool",
            root,
        )
        assertEquals("Run", multilinePy.verb)
        assertEquals("python3", multilinePy.prefix)
        assertEquals("Inspect session timeline", multilinePy.primary)

        val ghPost = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "gh api -X POST repos/riffable/riffet/pulls/42/comments --jq '.id'")),
            "Tool",
            root,
        )
        assertEquals("pulls/42/comments", ghPost.secondary)
        assertEquals("gh-api:pulls/…/comments", ghPost.mergeKey)

        val rgFiles = describeToolRow(
            obj("kind" to "execute", "rawInput" to obj("command" to "rg --files -g '*.ts' apps/server/src/backends/claude")),
            "Tool",
            root,
        )
        assertEquals("List", rgFiles.verb)
        assertEquals("backends/claude", rgFiles.primary)

        val truncatedJob = describeJobRow(
            "git fetch --quiet --no-tags . refs/heads/main…",
            "git fetch --quiet --no-tags . refs/heads/main && git merge --no-edit FETCH_HEAD",
            root,
        )
        assertEquals("Git", truncatedJob.verb)
        assertEquals("merge", truncatedJob.primary)
        assertEquals("main", truncatedJob.secondary)
    }
}
