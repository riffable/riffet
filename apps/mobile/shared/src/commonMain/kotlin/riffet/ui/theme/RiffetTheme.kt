package riffet.ui.theme

import riffet.shared.SurfaceMaterial
import riffet.shared.PageAnimation
import riffet.ui.design.RiffetMaterialScope

import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.LocalOverscrollFactory
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.ripple
import riffet.shared.InterfaceStyle
import riffet.ui.design.resolveDesign
import riffet.contracts.ThemeTextStyle
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.interfaceStyleTokens
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import riffet.theme.RiffetCodeColors
import riffet.theme.RiffetColors
import riffet.theme.RiffetDefaultCodeTheme
import riffet.theme.RiffetDefaultTheme
import riffet.theme.riffetCodeTheme
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.RiffetPressIndication
import riffet.ui.design.riffetSurfaces
import riffet.ui.timeline.rememberReducedMotion

/**
 * The Compose face of the generated design tokens (`riffet.theme`, produced by
 * `scripts/gen-mobile-theme.ts` from `apps/web/src/styles/index.css`).
 *
 * Two composition locals carry the whole design system:
 *
 *  - [LocalRiffetColors] exposes all 53 colour roles verbatim, so a screen never has to remember
 *    which Material slot a Riffet role was squeezed into;
 *  - [LocalRiffetTypography] pairs each of the seven type scales with the only sensible Compose
 *    [TextStyle], including the mono family the transcript's code and tool rows need.
 *
 * `RiffetTheme` additionally mirrors the palette into `MaterialTheme.colorScheme`. That is a
 * convenience for the handful of Material components that read the scheme directly (a `Scaffold`
 * background, a default `Text`), not a second source of truth: nothing here redeclares a colour,
 * and call sites that care should read [LocalRiffetColors].
 *
 * Nothing in this file builds a `RiffetColors`; the generated file owns every value.
 */
@Immutable
data class RiffetTypography(
    /** Material's title-large step, medium: a screen, sheet or session title. */
    val title: TextStyle,
    /** Material's body-large: ordinary body copy, the transcript's prose included. */
    val body: TextStyle,
    /** Material's body-medium: a denser body, e.g. a list row's second line. */
    val bodySmall: TextStyle,
    /** Material's label-large: a control label. */
    val label: TextStyle,
    /** Material's body-small: the smallest supporting line. */
    val caption: TextStyle,
    /** Code inside prose, a step under [body]. */
    val mono: TextStyle,
    /** Code in a tool row, a diff or an inline span. */
    val monoSmall: TextStyle,
    /** The family [mono] and [monoSmall] use, for call sites that style runs themselves. */
    val monoFamily: FontFamily,
    /** A tab root's large title, which shrinks into its bar on scroll. */
    val largeTitle: TextStyle,
    /** A bar's title: pushed pages, and a tab root once its large title has scrolled away. */
    val barTitle: TextStyle,
    /** A list row's title, a step heavier than [body]. */
    val headline: TextStyle,
    /** A list row's second line. */
    val subhead: TextStyle,
    /** A group's or a section's label. */
    val footnote: TextStyle,
    val button: TextStyle = label,
    val buttonSmall: TextStyle = label,
    val input: TextStyle = body,
    val segmented: TextStyle = label,
    val menu: TextStyle = body,
    val dialogTitle: TextStyle = title,
    val dialogBody: TextStyle = bodySmall,

)

/**
 * The web font stacks are CSS strings (`RiffetFontFamilies`); Compose cannot resolve them to a
 * platform family without a bundled font, so the mono roles use the platform's monospace family
 * and the sans roles use the platform default. See the report on this task for the trade-off.
 *
 * The sizes are Material 3's phone scale rather than the web's 13/14px desktop one: the web is read
 * on a monitor at arm's length, this in the hand, and a 14sp body there read as cramped. Line
 * heights run a little above Material's because Chinese has no ascenders to open the lines up.
 */
