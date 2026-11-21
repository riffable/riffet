@file:OptIn(dev.chrisbanes.haze.ExperimentalHazeApi::class)

package riffet.ui.design

import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.LinearGradientShader
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeInput
import dev.chrisbanes.haze.HazePerformanceMode
import dev.chrisbanes.haze.HazeProgressive
import dev.chrisbanes.haze.HazeSourceRetention
import dev.chrisbanes.haze.HazeSourceSelection
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.blur.HazeBlurStyle
import dev.chrisbanes.haze.blur.HazeColorEffect
import dev.chrisbanes.haze.blur.hazeBlur
import dev.chrisbanes.haze.glass.GlassStyle
import dev.chrisbanes.haze.glass.GlassTransformTarget
import dev.chrisbanes.haze.glass.RefractionProfile
import dev.chrisbanes.haze.glass.hazeGlass
import dev.chrisbanes.haze.hazeSource
import riffet.shared.SurfaceMaterial
import riffet.ui.theme.LocalRiffetColors

/** Material placement, independent of component backend and interface-style identity. */
internal enum class MaterialRole { NAVIGATION, TOP_BAR, BOTTOM_BAR, COMPOSER, MENU, SHEET, DIALOG, SIDEBAR, CONTROL }

@Stable
private class MaterialSourceScope(val parent: MaterialSourceScope? = null) {
    val state = HazeState()
    /** Disabled sources park their area here, where no effect reads it and nothing is recorded. */
    val parkedState = HazeState()
    private var attachedSources by mutableIntStateOf(0)

    fun attachSource() { attachedSources += 1 }
    fun detachSource() { attachedSources = (attachedSources - 1).coerceAtLeast(0) }

    /** Select the closest source owner without depending on HazeState's internal area collection. */
    fun sourceOwner(): MaterialSourceScope {
        var owner = this
        while (owner.attachedSources == 0) {
            owner = owner.parent ?: break
        }
        return owner
    }
}

private enum class MaterialBoundary { NONE, SURFACE, SOURCE }

@Stable
private data class MaterialEnvironment(
    val material: SurfaceMaterial,
    val strength: Float,
    val sources: MaterialSourceScope,
    val boundary: MaterialBoundary = MaterialBoundary.NONE,
    val recorded: Boolean = false,
    /** The recorded source this content is drawn into, if any. */
    val capture: MaterialCapture? = null,
    /** A reading pane's base: the shell paints it, while inner cards retain their theme colors. */
    val contentBase: Color? = null,
)

/**
 * One recorded source's platform views. A consumer redraws its source through the blur's
 * offscreen layer, where Android WebView's Vulkan draw functor aborts the process, so a source
 * holding one stops recording until it leaves. Counts propagate to the sources around it.
 */
@Stable
internal class MaterialCapture(private val parent: MaterialCapture?) {
    var platformViews by mutableIntStateOf(0)
        private set

    fun attach() { platformViews += 1; parent?.attach() }
    fun detach() { platformViews = (platformViews - 1).coerceAtLeast(0); parent?.detach() }
}

@Composable
internal fun rememberMaterialCapture(): MaterialCapture {
    val parent = LocalMaterial.current.capture
    return remember(parent) { MaterialCapture(parent) }
}

private val LocalMaterial = staticCompositionLocalOf {
    MaterialEnvironment(SurfaceMaterial.SOLID, 0.5f, MaterialSourceScope())
}

/** A stable scope: changing the material never replaces the content/navigation subtree. */
@Composable
internal fun RiffetMaterialScope(material: SurfaceMaterial, strength: Float, content: @Composable () -> Unit) {
    val sources = remember { MaterialSourceScope() }
    val safeStrength = if (strength.isFinite()) strength.coerceIn(0f, 1f) else 0.5f
    val environment = remember(material, safeStrength, sources) { MaterialEnvironment(material, safeStrength, sources) }
    CompositionLocalProvider(LocalMaterial provides environment, content = content)
}

