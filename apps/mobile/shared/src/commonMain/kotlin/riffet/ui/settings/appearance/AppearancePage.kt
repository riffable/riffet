package riffet.ui.settings.appearance

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.font.FontWeight
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import org.jetbrains.compose.resources.stringResource
import riffet.shared.DisplaySettings
import riffet.shared.ThemeMode
import riffet.ui.app.PageHost
import riffet.ui.app.PageStack
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.settings.SettingsChoiceRow
import riffet.ui.settings.SettingsFootnote
import riffet.ui.settings.SettingsGroup
import riffet.ui.settings.SettingsNavigationRow
import riffet.ui.settings.SettingsPage
import riffet.ui.settings.SettingsSearchTarget
import riffet.ui.settings.SettingsSwitchRow
import riffet.ui.theme.AppearanceResourcesPicker
import riffet.ui.theme.AppearanceSlot
import riffet.ui.theme.LocalAppearanceResources
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.ThemeEntry
import riffet_mobile.shared.generated.resources.*

private sealed interface AppearanceRoute {
    data object Main : AppearanceRoute
    data object Resources : AppearanceRoute
}

/**
 * The appearance category page (mobile.md §2.4): the theme gallery first, then colour mode and
 * AMOLED, then installed resources one level down. Refresh is the pull gesture.
 */
@Composable
internal fun AppearancePage(
    title: String,
    onBack: () -> Unit,
    searchTarget: SettingsSearchTarget?,
    themeMode: ThemeMode,
    onThemeModeChange: (ThemeMode) -> Unit,
    themes: List<ThemeEntry>,
    themeId: String,
    onThemeIdChange: (String) -> Unit,
) {
    val resources = LocalAppearanceResources.current
    val pages = remember { PageStack<AppearanceRoute>(AppearanceRoute.Main) }
    PageHost(pages) { route, back ->
        when (route) {
            AppearanceRoute.Main -> SettingsPage(
                title, onBack, searchTarget = searchTarget,
                refreshing = resources?.loading == true,
                onRefresh = resources?.let { state -> { state.refresh() } },
            ) {
                val activeId = resources?.palette?.id ?: themeId
                Spacer(Modifier.height(LocalInterfaceStyle.current.metrics.controlInset))
                ThemeGallery(themes, activeId) { id ->
                    onThemeIdChange(id)
                    // A server-provided palette override would otherwise keep winning over the card just picked.
                    if (resources?.selection?.palette != null) resources.select(AppearanceSlot.PALETTE, "default")
                }
                SettingsFootnote(stringResource(Res.string.settings_theme_footnote))
                val display = DisplaySettings.shared
                SettingsGroup("") {
                    SettingsChoiceRow(
                        title = stringResource(Res.string.settings_color_mode),
                        options = listOf(
                            ThemeMode.SYSTEM.name to stringResource(Res.string.settings_theme_mode_system),
                            ThemeMode.LIGHT.name to stringResource(Res.string.settings_theme_mode_light),
                            ThemeMode.DARK.name to stringResource(Res.string.settings_theme_mode_dark),
                        ),
                        value = themeMode.name,
                        onSelect = { name -> ThemeMode.entries.firstOrNull { it.name == name }?.let(onThemeModeChange) },
                    )
                    SettingsSwitchRow(
                        title = stringResource(Res.string.settings_amoled),
                        description = stringResource(Res.string.settings_amoled_desc),
                        checked = display.amoled, onCheckedChange = display::changeAmoled,
                    )
                }
                if (resources != null) SettingsGroup("") {
                    SettingsNavigationRow(stringResource(Res.string.settings_appearance_resources), "") { pages.push(AppearanceRoute.Resources) }
                }
            }
            AppearanceRoute.Resources -> SettingsPage(
                stringResource(Res.string.settings_appearance_resources), back,
                refreshing = resources?.loading == true,
                onRefresh = resources?.let { state -> { state.refresh() } },
            ) { AppearanceResourcesPicker() }
        }
    }
}

/**
 * Thumbnail cards in two columns: the swatch shows the theme's light and dark halves side by side,
 * so a theme is judged by how it looks. Built-ins plus the themes shared through this server.
 */
@Composable
private fun ThemeGallery(themes: List<ThemeEntry>, selected: String, onSelect: (String) -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(metrics.sectionGap / 2)) {
        themes.chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(metrics.sectionGap / 2)) {
                pair.forEach { entry -> ThemeCard(entry, entry.id == selected, onSelect, Modifier.weight(1f)) }
                if (pair.size == 1) Box(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun ThemeCard(entry: ThemeEntry, selected: Boolean, onSelect: (String) -> Unit, modifier: Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    // The ring sits a gap outside the preview with a concentric corner, so it reads as a frame around
    // the card rather than a second, misaligned outline.
    val gap = metrics.focusWidth * 1.5f
    val ring = metrics.focusWidth
    val radius = metrics.controlRadius
    val outer = RoundedCornerShape(radius + gap + ring)
    Column(
        modifier = modifier.selectable(selected = selected, role = Role.RadioButton) { onSelect(entry.id) },
        verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
    ) {
        Box(
            Modifier.fillMaxWidth().clip(outer)
                .border(ring, if (selected) colors.accent else Color.Transparent, outer)
                .padding(ring + gap),
        ) {
            ThemePreview(entry, RoundedCornerShape(radius), Modifier.fillMaxWidth().height(metrics.controlHeight * 1.6f))
            if (selected) Box(
                Modifier.align(Alignment.TopEnd).padding(metrics.controlInset / 2).size(metrics.smallIconSize * 1.25f)
                    // Edged in the page colour: a dark accent still reads on the preview's dark half.
                    .border(metrics.focusWidth, colors.bg, CircleShape).padding(metrics.focusWidth)
                    .clip(CircleShape).background(colors.accent),
                contentAlignment = Alignment.Center,
            ) { Icon(RiffetIcons.Check, contentDescription = null, tint = colors.accentFg, modifier = Modifier.size(metrics.smallIconSize * 0.8f)) }
        }
        Text(
            entry.name,
            style = LocalRiffetTypography.current.subhead,
            color = colors.fg,
            fontWeight = if (selected) FontWeight.SemiBold else null,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = ring + gap),
        )
    }
}

/**
 * A theme as a tiny page in each of its modes: the page colour, a card with two lines of text in the
 * theme's own text tones, and its accent as a button, so the contrast is visible, not just the hue.
 */
@Composable
private fun ThemePreview(entry: ThemeEntry, shape: RoundedCornerShape, modifier: Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    Row(modifier.clip(shape).border(metrics.hairlineWidth, LocalRiffetColors.current.line, shape)) {
        listOf(entry.light, entry.dark).forEach { side ->
            Column(
                Modifier.weight(1f).fillMaxHeight().background(side.bg).padding(metrics.controlInset / 2),
                verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 3, Alignment.CenterVertically),
            ) {
                val line = RoundedCornerShape(50)
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(metrics.controlRadius / 2)).background(side.bgElevated)
                        .padding(metrics.controlInset / 3),
                    verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 4),
                ) {
                    Box(Modifier.fillMaxWidth(0.8f).height(metrics.hairlineWidth * 4).clip(line).background(side.fg))
                    Box(Modifier.fillMaxWidth(0.55f).height(metrics.hairlineWidth * 4).clip(line).background(side.fg3))
                }
                Box(Modifier.fillMaxWidth(0.45f).height(metrics.hairlineWidth * 8).clip(line).background(side.accent))
            }
        }
    }
}