// Lazy: the generated mono styles and the style presets read this while their own files initialise,
// and an eager value here closed a static-init cycle that crashed the app at launch (a null typography).
internal val RiffetDefaultTypography: RiffetTypography by lazy { RiffetTypography(
    title = TextStyle(fontSize = 18.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium),
    body = TextStyle(fontSize = 16.sp, lineHeight = 26.sp),
    bodySmall = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
    label = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    caption = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
    mono = riffet.ui.design.MobileMonoText,
    monoSmall = riffet.ui.design.MobileMonoSmallText,
    monoFamily = FontFamily.Monospace,
    largeTitle = TextStyle(fontSize = 30.sp, lineHeight = 38.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.4).sp),
    barTitle = TextStyle(fontSize = 18.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium),
    headline = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium),
    subhead = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    footnote = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold),
) }

val LocalRiffetColors: ProvidableCompositionLocal<RiffetColors> =
    staticCompositionLocalOf { RiffetDefaultTheme.light }

val LocalRiffetCodeColors = staticCompositionLocalOf { RiffetDefaultCodeTheme.light }

val LocalRiffetTypography: ProvidableCompositionLocal<RiffetTypography> =
    staticCompositionLocalOf { RiffetDefaultTypography }

/**
 * Whether the palette in scope is the dark half.
 *
 * A composition local rather than a parameter threaded through every screen: it is a property of the
 * theme, and a caller holding the palette (through [LocalRiffetColors]) but not the mode would
 * otherwise have to infer it — which is what the terminal screens did, comparing the palette against
 * one specific theme's dark half. That test stopped meaning anything the moment a second theme
 * existed.
 */
val LocalRiffetDarkTheme: ProvidableCompositionLocal<Boolean> =
    staticCompositionLocalOf { false }

/**
 * The theme in scope, as a whole: screens that need more than the resolved colours — the terminal,
 * which also needs the sixteen ANSI slots of the matching half — read it here instead of taking a
 * parameter through every layer. [LocalRiffetColors] remains the common case.
 */
val LocalRiffetThemeEntry: ProvidableCompositionLocal<ThemeEntry> =
    staticCompositionLocalOf { builtinThemeEntries.first() }

/**
 * Installs the Riffet palette, typography and system-bar appearance.
 *
 * [darkTheme] is the mode and [entry] is the palette, kept apart for the same reason the web keeps
 * them apart: "follow the system" decides the mode only, so it must not also decide which theme is
 * on screen. [entry] defaults to the first built-in so tests and previews can call
 * `RiffetTheme(false)` unchanged.
 */