internal val materialBackdropEnabled: Boolean
    @Composable @ReadOnlyComposable get() = LocalMaterial.current.material != SurfaceMaterial.SOLID

internal val materialIsRefractive: Boolean
    @Composable @ReadOnlyComposable get() =
        LocalMaterial.current.material == SurfaceMaterial.GLASS || LocalMaterial.current.material == SurfaceMaterial.LIQUID

/**
 * Isolate the shell's descendants from the HazeState sampled by the shell itself.
 * Nested surfaces inherit the shell instead of rendering again. Their sources are only consumed
 * by a later window boundary, never by the containing shell or the parent window's chrome.
 */
@Composable
internal fun RiffetMaterialContent(baseBackground: Color? = null, content: @Composable () -> Unit) {
    val environment = LocalMaterial.current
    val childSources = remember(environment.sources) { MaterialSourceScope(environment.sources) }
    val sources = if (environment.boundary != MaterialBoundary.NONE || environment.material == SurfaceMaterial.SOLID)
        environment.sources else childSources
    val child = remember(environment, sources, baseBackground) {
        environment.copy(sources = sources, boundary = MaterialBoundary.SURFACE, contentBase = baseBackground)
    }
    CompositionLocalProvider(LocalMaterial provides child, content = content)
}

/** A recorded source keeps its current owner and cannot contain active material consumers. */
@Composable
internal fun RiffetMaterialSourceContent(content: @Composable () -> Unit) {
    val environment = LocalMaterial.current
    val capture = rememberMaterialCapture()
    val child = remember(environment, capture) { environment.copy(boundary = MaterialBoundary.SOURCE, capture = capture) }
    CompositionLocalProvider(LocalMaterial provides child, content = content)
}

/**
 * A recorded page body uses a higher source z-index than its wallpaper. Consumers inside it can
 * read the wallpaper through Behind selection, while fixed siblings can read the complete body.
 */
@Composable
internal fun RiffetMaterialRecordedContent(capture: MaterialCapture, content: @Composable () -> Unit) {
    val environment = LocalMaterial.current
    val recorded = remember(environment, capture) { environment.copy(boundary = MaterialBoundary.NONE, recorded = true, capture = capture) }
    CompositionLocalProvider(LocalMaterial provides recorded, content = content)
}

/** Shows a platform view only once the sources around it have stopped recording. */
@Composable
internal fun RiffetMaterialPlatformView(content: @Composable () -> Unit) {
    val capture = LocalMaterial.current.capture ?: return content()
    DisposableEffect(capture) {
        capture.attach()
        onDispose { capture.detach() }
    }
    if (capture.platformViews > 0) content()
}

/** New Popup/Dialog windows consume their nearest available background, not an inherited shell. */
@Composable
internal fun RiffetMaterialWindow(content: @Composable () -> Unit) {
    val environment = LocalMaterial.current
    val window = remember(environment) { environment.copy(boundary = MaterialBoundary.NONE, recorded = false, contentBase = null) }
    CompositionLocalProvider(LocalMaterial provides window, content = content)
}

/** Reading panes retain ordinary card fills above the material; the shell owns their base. */
@Composable
@ReadOnlyComposable
internal fun materialContentBackground(background: Color): Color {
    val environment = LocalMaterial.current
    if (environment.material == SurfaceMaterial.SOLID || environment.boundary != MaterialBoundary.SURFACE) return background
    val base = environment.contentBase
    if (base != null) return if (background == base) Color.Transparent else background
    return background.copy(alpha = background.alpha * 0.12f)
}

/**
 * Mark a background/content sibling enclosed in RiffetMaterialSourceContent.
 * An opaque base is captured inside the source, even when its parent's Surface paints outside it.
 * Haze records only while a visible effect demands the source, and releases layers on detachment.
 * A disabled source keeps the same node chain and parks its Haze area on an unread state, so
 * toggling it never rebuilds nodes or remeasures the content.
 */
