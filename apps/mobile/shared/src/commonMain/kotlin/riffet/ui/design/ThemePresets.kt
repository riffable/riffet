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
    /** Material's menu items are 14sp; Cupertino and HyperOS keep body size. */
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

internal val DefaultMotionTokens = mapOf(
    "pageEnter" to 300.0, "pageExit" to 200.0, "coveredPageShift" to 0.08,
    "coveredPageDim" to 0.16, "pressOpacity" to 0.8, "disabledOpacity" to 0.38,
    "floatingShadowOpacity" to 0.12, "popScale" to 0.8, "sharedAxisFraction" to (1.0 / 6.0),
    "short" to 150.0, "medium" to 250.0, "long" to 350.0, "exit" to 220.0,
    "settleDamping" to 1.0, "settleStiffness" to 550.0,
    "spatialDamping" to 0.9, "spatialStiffness" to 700.0, "effectsStiffness" to 1600.0,
)
private val SharedMotionTokens = DefaultMotionTokens + mapOf(
    "pageEnter" to 350.0, "pageExit" to 250.0, "coveredPageShift" to 0.25,
    "coveredPageDim" to 0.12, "pressOpacity" to 0.55, "popScale" to 0.94,
    "sharedAxisFraction" to 0.25, "short" to 180.0, "medium" to 280.0, "exit" to 250.0,
    "settleStiffness" to 450.0, "spatialDamping" to 0.86, "spatialStiffness" to 550.0,
)
private val StandardMotionEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
private val SharedMotionEasing = CubicBezierEasing(0.25f, 0.1f, 0.25f, 1f)

