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
import org.intellij.markdown.parser.MarkdownParser
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

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

    private fun emittedUrl(source: String): String {
        val root = MarkdownParser(TranscriptMarkdownFlavour()).buildMarkdownTreeFromString(source)
        val settings = object : AnnotatorSettings {
            override val linkTextSpanStyle = TextLinkStyles()
            override val codeSpanStyle = SpanStyle()
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