@Composable
internal fun Modifier.riffetMaterialSource(
    background: Color = LocalRiffetSurfaces.current.page,
    zIndex: Float = 0f,
    key: Any? = null,
    capture: MaterialCapture? = LocalMaterial.current.capture,
    enabled: Boolean = true,
): Modifier {
    val environment = LocalMaterial.current
    return if (environment.material == SurfaceMaterial.SOLID || environment.recorded) this
    else if (capture != null && capture.platformViews > 0) background(background.copy(alpha = 1f))
    else then(SourceRegistrationElement(environment.sources, enabled))
        .hazeSource(if (enabled) environment.sources.state else environment.sources.parkedState, zIndex, key)
        .background(background.copy(alpha = 1f))
}

/** Count source-node attachment, matching Haze area's node lifetime rather than composition presence. */
private data class SourceRegistrationElement(
    val sources: MaterialSourceScope,
    val enabled: Boolean,
) : ModifierNodeElement<SourceRegistrationNode>() {
    override fun create() = SourceRegistrationNode(sources, enabled)
    override fun update(node: SourceRegistrationNode) { node.update(sources, enabled) }
    override fun InspectorInfo.inspectableProperties() { name = "riffetMaterialSourceRegistration" }
}

private class SourceRegistrationNode(private var sources: MaterialSourceScope, private var enabled: Boolean) : Modifier.Node() {
    override fun onAttach() { if (enabled) sources.attachSource() }
    override fun onDetach() { if (enabled) sources.detachSource() }

    fun update(next: MaterialSourceScope, nextEnabled: Boolean) {
        if (sources === next && enabled == nextEnabled) return
        if (isAttached && enabled) sources.detachSource()
        sources = next
        enabled = nextEnabled
        if (isAttached && enabled) sources.attachSource()
    }
}

@Immutable
private data class MaterialSpec(
    val blurRadius: Float,
    val tintAlpha: Float,
    val refraction: Float,
    val displacement: Float,
    val edgeWidth: Float,
    val specular: Float,
    val dispersion: Float,
    val noise: Float,
    val progressive: Boolean,
    val interactive: Boolean,
    val depth: Float = 0f,
    val refractionDetail: Float = 0f,
    val saturation: Float = 1f,
)

/** Keep the island's foreground readable across both extremes of an arbitrary image backdrop. */
private fun islandTintFloor(
    tint: Color, foreground: Color, minimumContrast: Float = 4.5f, overlay: Color = Color.Transparent,
): Float {
    val ink = foreground.copy(alpha = 1f).luminance()
    fun readable(alpha: Float): Boolean {
        val shade = tint.copy(alpha = alpha)
        val low = overlay.compositeOver(shade.compositeOver(Color.Black)).luminance()
        val high = overlay.compositeOver(shade.compositeOver(Color.White)).luminance()
        // The entire background interval must stay on one side of the foreground luminance.
        if (ink in low..high) return false
        val background = if (ink < low) low else high
        return (maxOf(ink, background) + 0.05f) / (minOf(ink, background) + 0.05f) >= minimumContrast
    }
    // Tint cannot repair a custom palette whose foreground already fails on its own surface.
    if (!readable(1f)) return 0f
    var low = 0f
    var high = 1f
    repeat(12) {
        val middle = (low + high) / 2
        if (readable(middle)) high = middle else low = middle
    }
    return high
}

