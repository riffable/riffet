package riffet.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlin.random.Random
import riffet.contracts.OwnerAvatarStyle
import riffet.i18n.L10n
import org.jetbrains.compose.resources.rememberResourceEnvironment
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.OwnerAvatar
import riffet.ui.pickers.LocalPickerHost
import riffet.ui.pickers.PickerOverlay
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.localizedAppearanceTitle

/** The generated-avatar styles as a grid of previews; a tap sets that picture, 换一批 rerolls every seed. */
@Composable
internal fun RandomAvatarSheet(controller: OwnerController, onDismiss: () -> Unit) {
    rememberResourceEnvironment()
    val state by controller.state.collectAsState()
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val ink = colors.fg.hex()
    val paper = colors.bg.hex()
    val hasName = !state.owner?.name.isNullOrBlank()
    val styles = remember(state.styles, hasName) { state.styles.filter { hasName || !it.needsName } }
    var batch by remember { mutableIntStateOf(0) }
    val seeds = remember(styles, batch) { styles.associate { it.id to randomSeed() } }

    PickerOverlay(title = L10n.uiText("owner.randomAvatar"), onDismiss = onDismiss) {
        val host = LocalPickerHost.current
        Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = metrics.pageInset, vertical = 8.dp)) {
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                styles.forEach { style ->
                    val seed = seeds.getValue(style.id)
                    AvatarTile(style, controller.previewUrl(style, seed, ink, paper)) {
                        controller.generate(style, seed, ink, paper)
                        host?.dismiss?.invoke()
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.Center) {
                rememberResourceEnvironment()
                SettingsButton(L10n.uiText("owner.shuffle"), onClick = { batch++ })
            }
        }
    }
}

@Composable
private fun AvatarTile(style: OwnerAvatarStyle, previewUrl: String, onClick: () -> Unit) {
    rememberResourceEnvironment()
    val colors = LocalRiffetColors.current
    val title = localizedAppearanceTitle(style.title).ifBlank { style.id.substringAfterLast('/') }
    Column(
        Modifier.width(76.dp).clip(RoundedCornerShape(12.dp))
            .clickable(role = Role.Button, onClick = onClick).padding(vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        OwnerAvatar(null, previewUrl, 56.dp)
        Text(title, style = LocalRiffetTypography.current.caption, color = colors.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
    }
}

/** At most 13 base36 characters. */
private fun randomSeed(): String = Random.nextLong().toULong().toString(36)

private fun Color.hex(): String = "#" + (toArgb() and 0xFFFFFF).toString(16).padStart(6, '0')
