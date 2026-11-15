package riffet.ui.theme

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.ImageShader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.ui.settings.PageBanner
import riffet.ui.settings.SettingsChoiceRow
import riffet.ui.settings.SettingsGroup
import riffet.ui.settings.SettingsNoticeKind
import riffet_mobile.shared.generated.resources.*

/** The installed appearance resources, one choice row per slot. Picking a colour theme is the gallery's job; the palette row here only names a server-provided override. */
@Composable
fun AppearanceResourcesPicker() {
    val state = LocalAppearanceResources.current ?: return
    val catalog = state.catalog
    val effective = state.effective
    val default = stringResource(Res.string.settings_default)
    val labels = listOf(
        AppearanceSlot.PRESET to stringResource(Res.string.settings_appearance_preset),
        AppearanceSlot.PALETTE to stringResource(Res.string.settings_appearance_palette),
        AppearanceSlot.UI_FONT to stringResource(Res.string.settings_appearance_ui_font),
        AppearanceSlot.MONO_FONT to stringResource(Res.string.settings_appearance_mono_font),
        AppearanceSlot.BACKGROUND to stringResource(Res.string.settings_appearance_background),
    )
    if (state.errors.any { it != AppearanceSlot.PRESET }) PageBanner(stringResource(Res.string.settings_appearance_resource_failed), SettingsNoticeKind.ERROR)
    if (AppearanceSlot.PRESET in state.errors) PageBanner(stringResource(Res.string.settings_appearance_catalog_failed), SettingsNoticeKind.ERROR)
    SettingsGroup("") {
        labels.forEach { (slot, label) ->
            val choices = when (slot) {
                AppearanceSlot.PRESET -> catalog?.presets?.map { it.id to localizedAppearanceTitle(it.title) }
                AppearanceSlot.PALETTE -> catalog?.palettes?.map { it.id to localizedAppearanceTitle(it.title) }
                AppearanceSlot.UI_FONT -> catalog?.fonts?.filter { it.role == "ui" }?.map { it.id to localizedAppearanceTitle(it.title) }
                AppearanceSlot.MONO_FONT -> catalog?.fonts?.filter { it.role == "mono" }?.map { it.id to localizedAppearanceTitle(it.title) }
                AppearanceSlot.BACKGROUND -> catalog?.backgrounds?.filter { "workbench" in it.areas }?.map { it.id to localizedAppearanceTitle(it.title) }
            }.orEmpty()
            if (slot == AppearanceSlot.PALETTE && choices.isEmpty()) return@forEach
            val id = when (slot) {
                AppearanceSlot.PRESET -> catalog?.presets?.firstOrNull { it.id == state.selection.preset }?.id
                AppearanceSlot.PALETTE -> effective.palette?.id
                AppearanceSlot.UI_FONT -> effective.uiFont?.id
                AppearanceSlot.MONO_FONT -> effective.monoFont?.id
                AppearanceSlot.BACKGROUND -> effective.background?.id
            }
            SettingsChoiceRow(
                title = label,
                options = listOf(DEFAULT_CHOICE to default) + choices,
                value = id ?: DEFAULT_CHOICE,
                onSelect = { state.select(slot, it) },
            )
        }
    }
    state.background?.let { image ->
        Box(Modifier.fillMaxWidth().padding(horizontal = riffet.ui.design.GroupInset, vertical = 8.dp).height(96.dp)) {
            Image(image, contentDescription = stringResource(Res.string.settings_appearance_background), modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        }
    }
}

private const val DEFAULT_CHOICE = "default"

/** Background is a passive visual layer; the caller decides its workbench/source placement. */
@Composable
fun AppearanceBackdrop(modifier: Modifier = Modifier) {
    val state = LocalAppearanceResources.current ?: return
    val image = state.background ?: return
    val contribution = state.effective.background ?: return
    val opacity = contribution.opacity.takeIf { it.isFinite() }?.coerceIn(0.0, 1.0)?.toFloat() ?: 1f
    if (contribution.fit == "tile") {
        val brush = remember(image) { ShaderBrush(ImageShader(image, TileMode.Repeated, TileMode.Repeated)) }
        Canvas(modifier.alpha(opacity)) { drawRect(brush) }
    } else Image(image, contentDescription = null, modifier = modifier.alpha(opacity), contentScale = ContentScale.Crop)
}