@Composable
fun RiffetTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    entry: ThemeEntry = builtinThemeEntries.first(),
    interfaceStyle: InterfaceStyle = InterfaceStyle.RIFFET,
    amoled: Boolean = false,
    surfaceMaterial: SurfaceMaterial = SurfaceMaterial.FROSTED,
    materialStrength: Float = 0.5f,
    pageAnimation: PageAnimation = PageAnimation.DEFAULT,
    uiFont: FontFamily? = null,
    monoFont: FontFamily? = null,
    codeThemeId: String = "auto",
    customCodeThemes: List<ThemeEntry> = emptyList(),
    content: @Composable () -> Unit,
) {
    val pureBlack = darkTheme && amoled
    val palette = if (darkTheme) entry.dark else entry.light
    val colors = if (pureBlack) palette.copy(
        bg = Color.Black, bgSidebar = Color.Black, bgSubtle = Color(0xFF0A0A0A),
        bgMuted = Color(0xFF181818), bgElevated = Color(0xFF121212), bgPopover = Color(0xFF1C1C1C),
    ) else palette
    val renderEntry = remember(entry, pureBlack, colors) {
        if (pureBlack) entry.copy(dark = colors, revision = entry.revision + ":amoled") else entry
    }
    val design = remember(interfaceStyle, entry.design, darkTheme) { resolveDesign(interfaceStyle, entry.design, darkTheme) }
    val style = remember(design) { interfaceStyleTokens(design) }
    val reduced = rememberReducedMotion()
    val effectiveAnimation = if (reduced) PageAnimation.NONE else pageAnimation
    val pageMotion = remember(effectiveAnimation, style.motion) { RiffetPageMotion(effectiveAnimation, style.motion) }
    val surfaceOverrides = if (pureBlack) design.colors + mapOf(
        "page" to "#000000", "groupedPage" to "#000000", "card" to "#121212",
        "floating" to "#1c1c1c", "navigation" to "#121212", "input" to "#181818",
    ) else design.colors
    val surfaces = riffetSurfaces(colors, darkTheme, style.components.surfaces, surfaceOverrides)
    val rawCodeColors = remember(codeThemeId, entry, customCodeThemes, darkTheme) {
        val customPicked = if (codeThemeId.startsWith("custom-")) {
            customCodeThemes.firstOrNull { it.id == codeThemeId }?.syntax
        } else null
        val theme = customPicked
            ?: (if (codeThemeId == "auto") entry.syntax else null)
            ?: riffetCodeTheme(codeThemeId, entry.id)
        if (darkTheme) theme.dark else theme.light
    }
    val codeColors = remember(rawCodeColors, colors.fg, colors.fg3, darkTheme) {
        val fgWeight = if (darkTheme) 0.10f else 0.12f
        val commentWeight = if (darkTheme) 0.15f else 0.20f
        RiffetCodeColors(
            comment = lerp(rawCodeColors.comment, colors.fg3, commentWeight),
            keyword = lerp(rawCodeColors.keyword, colors.fg, fgWeight),
            string = lerp(rawCodeColors.string, colors.fg, fgWeight),
            number = lerp(rawCodeColors.number, colors.fg, fgWeight),
            constant = lerp(rawCodeColors.constant, colors.fg, fgWeight),
            declaration = lerp(rawCodeColors.declaration, colors.fg, fgWeight),
            type = lerp(rawCodeColors.type, colors.fg, fgWeight),
            property = lerp(rawCodeColors.property, colors.fg, fgWeight),
            namespace = lerp(rawCodeColors.namespace, colors.fg, fgWeight),
            tag = lerp(rawCodeColors.tag, colors.fg, fgWeight),
            attribute = lerp(rawCodeColors.attribute, colors.fg, fgWeight),
            annotation = lerp(rawCodeColors.annotation, colors.fg, fgWeight),
            escape = lerp(rawCodeColors.escape, colors.fg, fgWeight),
            heading = lerp(rawCodeColors.heading, colors.fg, fgWeight),
            commentItalic = rawCodeColors.commentItalic,
        )
    }
    val type = design.preset.typography.native.withAppearanceFont(uiFont)
    val defaults = design.preset.typography.shared
    val riffetType = defaults.overridden(design.typography).withAppearanceFonts(uiFont, monoFont)
    // Keep the full native Material type scale. Shared aliases replace extra roles only when
    // the theme explicitly specifies them; default button labels must not enlarge badges, etc.
    fun nativeRole(role: String, value: TextStyle, fallback: TextStyle): TextStyle =
        if (design.preset.typography.mapSharedAliases || role in design.typography) value else fallback
    val materialType = type.copy(
        displayLarge = nativeRole("largeTitle", riffetType.largeTitle, type.displayLarge),
        displayMedium = nativeRole("largeTitle", riffetType.largeTitle, type.displayMedium),
        displaySmall = nativeRole("largeTitle", riffetType.largeTitle, type.displaySmall),
        headlineLarge = riffetType.largeTitle,
        headlineMedium = nativeRole("title", riffetType.title, type.headlineMedium),
        headlineSmall = riffetType.dialogTitle,
        titleLarge = riffetType.title, titleMedium = riffetType.headline,
        titleSmall = nativeRole("subhead", riffetType.subhead, type.titleSmall),
        bodyLarge = riffetType.body, bodyMedium = riffetType.bodySmall, bodySmall = riffetType.caption,
        labelLarge = riffetType.label,
        labelMedium = nativeRole("buttonSmall", riffetType.buttonSmall, type.labelMedium),
        labelSmall = nativeRole("caption", riffetType.caption, type.labelSmall),
    )
    // Android only; a no-op actual on every other platform (see RiffetSystemBars.*).
    RiffetSystemBars(darkTheme = darkTheme)
    CompositionLocalProvider(
        LocalRiffetColors provides colors.copy(
            bg = surfaces.page,
            bgElevated = if ("card" in design.colors) surfaces.card else colors.bgElevated,
            bgPopover = if ("floating" in design.colors) surfaces.floating else colors.bgPopover,
        ),
        LocalRiffetCodeColors provides codeColors,
        LocalRiffetThemeEntry provides renderEntry,
        LocalRiffetTypography provides riffetType,
        LocalInterfaceStyle provides style,
        LocalRiffetMotion provides style.motion,
        LocalRiffetPageMotion provides pageMotion,
        LocalRiffetDarkTheme provides darkTheme,
    ) {
        MaterialTheme(
            colorScheme = (if (darkTheme) riffetDarkScheme(colors) else riffetLightScheme(colors)).copy(
                background = surfaces.page,
                surface = surfaces.page,
                scrim = surfaces.scrim,
                surfaceTint = Color.Transparent,
                surfaceContainerLow = surfaces.card,
                surfaceContainer = surfaces.floating,
                surfaceContainerHigh = surfaces.floating,
                surfaceContainerHighest = if (design.preset.mutedNativeContainer) colors.bgMuted else surfaces.card,
                outline = if ("hairline" in design.colors) surfaces.hairline else colors.fg3,
                secondaryContainer = surfaces.selected,
                onSecondaryContainer = surfaces.selectedContent,
            ),
            shapes = style.shapes,
            typography = materialType,
        ) {
            // The feedback recipe selects the native ripple or a uniform press highlight, with a faint
            // ripple only in remaining Material-backed controls.
            CompositionLocalProvider(
                LocalRiffetSurfaces provides surfaces,
                LocalTextSelectionColors provides TextSelectionColors(
                    handleColor = surfaces.focus,
                    backgroundColor = surfaces.selected,
                ),
                LocalIndication provides if (style.components.ripple) ripple() else RiffetPressIndication(surfaces.press, surfaces.focus, style.motion, style.metrics.focusWidth),
                LocalRippleConfiguration provides if (style.components.ripple) RippleConfiguration() else RippleConfiguration(colors.fg, PressRippleAlpha),
            ) {
                riffet.shared.AppLanguageEnvironment { RiffetVisualWorkScope { RiffetMaterialScope(surfaceMaterial, materialStrength, content) } }
            }
        }
    }
}

