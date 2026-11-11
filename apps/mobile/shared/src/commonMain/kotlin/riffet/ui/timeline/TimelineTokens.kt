package riffet.ui.timeline

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import riffet.shared.DisplaySettings
import riffet.theme.RiffetColors
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.RiffetTypography
import riffet.ui.design.DesignMetrics
import riffet.ui.design.LocalInterfaceStyle

/*
 * The transcript's view of the shared design system.
 *
 * Colours, typography and dimensions come from the active Riffet theme and interface style.
 * Theme design overrides are already resolved before these composition locals are published;
 * transcript renderers use the same resolved roles as the surrounding app.
 */

/**
 * Read-only handles on the theme, in the shape `MaterialTheme` uses. `@ReadOnlyComposable` is what
 * lets these be read from any composable without invalidating more than the local itself.
 */
internal object TimelineTheme {
    val colors: RiffetColors
        @Composable @ReadOnlyComposable get() = LocalRiffetColors.current

    val type: RiffetTypography
        @Composable @ReadOnlyComposable get() = LocalRiffetTypography.current

    /** The answer's reading scale at the reader's text size. */
    val prose: ProseScale
        @Composable @ReadOnlyComposable get() = ProseScale(LocalDensity.current.fontScale, LocalRiffetTypography.current, LocalInterfaceStyle.current.metrics)
}

/**
 * The answer's reading surface uses the current theme's text roles and layout dimensions.
 * Lines keep their half-leading above and below (Trim.None), preserving the theme's line height.
 * Text follows the reader's font scale; gaps use the same scale to preserve reading proportions.
 */
@Immutable
internal data class ProseScale(val fontScale: Float, val typography: RiffetTypography, val metrics: DesignMetrics) {
    val monoFamily: FontFamily get() = typography.monoFamily
    private fun gap(value: Dp): Dp = value * fontScale

    /** Reading styles share the active theme, including explicit leading and font overrides. */
    val body: TextStyle = typography.body.copy(lineHeightStyle = ProseLineHeight)
    val h1: TextStyle = typography.title.copy(lineHeightStyle = ProseLineHeight)
    val h2: TextStyle = typography.headline.copy(lineHeightStyle = ProseLineHeight)
    val h3: TextStyle = typography.subhead.copy(lineHeightStyle = ProseLineHeight)
    val h4: TextStyle = typography.subhead.copy(lineHeightStyle = ProseLineHeight)
    val code: TextStyle = typography.code.copy(lineHeightStyle = ProseLineHeight)
    val table: TextStyle = typography.bodySmall.copy(lineHeightStyle = ProseLineHeight)

    /** Between two top-level blocks (`.md p { margin-bottom }`), and the plain renderer's paragraphs. */
    val paragraph: Dp = gap(metrics.rowPadding)
    /** Around each item of a tight list; two of them separate neighbouring items. */
    val item: Dp = gap(metrics.controlInset / 4)
    /** Between the blocks inside one item (`.md li > p + p`). */
    val itemBlock: Dp = gap(metrics.rowPadding * 0.625f)
    val nestedList: Dp = gap(metrics.controlInset / 4)
    /** The item text column (`.md ul, .md ol { padding-left }`); a wider number widens it. */
    val listIndent: Dp = gap(metrics.controlInset * 1.8333334f)
    /** Marker to text, for a number wider than the indent leaves room for. */
    val markerGap: Dp = gap(metrics.controlInset / 2)
    val headingTop: Dp = gap(metrics.sectionGap)
    val headingBottom: Dp = gap(metrics.controlInset * (2f / 3f))
    val quoteInset: Dp = gap(metrics.pageInset)
    val rule: Dp = gap(metrics.sectionGap)
    val tableGap: Dp = gap(metrics.rowPadding)
    val tableCellVertical: Dp = gap(metrics.rowPadding / 2)
    val tableCellHorizontal: Dp = gap(metrics.controlInset)
}

private val ProseLineHeight = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)

/**
 * The monospace family is part of the published contract, so code that has to be monospaced
 * restates it on top of `mono` / `monoSmall`. That is a no-op when those styles already carry it,
 * and the fix when they do not — either way a diff or a shell command can never quietly render in
 * the sans stack.
 */
internal val RiffetTypography.code: TextStyle get() = mono.copy(fontFamily = monoFamily)

internal val RiffetTypography.codeSmall: TextStyle get() = monoSmall.copy(fontFamily = monoFamily)

/** A process row's title (tool, process header, notification): regular weight, ranked by colour. */
internal val RiffetTypography.rowLabel: TextStyle get() = label

/**
 * The transcript's vertical rhythm distinguishes consecutive compact tools from reading blocks.
 * Disclosure rows use a compact visual height; consecutive compact rows need no extra gap.
 * DisplaySettings spacing scales reading gaps without changing row height.
 *
 * Rows do not add their own gaps on top of these; the container owns the whole rhythm, which is
 * why there are exactly two numbers and no per-row margin anywhere in this package.
 */
internal object TimelineRhythm {
    /** The reader's 会话间距 (settings → 外观); the touch target does not move with it. */
    val scale: Float get() = DisplaySettings.active.spacing.scale

    /** Two consecutive one-line rows (a tool call, folded raw thinking): none, their touch target already spaces them. */
    val compact: Dp get() = 0.dp

    /** Layout baseline for reading rows. Timeline scales entry.gap by the theme's rowPadding;
     * keep this baseline here so spacing is applied once, at the shared renderer. */
    val row: Dp get() = 16.dp * scale

    /** The transcript's own gutter, so a bubble can never touch the screen edge. */
    val gutter: Dp
        @Composable @ReadOnlyComposable get() = LocalInterfaceStyle.current.metrics.pageInset * scale

    /** Indent for genuinely nested detail (a tool row's own payload) and its hairline rule. */
    val nesting: Dp
        @Composable @ReadOnlyComposable get() = LocalInterfaceStyle.current.metrics.controlInset * scale

    /** The minimum touch target used by actions inside a disclosure. */
    val touchTarget: Dp
        @Composable @ReadOnlyComposable get() = LocalInterfaceStyle.current.metrics.controlHeight

    /** Compact transcript disclosures keep a readable row independent of larger form controls. */
    val toolRowHeight: Dp
        @Composable @ReadOnlyComposable get() = (LocalInterfaceStyle.current.metrics.controlHeight * 3 / 4).coerceAtLeast(36.dp)

    /** Minimum gap between blocks inside one row. */
    val block: Dp
        @Composable @ReadOnlyComposable get() = LocalInterfaceStyle.current.metrics.controlInset / 2 * scale
}
