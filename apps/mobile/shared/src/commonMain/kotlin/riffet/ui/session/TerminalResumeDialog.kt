package riffet.ui.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.SessionResumeCommand
import riffet.shared.RiffetApi
import riffet.shared.releaseSessionCli
import riffet.shared.resumeCommand
import riffet.ui.design.AlertDialog
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.RiffetIconButton
import riffet.ui.design.RiffetTextButton
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.pickers_close
import riffet_mobile.shared.generated.resources.session_resume_command
import riffet_mobile.shared.generated.resources.session_resume_credentials
import riffet_mobile.shared.generated.resources.session_resume_id
import riffet_mobile.shared.generated.resources.session_resume_note
import riffet_mobile.shared.generated.resources.session_resume_title

private const val COPIED_MS = 1_500L

/**
 * The ID and the shell command that resume a conversation in a terminal. Copying the command first
 * stops this conversation's CLI in Riffet, so the terminal's is its only writer; a refusal (a turn
 * is running) is shown here and nothing is copied.
 */
@Composable
internal fun TerminalResumeDialog(api: RiffetApi, sessionId: String, onDismiss: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var resume by remember(sessionId) { mutableStateOf<SessionResumeCommand?>(null) }
    var error by remember(sessionId) { mutableStateOf<String?>(null) }
    var releasing by remember(sessionId) { mutableStateOf(false) }
    var copiedId by remember(sessionId) { mutableStateOf(false) }
    var copiedCommand by remember(sessionId) { mutableStateOf(false) }

    LaunchedEffect(sessionId) {
        try {
            resume = api.resumeCommand(sessionId)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            error = failure.message
        }
    }
    LaunchedEffect(copiedId) { if (copiedId) { delay(COPIED_MS); copiedId = false } }
    LaunchedEffect(copiedCommand) { if (copiedCommand) { delay(COPIED_MS); copiedCommand = false } }

    @Composable
    fun Field(label: String, value: String, copied: Boolean, enabled: Boolean, onCopy: () -> Unit) {
        Column {
            Text(label, style = typography.caption, color = colors.fg3)
            Row(verticalAlignment = Alignment.CenterVertically) {
                SelectionContainer(Modifier.weight(1f)) {
                    Text(value, style = typography.monoSmall, color = colors.fg)
                }
                RiffetIconButton(onClick = onCopy, enabled = enabled) {
                    Icon(if (copied) RiffetIcons.Check else RiffetIcons.Copy, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(metrics.smallIconSize))
                }
            }
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(Res.string.session_resume_title)) },
        text = {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(metrics.controlInset)) {
                resume?.let { read ->
                    Field(stringResource(Res.string.session_resume_id), read.nativeSessionId, copiedId, enabled = true) {
                        clipboard.setText(AnnotatedString(read.nativeSessionId))
                        copiedId = true
                    }
                    Field(stringResource(Res.string.session_resume_command), read.command, copiedCommand, enabled = !releasing) {
                        releasing = true
                        error = null
                        scope.launch {
                            try {
                                api.releaseSessionCli(sessionId)
                                clipboard.setText(AnnotatedString(read.command))
                                copiedCommand = true
                            } catch (cancellation: CancellationException) {
                                throw cancellation
                            } catch (failure: Throwable) {
                                error = failure.message
                            } finally {
                                releasing = false
                            }
                        }
                    }
                    Text(stringResource(Res.string.session_resume_note), style = typography.caption, color = colors.fg3)
                    if (read.credentialsOmitted) {
                        Text(stringResource(Res.string.session_resume_credentials), style = typography.caption, color = colors.fg3)
                    }
                }
                error?.let { Text(it, style = typography.caption, color = colors.danger) }
            }
        },
        confirmButton = { RiffetTextButton(onClick = onDismiss) { Text(stringResource(Res.string.pickers_close)) } },
    )
}