private val PressRippleAlpha = RippleAlpha(draggedAlpha = 0.06f, focusedAlpha = 0.06f, hoveredAlpha = 0.04f, pressedAlpha = 0.07f)

/**
 * The subset of the Riffet roles that Material components actually read. Everything else stays
 * reachable through [LocalRiffetColors]; this mapping exists so a menu, dialog, drawer or default
 * `Text` never falls back to Material's own purple. The `surfaceContainer*` roles matter most:
 * `DropdownMenu`, `AlertDialog`, `ModalDrawerSheet` and the pull-to-refresh indicator paint with
 * them, and the tint equals the surface so tonal elevation adds no colour cast. `primary` is the
 * accent, not the web's near-black button colour: Material spends it on the controls that should
 * carry the brand — a dialog's buttons, a focused field, a progress ring, the selection handles.
 */
private fun riffetLightScheme(colors: RiffetColors) = lightColorScheme(
    primary = colors.accent,
    onPrimary = colors.accentFg,
    primaryContainer = colors.accentSoft,
    onPrimaryContainer = colors.fg,
    secondary = colors.accent,
    onSecondary = colors.primaryFg,
    secondaryContainer = colors.bgActive,
    onSecondaryContainer = colors.fg,
    tertiary = colors.accent,
    onTertiary = colors.primaryFg,
    background = colors.bg,
    onBackground = colors.fg,
    surface = colors.bgElevated,
    onSurface = colors.fg,
    surfaceVariant = colors.bgSubtle,
    onSurfaceVariant = colors.fg2,
    surfaceTint = colors.bgElevated,
    inverseSurface = colors.toast,
    inverseOnSurface = inverseForeground(colors.toast),
    inversePrimary = inverseAccent(colors.accent, colors.toast),
    outline = colors.line,
    outlineVariant = colors.lineSoft,
    error = colors.danger,
    onError = colors.primaryFg,
    errorContainer = colors.dangerSoft,
    onErrorContainer = colors.danger,
    scrim = Color.Black.copy(alpha = 0.32f),
    surfaceBright = colors.bgElevated,
    surfaceDim = colors.bgSubtle,
    surfaceContainerLowest = colors.bg,
    surfaceContainerLow = colors.bgSidebar,
    surfaceContainer = colors.bgPopover,
    surfaceContainerHigh = colors.bgPopover,
    surfaceContainerHighest = colors.bgMuted,
)

