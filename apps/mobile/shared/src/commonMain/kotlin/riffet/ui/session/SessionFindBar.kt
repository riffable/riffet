package riffet.ui.session

import riffet.ui.gesture.horizontalSwipeChild
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import riffet.ui.design.LocalRiffetSurfaces
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.app.PageBackHandler
import riffet.ui.app.PageBarAction
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.RiffetIconButton
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.state.SessionFind
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.session_find_close
import riffet_mobile.shared.generated.resources.session_find_next
import riffet_mobile.shared.generated.resources.session_find_placeholder
import riffet_mobile.shared.generated.resources.session_find_previous

/**
 * 会话内查找 in the place of the conversation's top bar: leave, the query, where the selection is
 * among the occurrences, and the steps between them. The occurrences themselves are the
 * transcript's to land on and mark (`FindLanding`).
 *
 * @param readingKey the key of the row at the reader's place, where results begin; read when asked.
 */
@Composable
internal fun SessionFindBar(find: SessionFind, readingKey: () -> String?) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val metrics = LocalInterfaceStyle.current.metrics
    val state by find.state.collectAsState()
    var query by rememberSaveable { mutableStateOf("") }
    val requester = remember { FocusRequester() }
    LaunchedEffect(Unit) { requester.requestFocus() }
    // Back leaves find before it leaves the conversation.
    PageBackHandler(inline = true) { find.close() }
    val text = remember(typography, colors.fg) { typography.input.copy(color = colors.fg) }
    val placeholder = stringResource(Res.string.session_find_placeholder)
    // The conversation's top bar, the title's place taken by the field: same height, same edge insets.
    Row(
        modifier = Modifier.fillMaxWidth().height(64.dp).padding(start = 4.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PageBarAction(icon = RiffetIcons.ArrowLeft, description = stringResource(Res.string.session_find_close), onClick = find::close, tint = colors.fg)
        BasicTextField(
            value = query,
            onValueChange = {
                query = it
                find.setQueryFrom(it, readingKey())
            },
            singleLine = true,
            textStyle = text,
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { find.next() }),
            modifier = Modifier
                .weight(1f)
                .height(metrics.buttonHeight)
                .focusRequester(requester)
                .horizontalSwipeChild()
                .semantics { contentDescription = placeholder },
            decorationBox = { field ->
                Row(
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(CircleShape)
                        .background(LocalRiffetSurfaces.current.press)
                        .padding(start = metrics.inputInset, end = metrics.inputInset),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                        if (query.isEmpty()) Text(placeholder, style = text, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        field()
                    }
                    // Where the selection is among the occurrences, inside the field as a browser's find bar has it.
                    if (query.isNotEmpty()) {
                        Text(
                            text = if (state.total > 0) "${state.current + 1}/${state.total}" else if (state.loading) "" else "0/0",
                            style = typography.caption,
                            color = colors.fg3,
                            maxLines = 1,
                            softWrap = false,
                            modifier = Modifier.padding(start = metrics.controlInset / 2),
                        )
                    }
                }
            },
        )
        val steppable = state.hits.isNotEmpty()
        FindStep(rotated = true, description = stringResource(Res.string.session_find_previous), enabled = steppable, onClick = find::previous)
        FindStep(rotated = false, description = stringResource(Res.string.session_find_next), enabled = steppable, onClick = find::next)
    }
}

/** A step between occurrences, the bar's own action button: the same box and icon as back. */
@Composable
private fun FindStep(rotated: Boolean, description: String, enabled: Boolean, onClick: () -> Unit) {
    val colors = LocalRiffetColors.current
    val metrics = LocalInterfaceStyle.current.metrics
    Box(Modifier.size(metrics.controlHeight), contentAlignment = Alignment.Center) {
        RiffetIconButton(onClick = onClick, enabled = enabled) {
            // The pack has no up chevron: the down one, turned.
            Icon(
                RiffetIcons.ChevronDown,
                contentDescription = description,
                tint = if (enabled) colors.fg else LocalRiffetSurfaces.current.disabledContent,
                modifier = Modifier.size(metrics.iconSize).rotate(if (rotated) 180f else 0f),
            )
        }
    }
}
