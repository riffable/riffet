package riffet.ui.timeline

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import com.mikepenz.markdown.annotator.AnnotatorSettings
import com.mikepenz.markdown.annotator.buildMarkdownAnnotatedString
import com.mikepenz.markdown.model.ReferenceLinkHandlerImpl
import com.mikepenz.markdown.model.markdownAnnotator
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.ast.getTextInNode
import org.intellij.markdown.flavours.gfm.GFMElementTypes
import org.intellij.markdown.flavours.gfm.GFMTokenTypes
import org.intellij.markdown.parser.MarkdownParser
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

/** Exercises the Markdown library's emitted link targets at the app's routing boundary. */
class MarkdownLinkRoutingTest {
    @Test
    fun `artifact destinations emitted by the renderer open the project file`() {
        val path = "/Users/me/workspace/riffet/apps/mobile/androidApp/build/outputs/apk/debug/androidApp-debug.apk"
        for (destination in listOf(path, "<$path>", "</workspace/My Project/app.apk:12>")) {
            val emitted = emittedUrl("[下载 APK]($destination)")
            val target = assertIs<MarkdownLinkTarget.File>(markdownLinkTarget(emitted))
            val expected = if (destination.contains("My Project")) LocalFileLink("/workspace/My Project/app.apk", 12)
                else LocalFileLink(path, null)
            assertEquals(expected, target.link)
        }
    }

    @Test
    fun `safe break tags in paragraph and table cell render as newlines`() {
        val md = "A<br>B<br/>C\n\n| Col |\n| --- |\n| 1. a<br>2. b |"
        val root = MarkdownParser(TranscriptMarkdownFlavour()).buildMarkdownTreeFromString(md)
        val settings = object : AnnotatorSettings {
            override val linkTextSpanStyle = TextLinkStyles()
            override val codeSpanStyle = SpanStyle()
            override val highlightSpanStyle = SpanStyle()
            override val annotator = markdownAnnotator { content, child ->
                if (child.type == MarkdownTokenTypes.HTML_TAG) {
                    val breaks = safeBreakNewlines(child.getTextInNode(content).toString())
                    if (breaks != null) {
                        append(breaks)
                        return@markdownAnnotator true
                    }
                }
                false
            }
            override val referenceLinkHandler = ReferenceLinkHandlerImpl()
            override val linkInteractionListener = LinkInteractionListener { }
        }
        val paragraph = root.children.first { it.type == MarkdownElementTypes.PARAGRAPH }
        val paragraphText = AnnotatedString.Builder().apply {
            buildMarkdownAnnotatedString(content = md, node = paragraph, annotatorSettings = settings)
        }.toAnnotatedString().text
        assertEquals("A\nB\nC", paragraphText)

        val table = root.children.first { it.type == GFMElementTypes.TABLE }
        val row = table.children.first { it.type == GFMElementTypes.ROW }
        val cell: ASTNode = row.children.first { it.type == GFMTokenTypes.CELL }
        val cellText = AnnotatedString.Builder().apply {
            buildMarkdownAnnotatedString(content = md, node = cell, annotatorSettings = settings)
        }.toAnnotatedString().text.trim()
        assertEquals("1. a\n2. b", cellText)
        assertEquals(null, safeBreakNewlines("<T>"))
    }

    @Test
    fun `inline code mentions recognize tilde paths and line columns while skipping identifiers`() {
        assertEquals(LocalFileLink("~/.cursor/rules/global-conventions.mdc", null), codeFileMention("~/.cursor/rules/global-conventions.mdc"))
        assertEquals(LocalFileLink("src/app.ts", 42), codeFileMention("src/app.ts:42:3"))
        assertEquals(LocalFileLink("Makefile", null), codeFileMention("Makefile"))
        assertNull(codeFileMention("console.log"))
        assertNull(codeFileMention("process.env"))

        val encoded = encodeFileLinkUrl("~/.cursor/rules/My File.mdc", 12)
        assertEquals(LocalFileLink("~/.cursor/rules/My File.mdc", 12), parseFileLinkUrl(encoded))
    }

    private fun emittedUrl(source: String): String {
        val root = MarkdownParser(TranscriptMarkdownFlavour()).buildMarkdownTreeFromString(source)
        val settings = object : AnnotatorSettings {
            override val linkTextSpanStyle = TextLinkStyles()
            override val codeSpanStyle = SpanStyle()
            override val highlightSpanStyle = SpanStyle()
            override val annotator = markdownAnnotator { _, _ -> false }
            override val referenceLinkHandler = ReferenceLinkHandlerImpl()
            override val linkInteractionListener = LinkInteractionListener { }
        }
        val builder = AnnotatedString.Builder()
        builder.buildMarkdownAnnotatedString(content = source, node = root, annotatorSettings = settings)
        val text = builder.toAnnotatedString()
        return assertIs<LinkAnnotation.Url>(text.getLinkAnnotations(0, text.length).single().item).url
    }
}