private fun riffetDarkScheme(colors: RiffetColors) = darkColorScheme(
    primary = colors.accent,
    onPrimary = colors.accentFg,
    primaryContainer = colors.accentSoft,
    onPrimaryContainer = colors.fg,
    secondary = colors.accent,
    onSecondary = colors.primaryFg,
    secondaryContainer = colors.bgActive,
    onSecondaryContainer = colors.fg,
    tertiary = colors.accent,
    onTertiary = colors.primaryFg,
    background = colors.bg,
    onBackground = colors.fg,
    surface = colors.bgElevated,
    onSurface = colors.fg,
    surfaceVariant = colors.bgSubtle,
    onSurfaceVariant = colors.fg2,
    surfaceTint = colors.bgElevated,
    inverseSurface = colors.toast,
    inverseOnSurface = inverseForeground(colors.toast),
    inversePrimary = inverseAccent(colors.accent, colors.toast),
    outline = colors.line,
    outlineVariant = colors.lineSoft,
    error = colors.danger,
    onError = colors.primaryFg,
    errorContainer = colors.dangerSoft,
    onErrorContainer = colors.danger,
    scrim = Color.Black.copy(alpha = 0.5f),
    surfaceBright = colors.bgElevated,
    surfaceDim = colors.bgSubtle,
    surfaceContainerLowest = colors.bg,
    surfaceContainerLow = colors.bgSidebar,
    surfaceContainer = colors.bgPopover,
    surfaceContainerHigh = colors.bgPopover,
    surfaceContainerHighest = colors.bgMuted,
)

/** Inverse surfaces include snackbar feedback and must stay readable in every named palette. */
private fun inverseForeground(background: Color): Color {
    val luminance = background.luminance()
    return if (1.05f / (luminance + 0.05f) >= (luminance + 0.05f) / 0.05f) Color.White else Color.Black
}

private fun inverseAccent(accent: Color, background: Color): Color {
    val foreground = inverseForeground(background)
    val backgroundLuminance = background.luminance()
    for (step in 0..10) {
        val candidate = lerp(accent, foreground, step / 10f)
        val luminance = candidate.luminance()
        val contrast = (maxOf(luminance, backgroundLuminance) + 0.05f) / (minOf(luminance, backgroundLuminance) + 0.05f)
        if (contrast >= 4.5f) return candidate
    }
    return foreground
}

/**
 * The Android system-bar appearance pair. Expected rather than platform-branched so `commonMain`
 * stays free of `android.*`; the Android actual is the only file in this UI that imports it.
 */
@Composable
expect fun RiffetSystemBars(darkTheme: Boolean)

