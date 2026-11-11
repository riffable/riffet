package riffet.ui.composer

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.NativeSlashCatalog
import riffet.contracts.NativeSlashItem
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/*
 * The `/` menu, ported from `apps/web/src/app/session/slashMenu.ts`. The rules are the web's: a
 * slash opens a token at the start of the draft or after whitespace; commands are offered only for
 * the leading token, skills also mid-message where the backend loads them there; a pick replaces
 * just the typed token with the literal `/name `, which is all the backends need.
 */

@Composable
internal fun SlashMenu(
    groups: List<Pair<Boolean, List<NativeSlashItem>>>,
    onPick: (NativeSlashItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Column(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(max = 220.dp)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 6.dp, vertical = 4.dp),
    ) {
        groups.forEach { (skills, items) ->
            Text(
                text = if (skills) "Skills" else stringResource(Res.string.composer_commands),
                style = typography.caption,
                color = colors.fg4,
                modifier = Modifier.padding(start = 8.dp, top = 6.dp, bottom = 2.dp),
            )
            items.forEach { item ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = metrics.controlHeight)
                        .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                        .clickable { onPick(item) }
                        .padding(horizontal = metrics.controlInset / 2),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "/${item.name}",
                        style = typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = colors.fg,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.widthIn(max = 180.dp),
                    )
                    Spacer(Modifier.width(10.dp))
                    Text(
                        text = item.description ?: item.hint.orEmpty(),
                        style = typography.caption,
                        color = colors.fg3,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

/** The hairline between the menu and the input below it. */
@Composable
internal fun SlashMenuDivider() {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    Spacer(Modifier.fillMaxWidth().padding(horizontal = metrics.controlInset).heightIn(min = 1.dp, max = 1.dp).background(colors.line))
}
