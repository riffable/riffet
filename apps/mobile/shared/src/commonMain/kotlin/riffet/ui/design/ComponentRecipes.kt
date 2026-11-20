package riffet.ui.design

import androidx.compose.runtime.Immutable

/** Implementation choice at a component boundary, never an interface-style identity. */
internal enum class ComponentBackend { MATERIAL, MIUIX, SHARED }
internal enum class SegmentPresentation { CONNECTED, SLIDING, PILLS, UNDERLINE }
internal enum class InlinePresentation { TONAL, NEUTRAL, OUTLINED, TRANSPARENT }
internal enum class NavigationIndicator { FILL, TOP_LINE, BOTTOM_DOT }
internal enum class CardPresentation { TONAL, ELEVATED, WHITE_BLEND }

@Immutable
internal data class ControlRecipe(
    val buttons: ComponentBackend = ComponentBackend.MATERIAL,
    val switches: ComponentBackend = ComponentBackend.MATERIAL,
    val choices: ComponentBackend = ComponentBackend.MATERIAL,
    val chips: ComponentBackend = ComponentBackend.MATERIAL,
    val segments: SegmentPresentation = SegmentPresentation.CONNECTED,
    val outlinedSecondary: Boolean = false,
    val plainSecondary: Boolean = false,
    val outlineSwitchThumb: Boolean = false,
    val segmentShadow: Boolean = false,
    val segmentCard: Boolean = false,
    val inline: InlinePresentation = InlinePresentation.TONAL,
    val inlineControlRadius: Boolean = false,
    val filledDialogActions: Boolean = false,
    /** A row of filter chips at rest is bare labels; only the chosen one is filled. Otherwise every chip is filled and the chosen one is darker. */
    val bareChips: Boolean = false,
)

@Immutable
internal data class InputRecipe(
    val fields: ComponentBackend = ComponentBackend.MATERIAL,
    val sliders: ComponentBackend = ComponentBackend.MATERIAL,
    val underline: Boolean = false,
    val accentThumb: Boolean = false,
)

@Immutable
internal data class ListRecipe(
    val dividers: Boolean = false,
    val roundedSelection: Boolean = true,
    val trailingMenuIcons: Boolean = false,
    val outlinedMenu: Boolean = false,
    val grouped: Boolean = false,
    val accentSections: Boolean = true,
    val sectionBackground: Boolean = false,
    val focusBorder: Boolean = false,
    val selectionMarker: Boolean = false,
    val compactChevron: Boolean = false,
    val valueBelowLabel: Boolean = true,
    val groupSeparatorLine: Boolean = true,
    val selectionAtEnd: Boolean = false,
    /**
     * Object rows (a conversation) lead with the agent's bare mark and keep to one line: the state
     * (running, waiting on you, unread) sits at the row's end in place of the time. Otherwise the mark
     * sits on a tinted disc that carries the state, above a detail line.
     */
    val plainObjectMarks: Boolean = false,
    /** Rows that change place (a folded group, a new filter) travel there on the spatial spring instead of jumping. */
    val movingRows: Boolean = false,
    /** Menu rows carry no line between them even where grouped rows do; a menu's groups are set apart by its separators. */
    val plainMenuRows: Boolean = false,
)

@Immutable
internal data class NavigationRecipe(
    val topBar: ComponentBackend = ComponentBackend.MATERIAL,
    val largeTitle: ComponentBackend = ComponentBackend.MATERIAL,
    val rail: ComponentBackend = ComponentBackend.MATERIAL,
    val tabs: ComponentBackend = ComponentBackend.MATERIAL,
    val badges: ComponentBackend = ComponentBackend.MATERIAL,
    val backChevron: Boolean = false,
    val centeredTitle: Boolean = false,
    val divider: Boolean = false,
    val capsulePanel: Boolean = false,
    val capsuleIndicator: Boolean = false,
    val indicator: NavigationIndicator = NavigationIndicator.FILL,
    val accentSelection: Boolean = false,
    val cardSurface: Boolean = false,
    val indicatorHeightExtra: Float = 0f,
)

@Immutable
internal data class SheetRecipe(
    val actionSheet: Boolean = false,
    val insetFloating: Boolean = false,
    val border: Boolean = false,
    val tonalSurface: Boolean = true,
    val prominentTitle: Boolean = false,
    val centeredTitle: Boolean = false,
    val maxHeightFraction: Float = 0.7f,
    val parameterHeightFraction: Float = 0.4f,
    val nativeDragHandle: Boolean = true,
    /**
     * A grabber above the header. Without one the header is a bar of its own height and the title sits
     * midway between the panel's edge and the list; the close button and a swipe down still dismiss.
     */
    val dragHandle: Boolean = true,
    /** A grouped style's rows sit on the panel bare: the panel is the card, so a fill per row would band it. */
    val flatRows: Boolean = false,
    val maxHeightDp: Int = 640,
)

@Immutable
internal data class MenuRecipe(
    val maxHeightFraction: Float = 0.7f,
    val maxHeightDp: Int = 640,
)

@Immutable
internal data class DialogRecipe(
    val backend: ComponentBackend = ComponentBackend.MATERIAL,
    val stackedActions: Boolean = false,
    val centeredContent: Boolean = false,
    val border: Boolean = false,
)

@Immutable
internal data class ComposerRecipe(
    val tonal: Boolean = true,
    val settingsSurface: Boolean = true,
    val rectangularAction: Boolean = false,
)

@Immutable
internal data class SurfaceRecipe(
    val pageMix: Float = 0f,
    val card: CardPresentation = CardPresentation.TONAL,
    val selectionLightMix: Float = 0.13f,
    val pressAlpha: Float = 0.08f,
    val transparentInput: Boolean = true,
    val navigationAlpha: Float = 1f,
    val scrimAlpha: Float = 0.32f,
    val tonalSecondary: Boolean = true,
    val accentThumb: Boolean = true,
    /** The selected fill is a neutral step of ink over the card; the accent is left to focus, selection and links. */
    val neutralSelection: Boolean = false,
    /** Lines (the dividers in a card, a menu's rim) take the palette's soft line: tone separates surfaces, lines only rows. */
    val softLines: Boolean = false,
    /** The primary action is the palette's ink (`primary`), not its accent. */
    val inkPrimary: Boolean = false,
)

/** Independent recipes let new presets reuse components without inheriting unrelated behavior. */
@Immutable
internal data class ComponentRecipes(
    val controls: ControlRecipe = ControlRecipe(),
    val inputs: InputRecipe = InputRecipe(),
    val lists: ListRecipe = ListRecipe(),
    val navigation: NavigationRecipe = NavigationRecipe(),
    val sheets: SheetRecipe = SheetRecipe(),
    val menus: MenuRecipe = MenuRecipe(),
    val dialogs: DialogRecipe = DialogRecipe(),
    val composer: ComposerRecipe = ComposerRecipe(),
    val surfaces: SurfaceRecipe = SurfaceRecipe(),
    val progress: ComponentBackend = ComponentBackend.MATERIAL,
    val ripple: Boolean = true,
    val nativeFeedback: Boolean = false,
)