/** A role override never disables the user's system/App font scale. Families are portable aliases. */
private fun RiffetTypography.overridden(overrides: Map<String, ThemeTextStyle>): RiffetTypography {
    fun text(role: String, base: TextStyle): TextStyle {
        val token = overrides[role] ?: return base
        val size = token.size?.takeIf { it.isFinite() }?.toFloat()?.coerceIn(8f, 72f)
        val height = token.lineHeight?.takeIf { it.isFinite() }?.toFloat()?.coerceIn(8f, 100f)
            ?: size?.let { it * base.lineHeight.value / base.fontSize.value }
        return base.copy(
            fontSize = size?.sp ?: base.fontSize,
            lineHeight = height?.coerceAtLeast(size ?: base.fontSize.value)?.sp ?: base.lineHeight,
            fontWeight = token.weight?.coerceIn(100, 900)?.let(::FontWeight) ?: base.fontWeight,
            letterSpacing = token.letterSpacing?.takeIf { it.isFinite() }?.toFloat()?.coerceIn(-4f, 8f)?.sp ?: base.letterSpacing,
            fontFamily = when (token.family) {
                "system" -> FontFamily.Default
                "sans" -> FontFamily.SansSerif
                "serif" -> FontFamily.Serif
                "mono" -> FontFamily.Monospace
                else -> base.fontFamily
            },
        )
    }
    return copy(
        title = text("title", title),
        body = text("body", body),
        bodySmall = text("bodySmall", bodySmall),
        label = text("label", label),
        caption = text("caption", caption),
        mono = text("mono", mono),
        monoSmall = text("monoSmall", monoSmall),
        largeTitle = text("largeTitle", largeTitle),
        barTitle = text("barTitle", barTitle),
        headline = text("headline", headline),
        subhead = text("subhead", subhead),
        footnote = text("footnote", footnote),
        button = text("button", button),
        buttonSmall = text("buttonSmall", buttonSmall),
        input = text("input", input),
        segmented = text("segmented", segmented),
        menu = text("menu", menu),
        dialogTitle = text("dialogTitle", dialogTitle),
        dialogBody = text("dialogBody", dialogBody),
        monoFamily = text("mono", mono).fontFamily ?: monoFamily,
    )
}

private fun RiffetTypography.withAppearanceFonts(ui: FontFamily?, mono: FontFamily?): RiffetTypography {
    fun TextStyle.ui() = if (ui == null) this else copy(fontFamily = ui)
    fun TextStyle.mono() = if (mono == null) this else copy(fontFamily = mono)
    return copy(
        title = title.ui(), body = body.ui(), bodySmall = bodySmall.ui(), label = label.ui(), caption = caption.ui(),
        mono = this.mono.mono(), monoSmall = monoSmall.mono(), monoFamily = mono ?: monoFamily,
        largeTitle = largeTitle.ui(), barTitle = barTitle.ui(), headline = headline.ui(), subhead = subhead.ui(),
        footnote = footnote.ui(), button = button.ui(), buttonSmall = buttonSmall.ui(), input = input.ui(),
        segmented = segmented.ui(), menu = menu.ui(), dialogTitle = dialogTitle.ui(), dialogBody = dialogBody.ui(),
    )
}

private fun Typography.withAppearanceFont(font: FontFamily?): Typography {
    if (font == null) return this
    fun TextStyle.font() = copy(fontFamily = font)
    return copy(
        displayLarge = displayLarge.font(), displayMedium = displayMedium.font(), displaySmall = displaySmall.font(),
        headlineLarge = headlineLarge.font(), headlineMedium = headlineMedium.font(), headlineSmall = headlineSmall.font(),
        titleLarge = titleLarge.font(), titleMedium = titleMedium.font(), titleSmall = titleSmall.font(),
        bodyLarge = bodyLarge.font(), bodyMedium = bodyMedium.font(), bodySmall = bodySmall.font(),
        labelLarge = labelLarge.font(), labelMedium = labelMedium.font(), labelSmall = labelSmall.font(),
    )
}