private fun materialSpec(material: SurfaceMaterial, role: MaterialRole, strength: Float, dark: Boolean): MaterialSpec {
    // Continuous chrome retains each material response without inventing a rectangular optical rim.
    // Rounded islands use real edge refraction; fixed chrome varies diffusion and color response.
    if ((role == MaterialRole.TOP_BAR || role == MaterialRole.BOTTOM_BAR) && material != SurfaceMaterial.SOLID) {
        val spec = when (material) {
            SurfaceMaterial.FROSTED -> Triple(24f + strength * 12f, 0.54f + strength * 0.10f, 1f)
            SurfaceMaterial.GLASS -> Triple(14f + strength * 6f, 0.34f + strength * 0.08f, 1.03f)
            SurfaceMaterial.LIQUID -> Triple(10f + strength * 4f, 0.30f + strength * 0.08f, 1.18f + strength * 0.08f)
            SurfaceMaterial.SOLID -> error("Solid chrome uses its background")
        }
        return MaterialSpec(
            blurRadius = spec.first, tintAlpha = spec.second + if (dark) 0.06f else 0f,
            refraction = 0f, displacement = 0f, edgeWidth = 0f, specular = 0f, dispersion = 0f,
            noise = if (material == SurfaceMaterial.FROSTED) 0.012f + strength * 0.012f else 0f,
            progressive = false, interactive = false, saturation = spec.third,
        )
    }
    val readingSurface = role in listOf(MaterialRole.MENU, MaterialRole.SHEET,
        MaterialRole.DIALOG, MaterialRole.SIDEBAR)
    val tintBase = when {
        readingSurface -> 0.58f
        role == MaterialRole.NAVIGATION -> 0.50f
        else -> 0.36f
    }
    val spec = when (material) {
        SurfaceMaterial.SOLID -> MaterialSpec(0f, 1f, 0f, 0f, 0f, 0f, 0f, 0f, false, false)
        SurfaceMaterial.FROSTED -> MaterialSpec(
            blurRadius = 14f + strength * 14f,
            tintAlpha = (tintBase + 0.16f + strength * 0.12f + if (dark) 0.06f else 0f).coerceAtMost(0.94f),
            refraction = 0f, displacement = 0f, edgeWidth = 0f, specular = 0f, dispersion = 0f,
            noise = 0.012f + strength * 0.012f, progressive = role == MaterialRole.TOP_BAR, interactive = false,
        )
        SurfaceMaterial.GLASS -> MaterialSpec(
            // A flat pane diffuses its backdrop without changing the backdrop geometry.
            blurRadius = (if (readingSurface) 12f else 9f) + strength * (if (readingSurface) 8f else 6f),
            tintAlpha = (if (readingSurface) 0.46f else 0.20f) + strength * 0.08f + if (dark) 0.06f else 0f,
            refraction = 0f, displacement = 0f, edgeWidth = 0f, specular = 0.14f + strength * 0.10f,
            dispersion = 0f, noise = 0f, progressive = role == MaterialRole.TOP_BAR, interactive = false,
            depth = 1f,
        )
        SurfaceMaterial.LIQUID -> MaterialSpec(
            // A shallow diffusion layer preserves detail; the curved edge bends and magnifies it.
            // Reading surfaces keep more diffusion and tint beneath small text.
            blurRadius = (if (readingSurface) 8f else 1.5f) + strength * (if (readingSurface) 5f else 2.5f),
            tintAlpha = (if (readingSurface) 0.42f else 0.10f) + strength * 0.06f + if (dark) 0.06f else 0f,
            refraction = (if (readingSurface) 0.36f else 0.65f) + strength * (if (readingSurface) 0.20f else 0.25f),
            displacement = (if (readingSurface) 12f else 28f) + strength * (if (readingSurface) 12f else 24f),
            edgeWidth = (if (readingSurface) 14f else 20f) + strength * 10f,
            specular = 0.36f + strength * 0.20f,
            dispersion = if (readingSurface) 0f else 0.025f + strength * 0.035f,
            noise = 0f, progressive = role == MaterialRole.TOP_BAR,
            interactive = role == MaterialRole.NAVIGATION || role == MaterialRole.CONTROL,
            depth = 1f, refractionDetail = if (readingSurface) 0.32f else 0.76f,
        )
    }
    // Menus put small text over the page: nearly opaque, so rows behind do not ghost through.
    return if (role == MaterialRole.MENU && material != SurfaceMaterial.SOLID) spec.copy(
        tintAlpha = 0.94f,
        refraction = spec.refraction * 0.4f,
        displacement = spec.displacement * 0.4f,
        edgeWidth = spec.edgeWidth * 0.5f,
        specular = spec.specular * 0.3f,
    ) else spec
}

