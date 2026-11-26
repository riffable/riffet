package riffet.ui.design

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.material3.Typography
import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import riffet.shared.InterfaceStyle
import riffet.ui.theme.RiffetDefaultTypography
import riffet.ui.theme.RiffetTypography

/** The only style identity dispatch. Components consume independent recipes. */
@Immutable
internal data class ThemePreset(
    val dimensions: Map<String, Double>,
    val variants: DesignVariants,
    val components: ComponentRecipes,
    val typography: TypographyDefaults,
    val motion: Map<String, Double>,
    val motionEasing: CubicBezierEasing,
    val mutedNativeContainer: Boolean = true,
)

@Immutable
internal data class TypographyDefaults(
    val native: Typography,
    val shared: RiffetTypography,
    val mapSharedAliases: Boolean = false,
)

private fun typographyDefaults(
    native: Typography,
    subhead: TextStyle = native.titleSmall,
    footnote: TextStyle = native.bodySmall,
    buttonSize: TextUnit = 14.sp,
    dialogTitle: TextStyle = native.headlineSmall,
    dialogBody: TextStyle = native.bodyMedium,
    /** Material's menu items are 14sp; a style may keep body size. */
    menu: TextStyle = native.bodyMedium,
    mapSharedAliases: Boolean = false,
) = TypographyDefaults(native, RiffetDefaultTypography.copy(
    title = native.titleLarge, barTitle = native.titleLarge, largeTitle = native.headlineLarge,
    body = native.bodyLarge, bodySmall = native.bodyMedium, subhead = subhead,
    caption = native.bodySmall, label = native.labelLarge, headline = native.titleMedium,
    footnote = footnote, button = native.labelLarge.copy(fontSize = buttonSize),
    buttonSmall = native.labelLarge.copy(fontSize = buttonSize), input = native.bodyLarge,
    segmented = native.labelLarge.copy(fontSize = buttonSize), menu = menu,
    dialogTitle = dialogTitle, dialogBody = dialogBody,
), mapSharedAliases)

// Keep the platform's font and user font scale; avoid Latin tracking opening up Chinese labels.
internal val MaterialStyleTypography = Typography().run {
    copy(
        headlineLarge = headlineLarge.copy(letterSpacing = 0.sp, fontWeight = FontWeight.Medium),
        titleLarge = titleLarge.copy(letterSpacing = 0.sp, fontWeight = FontWeight.Medium),
        bodyLarge = bodyLarge.copy(letterSpacing = 0.sp),
        bodyMedium = bodyMedium.copy(letterSpacing = 0.sp),
        bodySmall = bodySmall.copy(letterSpacing = 0.sp),
        labelLarge = labelLarge.copy(letterSpacing = 0.sp),
    )
}

private val MaterialPreset = ThemePreset(
    dimensions = emptyMap(), variants = DesignVariants(SettingsIconPresentation.PLAIN, NavigationPresentation.FLAT, HomeTabPresentation.UNDERLINE, SecondaryButtonPresentation.TONAL),
    components = ComponentRecipes(), typography = typographyDefaults(MaterialStyleTypography),
    motion = DefaultMotionTokens, motionEasing = StandardMotionEasing,
)
// The app's own style: the shared components throughout, the theme's colour in three tiers (riffet-style.md §4),
// white plain pages and grey grouped ones, and rows in regular weight so a title or an unread row stands out.
private val RiffetStyleTypography = MaterialStyleTypography.copy(
    headlineLarge = MaterialStyleTypography.headlineLarge.copy(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Medium),
    headlineSmall = MaterialStyleTypography.headlineSmall.copy(fontSize = 18.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium),
    titleLarge = MaterialStyleTypography.titleLarge.copy(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium),
    titleMedium = MaterialStyleTypography.titleMedium.copy(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Normal, letterSpacing = 0.sp),
    titleSmall = MaterialStyleTypography.titleSmall.copy(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Normal, letterSpacing = 0.sp),
    labelLarge = MaterialStyleTypography.labelLarge.copy(fontSize = 15.sp, lineHeight = 20.sp),
)
private val RiffetPreset = ThemePreset(
    dimensions = RiffetDimensions,
    variants = DesignVariants(SettingsIconPresentation.PLAIN, NavigationPresentation.FLOATING, HomeTabPresentation.UNDERLINE, SecondaryButtonPresentation.PLAIN),
    components = ComponentRecipes(
        controls = ControlRecipe(buttons = ComponentBackend.SHARED, switches = ComponentBackend.SHARED,
            choices = ComponentBackend.SHARED, chips = ComponentBackend.SHARED,
            segments = SegmentPresentation.SLIDING, segmentShadow = true, inline = InlinePresentation.TRANSPARENT, bareChips = true,
            filledDialogActions = true),
        inputs = InputRecipe(fields = ComponentBackend.SHARED, sliders = ComponentBackend.SHARED),
        lists = ListRecipe(dividers = true, roundedSelection = true, movingRows = true, plainMenuRows = true,
            trailingMenuIcons = true, outlinedMenu = true, grouped = true, accentSections = false,
            sectionBackground = false, focusBorder = true, compactChevron = true,
            valueBelowLabel = false, groupSeparatorLine = false, selectionAtEnd = true, plainObjectMarks = true),
        navigation = NavigationRecipe(topBar = ComponentBackend.SHARED, largeTitle = ComponentBackend.SHARED,
            capsulePanel = true, capsuleIndicator = true, pageBarLine = false, accentSelection = true,
            rail = ComponentBackend.SHARED, tabs = ComponentBackend.SHARED, badges = ComponentBackend.SHARED),
        sheets = SheetRecipe(insetFloating = true, nativeDragHandle = false, dragHandle = false, flatRows = true, headerLine = false),
        dialogs = DialogRecipe(backend = ComponentBackend.SHARED),
        composer = ComposerRecipe(tonal = false, settingsSurface = false),
        // Plain pages are the palette's paper and a card on them is a quiet step of ink; grouped pages are a step
        // darker so their raised cards read; floating chrome is the raised paper. Tone separates surfaces, so nothing
        // is outlined and the only lines left are the soft ones between a card's rows.
        surfaces = SurfaceRecipe(groupedPageMix = 0.03f, card = CardPresentation.STEPPED,
            pressAlpha = 0.06f, transparentInput = false,
            navigationAlpha = 0.96f, scrimAlpha = 0.28f, tonalSecondary = false, accentThumb = false,
            softLines = true, neutralFills = true),
        ripple = false,
    ),
    typography = typographyDefaults(RiffetStyleTypography, subhead = RiffetStyleTypography.titleSmall,
        footnote = RiffetStyleTypography.titleSmall, buttonSize = 15.sp,
        dialogTitle = RiffetStyleTypography.headlineSmall, menu = RiffetStyleTypography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 20.sp)),
    motion = RiffetMotionTokens, motionEasing = StandardMotionEasing, mutedNativeContainer = false,
)
internal fun themePreset(style: InterfaceStyle): ThemePreset = when (style) {
    InterfaceStyle.RIFFET -> RiffetPreset
    InterfaceStyle.MATERIAL3 -> MaterialPreset
}