internal val BaseDesignDimensions = mapOf(
    "pageInset" to 16.0,
    "groupInset" to 16.0,
    "sectionGap" to 20.0,
    "rowPadding" to 16.0,
    "rowHeight" to 52.0,
    "rowSubtitleHeight" to 64.0,
    "iconSize" to 24.0,
    "smallIconSize" to 18.0,
    "iconSlot" to 30.0,
    "iconTileRadius" to 8.0,
    "controlHeight" to 48.0,
    "controlInset" to 12.0,
    "groupRadius" to 20.0,
    "menuRadius" to 12.0,
    "controlRadius" to 12.0,
    "rowRadius" to 12.0,
    "selectionRadius" to 8.0,
    "composerRadius" to 20.0,
    "barHeight" to 64.0,
    "tabBarHeight" to 64.0,
    "tabBarInset" to 0.0,
    "tabBarBottomInset" to 0.0,
    "drawerWidth" to 304.0,
    "drawerMinGap" to 56.0,
    "menuMinWidth" to 200.0,
    "menuMaxWidth" to 360.0,
    "menuRowHeight" to 48.0,
    "menuGroupGap" to 8.0,
    "hairlineWidth" to 1.0,
    "focusWidth" to 2.0,
    "alertWidth" to 280.0,
    "sheetMaxWidth" to 560.0,
    "dialogInset" to 24.0,
    "inputMinHeight" to 48.0,
    "inputInset" to 12.0,
    "segmentedHeight" to 40.0,
    "switchWidth" to 50.0,
    "switchHeight" to 30.0,
    "switchThumbSize" to 26.0,
    "sliderTrackHeight" to 16.0,
    "sliderThumbSize" to 28.0,
    "sendButtonSize" to 40.0,
    "composerMinHeight" to 96.0,
    "composerMaxHeight" to 240.0,
    "floatingShadowRadius" to 6.0,
    "floatingShadowLiftedRadius" to 12.0,
    "floatingShadowOffset" to 2.0,
    "floatingShadowSpread" to 0.0,
    "buttonIconSize" to 20.0,
    "contentMaxWidth" to 840.0,
    "pageTitleGap" to 16.0
)
// Keep the platform's font and user font scale; avoid Latin tracking opening up Chinese labels.
private val MaterialStyleTypography = Typography().run {
    copy(
        headlineLarge = headlineLarge.copy(letterSpacing = 0.sp, fontWeight = FontWeight.Medium),
        titleLarge = titleLarge.copy(letterSpacing = 0.sp, fontWeight = FontWeight.Medium),
        bodyLarge = bodyLarge.copy(letterSpacing = 0.sp),
        bodyMedium = bodyMedium.copy(letterSpacing = 0.sp),
        bodySmall = bodySmall.copy(letterSpacing = 0.sp),
        labelLarge = labelLarge.copy(letterSpacing = 0.sp),
    )
}
private val IosStyleTypography = MaterialStyleTypography.copy(
    headlineLarge = TextStyle(fontSize = 34.sp, lineHeight = 41.sp, fontWeight = FontWeight.Bold),
    titleLarge = TextStyle(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
)


private val IosDimensions = mapOf(
    "iconSize" to 22.0, "sliderTrackHeight" to 4.0,
    "groupRadius" to 12.0, "menuRadius" to 10.0, "controlRadius" to 10.0,
    "rowRadius" to 8.0, "selectionRadius" to 6.0, "composerRadius" to 14.0,
    "barHeight" to 56.0, "tabBarHeight" to 58.0, "tabBarInset" to 18.0,
    "tabBarBottomInset" to 8.0, "alertWidth" to 270.0, "dialogInset" to 16.0,
    "segmentedHeight" to 34.0, "sendButtonSize" to 36.0, "menuGroupGap" to 6.0,
    "floatingShadowRadius" to 14.0, "floatingShadowLiftedRadius" to 22.0,
    "floatingShadowOffset" to 4.0, "floatingShadowSpread" to -3.0,
)
private val ExpressiveDimensions = mapOf(
    "groupRadius" to 28.0, "composerRadius" to 28.0, "controlRadius" to 24.0,
    "selectionRadius" to 16.0, "rowRadius" to 16.0, "menuRadius" to 20.0,
    "segmentedHeight" to 44.0, "tabBarInset" to 16.0, "tabBarBottomInset" to 8.0,
)
private val MiuixDimensions = mapOf(
    "groupRadius" to 20.0, "composerRadius" to 20.0, "controlRadius" to 16.0,
    "selectionRadius" to 12.0,
    "sendButtonSize" to 36.0,
    "menuRadius" to 20.0, "rowHeight" to 56.0, "rowSubtitleHeight" to 72.0,
    "sectionGap" to 24.0, "barHeight" to 60.0, "tabBarInset" to 20.0,
    "tabBarBottomInset" to 8.0, "sliderTrackHeight" to 8.0, "alertWidth" to 320.0,
)
private val FluentDimensions = mapOf(
    "groupRadius" to 8.0, "composerRadius" to 12.0, "controlRadius" to 4.0,
    "menuRadius" to 8.0, "rowRadius" to 4.0, "selectionRadius" to 4.0,
    "barHeight" to 56.0, "tabBarHeight" to 56.0, "sliderTrackHeight" to 4.0,
    "switchWidth" to 44.0, "switchHeight" to 24.0, "switchThumbSize" to 18.0,
    "sliderThumbSize" to 18.0,
    "sendButtonSize" to 32.0,
)

private val MaterialPreset = ThemePreset(
    dimensions = emptyMap(), variants = DesignVariants(SettingsIconPresentation.PLAIN, NavigationPresentation.FLAT, HomeTabPresentation.UNDERLINE, SecondaryButtonPresentation.TONAL),
    components = ComponentRecipes(), typography = typographyDefaults(MaterialStyleTypography),
    motion = DefaultMotionTokens, motionEasing = StandardMotionEasing,
)
private val IosPreset = ThemePreset(
    dimensions = IosDimensions,
    variants = DesignVariants(SettingsIconPresentation.PLAIN, NavigationPresentation.FLOATING, HomeTabPresentation.SEGMENTED, SecondaryButtonPresentation.PLAIN),
    components = ComponentRecipes(
        controls = ControlRecipe(buttons = ComponentBackend.SHARED, switches = ComponentBackend.SHARED,
            choices = ComponentBackend.SHARED, chips = ComponentBackend.SHARED,
            segments = SegmentPresentation.SLIDING, segmentShadow = true, inline = InlinePresentation.TRANSPARENT),
        inputs = InputRecipe(fields = ComponentBackend.SHARED, sliders = ComponentBackend.SHARED),
        lists = ListRecipe(selectionFill = false, dividers = true, roundedSelection = false,
            trailingMenuIcons = true, outlinedMenu = true, grouped = true, accentSections = false,
            sectionBackground = true, focusBorder = true, compactChevron = true,
            valueBelowLabel = false, groupSeparatorLine = false, selectionAtEnd = true),
        navigation = NavigationRecipe(topBar = ComponentBackend.SHARED, largeTitle = ComponentBackend.SHARED,
            centeredTitle = true, capsulePanel = true, capsuleIndicator = true, accentSelection = true,
            rail = ComponentBackend.SHARED, tabs = ComponentBackend.SHARED, badges = ComponentBackend.SHARED, backChevron = true),
        sheets = SheetRecipe(actionSheet = true, insetFloating = true, border = true,
            tonalSurface = false, centeredTitle = true, nativeDragHandle = false),
        dialogs = DialogRecipe(backend = ComponentBackend.SHARED, stackedActions = true, centeredContent = true),
        composer = ComposerRecipe(tonal = false, settingsSurface = false),
        surfaces = SurfaceRecipe(card = CardPresentation.WHITE_BLEND,
            selectionLightMix = 0.09f, pressAlpha = 0.055f, transparentInput = false,
            navigationAlpha = 0.94f, scrimAlpha = 0.25f, tonalSecondary = false, accentThumb = false),
        progress = ComponentBackend.SHARED, ripple = false,
    ),
    typography = typographyDefaults(IosStyleTypography, subhead = IosStyleTypography.bodyMedium, menu = IosStyleTypography.bodyLarge,
        footnote = IosStyleTypography.labelLarge, buttonSize = 15.sp,
        dialogTitle = IosStyleTypography.titleLarge, dialogBody = IosStyleTypography.bodySmall,
        mapSharedAliases = true),
    motion = SharedMotionTokens, motionEasing = SharedMotionEasing, mutedNativeContainer = false,
)
private val ExpressivePreset = MaterialPreset.copy(
    dimensions = ExpressiveDimensions,
    variants = DesignVariants(SettingsIconPresentation.PLAIN, NavigationPresentation.FLOATING, HomeTabPresentation.SEGMENTED, SecondaryButtonPresentation.TONAL),
    components = MaterialPreset.components.copy(
        controls = MaterialPreset.components.controls.copy(segments = SegmentPresentation.PILLS, inlineControlRadius = true),
        navigation = NavigationRecipe(capsuleIndicator = true, indicatorHeightExtra = 1f / 3f),
        sheets = SheetRecipe(prominentTitle = true),
    ),
    typography = typographyDefaults(MaterialStyleTypography.copy(
        headlineLarge = MaterialStyleTypography.headlineLarge.copy(fontWeight = FontWeight.Bold),
        titleLarge = MaterialStyleTypography.titleLarge.copy(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold),
    )),
    motion = DefaultMotionTokens + mapOf("spatialDamping" to 0.7, "spatialStiffness" to 500.0),
)
private val MiuixPreset = ThemePreset(
    dimensions = MiuixDimensions,
    variants = DesignVariants(SettingsIconPresentation.PLAIN, NavigationPresentation.FLAT, HomeTabPresentation.SEGMENTED, SecondaryButtonPresentation.TONAL),
    components = ComponentRecipes(
        controls = ControlRecipe(buttons = ComponentBackend.MIUIX, switches = ComponentBackend.MIUIX,
            choices = ComponentBackend.MIUIX, chips = ComponentBackend.SHARED,
            segments = SegmentPresentation.SLIDING, plainSecondary = true, segmentCard = true,
            inline = InlinePresentation.NEUTRAL, filledDialogActions = true),
        inputs = InputRecipe(fields = ComponentBackend.MIUIX, sliders = ComponentBackend.MIUIX),
        lists = ListRecipe(grouped = true, accentSections = false, focusBorder = true,
            compactChevron = true, valueBelowLabel = false, groupSeparatorLine = false, selectionAtEnd = true),
        navigation = NavigationRecipe(largeTitle = ComponentBackend.SHARED,
            indicator = NavigationIndicator.BOTTOM_DOT, accentSelection = true, cardSurface = true,
            rail = ComponentBackend.SHARED, tabs = ComponentBackend.SHARED, badges = ComponentBackend.SHARED, backChevron = true),
        sheets = SheetRecipe(border = true, tonalSurface = false, prominentTitle = true, nativeDragHandle = false),
        dialogs = DialogRecipe(backend = ComponentBackend.SHARED, centeredContent = true),
        composer = ComposerRecipe(tonal = false),
        surfaces = SurfaceRecipe(pageMix = 0.025f, card = CardPresentation.ELEVATED,
            selectionLightMix = 0.09f, pressAlpha = 0.055f, transparentInput = false,
            navigationAlpha = 0.94f, scrimAlpha = 0.25f, tonalSecondary = false, accentThumb = false),
        progress = ComponentBackend.SHARED, ripple = false, nativeFeedback = true,
    ),
    typography = typographyDefaults(MaterialStyleTypography.copy(
        headlineLarge = MaterialStyleTypography.headlineLarge.copy(fontSize = 32.sp, fontWeight = FontWeight.Bold),
        headlineSmall = MaterialStyleTypography.headlineSmall.copy(fontSize = 20.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
        titleLarge = MaterialStyleTypography.titleLarge.copy(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
    ), menu = MaterialStyleTypography.bodyLarge),
    motion = SharedMotionTokens, motionEasing = SharedMotionEasing, mutedNativeContainer = false,
)
private val FluentPreset = MaterialPreset.copy(
    dimensions = FluentDimensions,
    components = MaterialPreset.components.copy(
        controls = ControlRecipe(switches = ComponentBackend.SHARED, segments = SegmentPresentation.UNDERLINE,
            outlinedSecondary = true, plainSecondary = true, outlineSwitchThumb = true, inline = InlinePresentation.OUTLINED),
        inputs = InputRecipe(fields = ComponentBackend.SHARED, sliders = ComponentBackend.SHARED, underline = true, accentThumb = true),
        lists = ListRecipe(dividers = true, outlinedMenu = true, accentSections = false, selectionMarker = true),
        navigation = NavigationRecipe(divider = true, indicator = NavigationIndicator.TOP_LINE, accentSelection = true),
        dialogs = DialogRecipe(backend = ComponentBackend.SHARED, border = true),
        composer = ComposerRecipe(rectangularAction = true),
        surfaces = SurfaceRecipe(transparentInput = false),
        ripple = false,
    ),
    typography = typographyDefaults(MaterialStyleTypography.copy(
        headlineLarge = MaterialStyleTypography.headlineLarge.copy(fontSize = 28.sp, fontWeight = FontWeight.SemiBold),
        headlineSmall = MaterialStyleTypography.headlineSmall.copy(fontSize = 20.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
        titleLarge = MaterialStyleTypography.titleLarge.copy(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
    )),
)

internal fun themePreset(style: InterfaceStyle): ThemePreset = when (style) {
    InterfaceStyle.MATERIAL3 -> MaterialPreset
    InterfaceStyle.IOS -> IosPreset
    InterfaceStyle.EXPRESSIVE -> ExpressivePreset
    InterfaceStyle.MIUIX -> MiuixPreset
    InterfaceStyle.FLUENT -> FluentPreset
}
