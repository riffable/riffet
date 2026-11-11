package riffet.ui.app

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Constraints
import riffet.ui.design.MaterialRole
import riffet.ui.design.RiffetMaterialContent
import riffet.ui.design.RiffetMaterialRecordedContent
import riffet.ui.design.RiffetMaterialWindow
import riffet.ui.design.rememberMaterialCapture
import riffet.ui.design.riffetMaterial
import riffet.ui.design.riffetMaterialSource
import riffet.ui.theme.appearancePageBackground

internal val LocalPageChromeInsets = staticCompositionLocalOf { PaddingValues() }

/** Fixed chrome and its recorded body are siblings: chrome never records itself. */
@Composable
internal fun RiffetPageScaffold(
    modifier: Modifier = Modifier,
    extendSystemBars: Boolean = true,
    floatingBottomBar: Boolean = false,
    /** Hold the body back during the page's slide (see [PageBody]). Off for a body that defers its own parts. */
    deferBody: Boolean = true,
    topBar: @Composable () -> Unit,
    bottomBar: (@Composable () -> Unit)? = null,
    /** Floating controls above the body. Outside the recorded body, their material samples it as chrome does. */
    overlay: (@Composable BoxScope.(PaddingValues) -> Unit)? = null,
    content: @Composable (PaddingValues) -> Unit,
) {
    val density = LocalDensity.current
    val bars = if (extendSystemBars) systemBarsPadding() else PaddingValues()
    val topInset = if (extendSystemBars) WindowInsets.statusBars.getTop(density) else 0
    val bottomInset = if (extendSystemBars) WindowInsets.navigationBars.getBottom(density) else 0
    // Placement never depends on the material: SOLID only swaps the blur for a plain fill.
    val topSurface = Modifier.extendChromeInset(topInset, above = true)
        .riffetMaterial(MaterialRole.TOP_BAR, RectangleShape, pageColor()).padding(top = bars.calculateTopPadding())
    val bottomSurface = Modifier.extendChromeInset(bottomInset, above = false)
        .then(if (floatingBottomBar) Modifier else Modifier.riffetMaterial(MaterialRole.BOTTOM_BAR, RectangleShape, pageColor()))
        .padding(bottom = bars.calculateBottomPadding())
    val active = LocalPageActive.current
    val capture = rememberMaterialCapture()
    val bodyModifier = Modifier.fillMaxSize()
        .then(if (extendSystemBars) Modifier.coverSystemBars() else Modifier)
        .riffetMaterialSource(zIndex = 1f, capture = capture, enabled = active)
        .appearancePageBackground(pageColor())
    SubcomposeLayout(modifier.fillMaxSize()) { constraints ->
        val chromeConstraints = constraints.copy(minWidth = constraints.maxWidth, minHeight = 0)
        val top = subcompose("top") {
            Column(Modifier.fillMaxWidth().then(topSurface)) {
                RiffetMaterialContent(content = topBar)
            }
        }.single().measure(chromeConstraints)
        val bottom = subcompose("bottom") {
            if (bottomBar != null) Column(Modifier.fillMaxWidth().then(bottomSurface)) {
                // A floating island owns its material pass; continuous chrome already owns it.
                // Branch on placement, so switching material never remounts the input subtree.
                if (floatingBottomBar) RiffetMaterialWindow(bottomBar)
                else RiffetMaterialContent(content = bottomBar)
            } else Box(Modifier)
        }.single().measure(chromeConstraints)
        val insets = PaddingValues(
            start = bars.calculateLeftPadding(layoutDirection), end = bars.calculateRightPadding(layoutDirection),
            top = top.height.toDp() + bars.calculateTopPadding(),
            bottom = bottom.height.toDp() + bars.calculateBottomPadding(),
        )
        val body = subcompose("body") {
            TraceLifecycle("page-body")
            // Inactive pages do not publish captured pixels into a visible page's chrome.
            Box(bodyModifier) {
                CompositionLocalProvider(LocalPageChromeInsets provides insets) {
                    RiffetMaterialRecordedContent(capture) {
                        if (deferBody) PageBody(Modifier.fillMaxSize()) { content(insets) } else content(insets)
                    }
                }
            }
        }.single().measure(Constraints.fixed(constraints.maxWidth, constraints.maxHeight))
        val floating = overlay?.let { slot ->
            subcompose("overlay") {
                // The body's frame, so the same insets place controls where they sat inside it.
                Box(Modifier.fillMaxSize().then(if (extendSystemBars) Modifier.coverSystemBars() else Modifier)) {
                    val box = this
                    RiffetMaterialWindow { box.slot(insets) }
                }
            }.single().measure(Constraints.fixed(constraints.maxWidth, constraints.maxHeight))
        }
        layout(constraints.maxWidth, constraints.maxHeight) {
            body.place(0, 0)
            floating?.place(0, 0)
            top.place(0, 0)
            bottom.place(0, constraints.maxHeight - bottom.height)
        }
    }
}

/** Extend an effect across a consumed system inset without moving its foreground controls. */
private fun Modifier.extendChromeInset(inset: Int, above: Boolean): Modifier = if (inset == 0) this else layout { measurable, constraints ->
    val extended = if (constraints.hasBoundedHeight) constraints.copy(
        maxHeight = (constraints.maxHeight.toLong() + inset).coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
    ) else constraints
    val child = measurable.measure(extended)
    layout(child.width, (child.height - inset).coerceAtLeast(0)) { child.place(0, if (above) -inset else 0) }
}
