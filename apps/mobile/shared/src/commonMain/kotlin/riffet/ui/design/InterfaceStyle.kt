package riffet.ui.design

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import riffet.shared.InterfaceStyle
import riffet.ui.theme.RiffetMotion

/** Resolved component recipes and theme tokens. Navigation/business state never belongs here. */
@Immutable
internal data class InterfaceStyleTokens(
    val components: ComponentRecipes,
    val metrics: DesignMetrics,
    val variants: DesignVariants,
    val motion: RiffetMotion,
) {
    val groupRadius get() = metrics.groupRadius
    val menuRadius get() = metrics.menuRadius
    val controlRadius get() = metrics.controlRadius
    val rowRadius get() = metrics.rowRadius
    val selectionRadius get() = metrics.selectionRadius
    val composerRadius get() = metrics.composerRadius
    val barHeight get() = metrics.barHeight
    val pageEnterMillis get() = motion.pageEnter
    val pageExitMillis get() = motion.pageExit
    val coveredPageShift get() = motion.coveredPageShift
    val coveredPageDim get() = motion.coveredPageDim
    val shapes get(): Shapes {
        return Shapes(
            extraSmall = RoundedCornerShape(metrics.selectionRadius),
            small = RoundedCornerShape(metrics.rowRadius),
            medium = RoundedCornerShape(metrics.controlRadius),
            large = RoundedCornerShape(metrics.groupRadius),
            extraLarge = RoundedCornerShape(metrics.composerRadius),
        )
    }
}

internal fun interfaceStyleTokens(
    design: ResolvedDesign = resolveDesign(InterfaceStyle.MATERIAL3, null, false),
): InterfaceStyleTokens = InterfaceStyleTokens(design.preset.components, design.metrics, design.variants, RiffetMotion(design.motion, design.preset.motionEasing))

internal val LocalInterfaceStyle = staticCompositionLocalOf { interfaceStyleTokens() }
