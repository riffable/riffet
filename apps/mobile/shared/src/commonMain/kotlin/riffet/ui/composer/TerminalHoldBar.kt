package riffet.ui.composer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet.shared.RiffetHttpException
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.MaterialRole
import riffet.ui.design.RiffetMaterialContent
import riffet.ui.design.RiffetTextButton
import riffet.ui.design.riffetMaterial
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.session_cancel
import riffet_mobile.shared.generated.resources.confirm_release_terminal_title
import riffet_mobile.shared.generated.resources.session_terminal_force_body
import riffet_mobile.shared.generated.resources.session_terminal_hold
import riffet_mobile.shared.generated.resources.session_terminal_release

/**
 * Stands where the input card is while a terminal holds the conversation: that CLI is its only
 * writer. Taking it back while the terminal's CLI still runs is refused by the server (409
 * `TERMINAL_STILL_RUNNING`); the reader then confirms ending it.
 */
@Composable
internal fun TerminalHoldBar(store: SessionStore, sessionId: String, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    var releasing by remember(sessionId) { mutableStateOf(false) }
    var confirmForce by remember(sessionId) { mutableStateOf(false) }
    var error by remember(sessionId) { mutableStateOf<String?>(null) }

    fun release(force: Boolean) {
        if (releasing) return
        releasing = true
        error = null
        scope.launch {
            try {
                store.releaseTerminalHold(sessionId, force)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                if (!force && failure is RiffetHttpException && failure.code == "TERMINAL_STILL_RUNNING") confirmForce = true
                else error = failure.message
            } finally {
                releasing = false
            }
        }
    }

    val shape = RoundedCornerShape(LocalInterfaceStyle.current.composerRadius)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .riffetMaterial(MaterialRole.COMPOSER, shape, LocalRiffetSurfaces.current.floating),
    ) {
        RiffetMaterialContent {
            Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = metrics.controlHeight + metrics.controlInset)
                    .padding(start = metrics.inputInset, end = metrics.controlInset / 2),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(metrics.controlInset * 2 / 3),
            ) {
                Icon(RiffetIcons.Terminal, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(metrics.smallIconSize))
                Text(
                    text = error ?: stringResource(Res.string.session_terminal_hold),
                    style = typography.body,
                    color = if (error != null) colors.danger else colors.fg2,
                    maxLines = 2,
                    modifier = Modifier.weight(1f),
                )
                RiffetTextButton(onClick = { release(false) }, enabled = !releasing) {
                    Text(stringResource(Res.string.session_terminal_release))
                }
            }
        }
    }

    if (confirmForce) {
        ConfirmDialog(
            title = stringResource(Res.string.confirm_release_terminal_title),
            message = stringResource(Res.string.session_terminal_force_body),
            confirmLabel = stringResource(Res.string.session_terminal_release),
            danger = true,
            onConfirm = { confirmForce = false; release(true) },
            onDismiss = { confirmForce = false },
        )
    }
}
