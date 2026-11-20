package riffet.ui.files

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.FilePreview
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.shared.preview
import riffet.shared.saveFile
import riffet.ui.app.LocalPageBack
import riffet.ui.app.PageBarAction
import riffet.ui.app.PageBarProgress
import riffet.ui.app.RiffetPageScaffold
import riffet.ui.design.AlertDialog
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.RiffetTextButton
import riffet.ui.design.StyleTopBar
import riffet.ui.icons.RiffetIcons
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.settings.UnsavedSettingsGuard
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/**
 * The editing page of one text file (mobile.md §2.3): cancel and save in the bar, the text filling
 * the page. The text is a [TextFieldState], so typing does not copy a large file per keystroke, and
 * it is not coloured while it is edited. The save names the hash of [preview], the version the edit
 * started from; when the server refuses it (`FILE_CHANGED`) the reader chooses which side to keep.
 * [onPreview] receives the file as it is after the page ends: as saved, or as read again.
 */
@Composable
internal fun FileEditPage(api: RiffetApi, projectId: String, preview: FilePreview, onBack: () -> Unit, onPreview: (FilePreview) -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val metrics = LocalInterfaceStyle.current.metrics
    val scope = rememberCoroutineScope()
    val text = rememberTextFieldState(preview.content)
    // The version the text was read from, and the one the next save names.
    var base by remember { mutableStateOf(preview) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var conflict by remember { mutableStateOf(false) }
    val dirty by remember { derivedStateOf { !base.content.contentEquals(text.text) } }
    val pageBack = LocalPageBack.current
    val leave: () -> Unit = { pageBack?.leaveConfirmed() ?: onBack() }
    UnsavedSettingsGuard(dirty = dirty, busy = busy)

    suspend fun write() {
        val content = text.text.toString()
        val version = api.saveFile(projectId, base.path, content, base.hash)
        val saved = base.copy(content = content, hash = version.hash, size = version.size, truncated = false)
        FileCache.putPreview(projectId, saved.path, saved)
        base = saved
        onPreview(saved)
        leave()
    }
    /** Runs [step] as the page's one operation; `FILE_CHANGED` opens the choice, anything else is the banner. */
    fun operate(step: suspend () -> Unit) {
        if (busy) return
        scope.launch {
            busy = true
            error = null
            try { step() }
            catch (cancellation: CancellationException) { throw cancellation }
            catch (failure: Throwable) {
                if ((failure as? RiffetHttpException)?.code == "FILE_CHANGED") conflict = true
                else error = panelError(failure, getString(Res.string.files_error_save))
            } finally { busy = false }
        }
    }

    RiffetPageScaffold(topBar = {
        StyleTopBar(
            title = { Text(base.path.substringAfterLast('/'), style = typography.barTitle, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigation = { PageBarAction(RiffetIcons.Close, stringResource(Res.string.settings_cancel), onBack) },
            actions = {
                if (busy) PageBarProgress()
                else RiffetTextButton(onClick = { operate { write() } }, enabled = dirty) { Text(stringResource(Res.string.settings_save)) }
            },
        )
    }, bottomBar = error?.let { message -> { BannerBox(message, SettingsNoticeKind.ERROR) } }) { insets ->
        Box(Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets).imePadding()) {
            BasicTextField(
                state = text,
                modifier = Modifier.fillMaxSize().padding(horizontal = metrics.pageInset),
                readOnly = busy,
                textStyle = typography.monoSmall.copy(color = colors.fg),
                cursorBrush = SolidColor(colors.accent),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
            )
        }
    }

    if (conflict) AlertDialog(
        onDismissRequest = { conflict = false },
        title = { Text(stringResource(Res.string.files_changed_title)) },
        dismissButton = {
            RiffetTextButton(onClick = {
                conflict = false
                operate {
                    val fresh = api.preview(projectId, base.path)
                    FileCache.putPreview(projectId, fresh.path, fresh)
                    onPreview(fresh)
                    leave()
                }
            }, danger = true) { Text(stringResource(Res.string.files_drop_mine)) }
        },
        confirmButton = {
            RiffetTextButton(onClick = { conflict = false }) { Text(stringResource(Res.string.settings_cancel)) }
            RiffetTextButton(onClick = {
                conflict = false
                operate {
                    // The version now on disk is the one overwritten: its hash is what the save names.
                    base = base.copy(hash = api.preview(projectId, base.path).hash)
                    write()
                }
            }) { Text(stringResource(Res.string.files_overwrite)) }
        },
    )
}