/**
 * Paint one surface's background; foreground content remains outside the blur/refraction pass.
 * Replace the old background with this modifier. Do not paint an opaque inner background over it.
 * Cross-window Sources use Haze's automatic Screen coordinates; native window backdrop is not enabled.
 * The caller's background is the base; unsupported rendering may add Haze's tint/rim fallback.
 * Unavailable sources clear retained source pixels instead of keeping the previous page's output.
 */
@Composable
internal fun Modifier.riffetMaterial(
    role: MaterialRole,
    shape: Shape,
    background: Color,
    interactionSource: MutableInteractionSource? = null,
): Modifier {
    val environment = LocalMaterial.current
    val continuous = role == MaterialRole.TOP_BAR || role == MaterialRole.BOTTOM_BAR
    if (environment.material == SurfaceMaterial.SOLID || environment.boundary != MaterialBoundary.NONE) {
        val inherited = environment.material != SurfaceMaterial.SOLID && environment.boundary == MaterialBoundary.SURFACE
        val innerBackground = when {
            inherited && continuous -> Color.Transparent
            inherited && role == MaterialRole.COMPOSER -> materialContentBackground(background)
            else -> background
        }
        return this.background(innerBackground, shape)
    }
    val surfaces = LocalRiffetSurfaces.current
    // Composer islands share the navigation island's optics, rather than a separate reading recipe.
    val opticalRole = if (role == MaterialRole.COMPOSER) MaterialRole.NAVIGATION else role
    val navigation = LocalInterfaceStyle.current.components.navigation
    val tintBase = if (role == MaterialRole.COMPOSER) {
        if (navigation.cardSurface) surfaces.card else surfaces.navigation
    } else if (background.alpha == 0f) surfaces.floating else background.copy(alpha = 1f)
    val islandColors = LocalRiffetColors.current
    val islandInk = islandColors.fg
    val secondaryInk = islandColors.fg3
    val spec = remember(environment.material, role, opticalRole, environment.strength, surfaces.dark, tintBase, islandInk,
        secondaryInk, navigation.accentSelection, surfaces.focus, surfaces.selected) {
        val resolved = materialSpec(environment.material, opticalRole, environment.strength, surfaces.dark)
        if (opticalRole == MaterialRole.NAVIGATION) {
            val textFloor = islandTintFloor(tintBase, islandInk)
            val secondaryFloor = if (role == MaterialRole.NAVIGATION) islandTintFloor(
                tintBase, secondaryInk, minimumContrast = 3f,
            ) else 0f
            val accentFloor = if (navigation.accentSelection) islandTintFloor(
                tintBase, surfaces.focus, minimumContrast = 3f, overlay = surfaces.selected.copy(alpha = 0.72f),
            ) else 0f
            resolved.copy(tintAlpha = maxOf(resolved.tintAlpha, textFloor, secondaryFloor, accentFloor))
        } else resolved
    }
    val sourceOwner = environment.sources.sourceOwner()
    val input = remember(sourceOwner, environment.recorded) {
        // During navigation an outgoing page loses its source before its fade ends.
        // Body controls always read wallpaper, independent of ancestor attachment;
        // fixed chrome and windows can still sample the complete active page.
        val selection = if (environment.recorded) HazeSourceSelection.Behind.where { it.zIndex < 1f }
            else HazeSourceSelection.Behind
        HazeInput.Sources(sourceOwner.state, selection = selection,
            retention = HazeSourceRetention.ClearWhenUnavailable)
    }
    val progressive = remember(spec.progressive) {
        if (spec.progressive) HazeProgressive.verticalGradient(startIntensity = 1f, endIntensity = 0.65f) else null
    }
    // Stable, deterministic quality. No experimental source-sharing buffers or frame-time heuristics.
    val performance = if (role == MaterialRole.SIDEBAR || role == MaterialRole.SHEET)
        HazePerformanceMode.Performance else HazePerformanceMode.Balanced
    // Fixed chrome fades into the scrolling content; an opaque outer base would hide that content.
    val base = clip(shape).then(if (continuous) Modifier else Modifier.background(
        if (role == MaterialRole.COMPOSER) tintBase else background, shape))
    // Edge-to-edge chrome is one continuous backdrop, not a glass object with a rectangular rim.
    // Optical edges belong to bounded objects such as the navigation island and picker shells.
    if (environment.material == SurfaceMaterial.FROSTED || continuous) {
        val fadeHeight = with(LocalDensity.current) { 16.dp.toPx() }
        val edgeFade = remember(role, fadeHeight) {
            if (continuous) object : ShaderBrush() {
                override fun createShader(size: Size): Shader {
                    val height = size.height.coerceAtLeast(1f)
                    return LinearGradientShader(
                        from = Offset(0f, if (role == MaterialRole.TOP_BAR) (height - fadeHeight).coerceAtLeast(0f) else 0f),
                        to = Offset(0f, if (role == MaterialRole.TOP_BAR) height else fadeHeight.coerceAtMost(height)),
                        colors = if (role == MaterialRole.TOP_BAR) listOf(Color.Black, Color.Transparent) else listOf(Color.Transparent, Color.Black),
                        tileMode = TileMode.Clamp,
                    )
                }
            } else null
        }
        val blur = remember(spec, tintBase, progressive, edgeFade) {
            HazeBlurStyle {
                blurRadius(spec.blurRadius.dp)
                backgroundColor(tintBase)
                colorEffects(buildList {
                    if (spec.saturation != 1f) add(HazeColorEffect.colorFilter(
                        ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(spec.saturation) })))
                    add(HazeColorEffect.tint(tintBase.copy(alpha = spec.tintAlpha)))
                })
                fallbackColorEffect(HazeColorEffect.tint(tintBase.copy(alpha = spec.tintAlpha)))
                noiseFactor(spec.noise)
                this.progressive(progressive)
                mask(edgeFade)
            }
        }
        return base.hazeBlur(input, blur, performanceMode = performance)
    }
    // All app shapes are rounded or rectangular. Other custom masks retain their outer clip,
    // while the optical model uses a rectangular approximation rather than changing layout.
    val rounded = shape as? RoundedCornerShape ?: RoundedCornerShape(0.dp)
    val glass = remember(spec, tintBase, rounded, progressive, surfaces.dark, opticalRole) {
        GlassStyle {
            shape(rounded)
            backgroundColor(tintBase)
            tint(tintBase.copy(alpha = spec.tintAlpha))
            optics(refractionStrength = spec.refraction, refractionHeightFraction = 0.15f,
                // Haze's depth is the sharp/blurred input mix; zero would disable its blur pass.
                refractionDisplacement = spec.displacement.dp, depth = spec.depth, blurRadius = spec.blurRadius.dp,
                progressive = progressive, refractionDetailIntensity = spec.refractionDetail,
                refractionProfile = RefractionProfile.Edge(spec.edgeWidth.dp))
            specularIntensity(spec.specular)
            ambientResponse(if (surfaces.dark) 0.08f else 0.15f)
            edgeShadow(Color.Black.copy(alpha = if (surfaces.dark) 0.24f else 0.10f))
            edgeSoftness(1.dp)
            chromaticAberrationStrength(spec.dispersion)
            contrast(if (surfaces.dark) 0.08f else 0.04f)
            whitePoint(if (surfaces.dark) -0.14f else 0.04f)
            chromaMultiplier(1f)
            lightPosition(if (opticalRole == MaterialRole.NAVIGATION) Alignment.TopCenter else Alignment.TopStart)
            if (spec.interactive) {
                focused { lightingIntensity(0.35f) }
                pressed {
                    lightingIntensity(0.65f)
                    refractionMultiplier(1.06f)
                    whitePointDelta(0.025f)
                    scale(0.985f)
                }
            }
        }
    }
    return base.hazeGlass(input, glass, performanceMode = performance, interactionSource = interactionSource,
        interactionTransformTarget = GlassTransformTarget.MaterialOnly)
}
