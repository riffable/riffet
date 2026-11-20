package riffet.ui.design

import androidx.compose.foundation.border
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import riffet.theme.RiffetColors
import riffet.ui.theme.LocalRiffetMotion

/**
 * The app's surface layers, derived from the palette in scope so every theme gets them without a
 * new colour role:
 *
 *  - [page]: a plain page (the 任务 list, a transcript), the palette's own `bg`;
 *  - [groupedPage]: the page under grouped cards (设置, 新会话, sheets, the drawer), the same palette background as other pages;
 *  - [card]: a grouped card on [groupedPage];
 *  - [floating]: chrome that floats over content (the composer, menus, sheets' rows);
 *  - [press]: the highlight a pressed surface shows ([RiffetPressIndication]).
 *
 * Grouped cards use tonal separation and dividers; only floating controls receive shadows.
 */
@Immutable
data class RiffetSurfaces(
    val page: Color,
    val groupedPage: Color,
    val card: Color,
    val floating: Color,
    val press: Color,
    val selected: Color,
    val selectedContent: Color,
    val disabledContent: Color,
    val focus: Color,
    val hairline: Color,
    /** The ink shadows are cast in: the palette's own text tone in light, so a warm theme casts warm. */
    val shadow: Color,
    val dark: Boolean,
    val input: Color,
    val navigation: Color,
    val scrim: Color,
    val primaryAction: Color,
    val primaryActionContent: Color,
    val secondaryAction: Color,
    val secondaryActionContent: Color,
    val switchThumb: Color,

)

internal fun riffetSurfaces(colors: RiffetColors, dark: Boolean, recipe: SurfaceRecipe = SurfaceRecipe(), overrides: Map<String, String> = emptyMap()): RiffetSurfaces {
    fun color(role: String, default: Color) = overrides[role]?.let(::designColor) ?: default
    val page = color("page", if (dark) colors.bg else lerp(colors.bg, colors.fg, recipe.pageMix))
    val card = color("card", when (recipe.card) {
        CardPresentation.TONAL -> lerp(page, colors.fg, if (dark) 0.07f else 0.035f)
        CardPresentation.ELEVATED -> colors.bgElevated
        CardPresentation.WHITE_BLEND -> if (dark) colors.bgElevated else lerp(page, Color.White, 0.42f)
    })
    // Menus, dialogs and the composer sit on the card tone: an accent cast read as a blue wash.
    val floating = color("floating", card)
    // The neutral fill has to read on the page and on a card alike, so it is a step of ink, not the palette's faint hover tone.
    val selected = color("selected", if (recipe.neutralSelection) lerp(card, colors.fg, if (dark) 0.16f else 0.09f)
        else lerp(card, colors.accent, if (dark) 0.22f else recipe.selectionLightMix))
    return RiffetSurfaces(
        page = page,
        groupedPage = color("groupedPage", page),
        card = card,
        floating = floating,
        press = color("press", colors.fg.copy(alpha = recipe.pressAlpha)),
        selected = selected,
        selectedContent = color("selectedContent", colors.fg),
        disabledContent = color("disabledContent", colors.fg.copy(alpha = 0.38f)),
        focus = color("focus", colors.accent),
        hairline = color("hairline", if (recipe.softLines) colors.lineSoft.compositeOver(card) else colors.line),
        shadow = color("shadow", if (dark) Color.Black else colors.fg),
        dark = dark,
        // Neutral fills are a step of ink over whatever they sit on: the palette's muted tone is the card's own in a dark
        // theme, where a field or a quiet button drawn in it has no edge at all.
        input = color("input", if (recipe.transparentInput) Color.Transparent
            else if (recipe.neutralSelection) colors.fg.copy(alpha = if (dark) 0.1f else 0.05f)
            else colors.bgMuted.copy(alpha = if (dark) 0.8f else 0.5f)),
        navigation = color("navigation", floating.copy(alpha = recipe.navigationAlpha)),
        scrim = color("scrim", Color.Black.copy(alpha = recipe.scrimAlpha)),
        primaryAction = color("primaryAction", if (recipe.inkPrimary) colors.primary else colors.accent),
        primaryActionContent = color("primaryActionContent", if (recipe.inkPrimary) colors.primaryFg else colors.accentFg),
        secondaryAction = color("secondaryAction", if (recipe.tonalSecondary) selected
            else if (recipe.neutralSelection) colors.fg.copy(alpha = if (dark) 0.12f else 0.07f) else colors.bgMuted),
        secondaryActionContent = color("secondaryActionContent", colors.fg),
        switchThumb = color("switchThumb", if (recipe.accentThumb) colors.accentFg else Color.White),
    )
}

/** Strict hex parsing, also for cached documents received before their server was upgraded. */
private fun designColor(raw: String): Color? {
    if (!Regex("^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$").matches(raw)) return null
    val value = raw.substring(1).toLongOrNull(16) ?: return null
    val rgb = if (raw.length == 9) value shr 8 else value
    return Color(((rgb shr 16) and 255).toFloat() / 255f, ((rgb shr 8) and 255).toFloat() / 255f,
        (rgb and 255).toFloat() / 255f, if (raw.length == 9) (value and 255).toFloat() / 255f else 1f)
}

val LocalRiffetSurfaces = staticCompositionLocalOf { riffetSurfaces(riffet.theme.RiffetDefaultTheme.light, false) }

internal val surfaces: RiffetSurfaces
    @Composable @ReadOnlyComposable get() = LocalRiffetSurfaces.current

/** Grouped surfaces use tone and separators, not a decorative card rim. */
@Composable
internal fun Modifier.cardEdge(shape: Shape): Modifier = this

/**
 * Floating chrome (the composer, a menu): a restrained shadow, so it reads as
 * resting above the page rather than printed on it. [lifted] deepens the shadow, e.g. while the
 * composer has focus.
 */
@Composable
internal fun Modifier.floatingShadow(shape: Shape, lifted: Boolean = false): Modifier {
    val s = surfaces
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    return dropShadow(shape, Shadow(
        radius = if (lifted) metrics.floatingShadowLiftedRadius else metrics.floatingShadowRadius,
        color = s.shadow,
        spread = metrics.floatingShadowSpread,
        offset = DpOffset(0.dp, metrics.floatingShadowOffset),
        alpha = motion.floatingShadowOpacity,
    ))
}
