package riffet.ui.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.app.AdaptiveModalViewport
import riffet.ui.app.LocalRiffetWindowInfo
import riffet.ui.app.adaptiveDialogProperties

internal val LocalDialogAction = staticCompositionLocalOf { false }

/** Callers own operation state. A form has navigation actions; a short alert has an action row. */
@Composable
internal fun AlertDialog(
    onDismissRequest: () -> Unit,
    confirmButton: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    dismissButton: (@Composable () -> Unit)? = null,
    icon: (@Composable () -> Unit)? = null,
    title: (@Composable () -> Unit)? = null,
    text: (@Composable () -> Unit)? = null,
    shape: Shape = RoundedCornerShape(LocalInterfaceStyle.current.metrics.groupRadius),
    containerColor: Color = surfaces.floating,
    iconContentColor: Color = MaterialTheme.colorScheme.secondary,
    titleContentColor: Color = MaterialTheme.colorScheme.onSurface,
    textContentColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    tonalElevation: Dp = 0.dp,
    properties: DialogProperties = DialogProperties(),
    wideContent: Boolean = false,
) {
    val type = LocalRiffetTypography.current
    val splitWindow = LocalRiffetWindowInfo.current.folds.any { it.separating || it.occluding }
    if (!splitWindow && !materialBackdropEnabled && LocalInterfaceStyle.current.components.dialogs.backend == ComponentBackend.MATERIAL) {
        val heading: (@Composable () -> Unit)? = title?.let { slot -> { CompositionLocalProvider(LocalTextStyle provides type.dialogTitle) { slot() } } }
        val body: (@Composable () -> Unit)? = text?.let { slot -> { CompositionLocalProvider(LocalTextStyle provides type.dialogBody) { slot() } } }
        androidx.compose.material3.AlertDialog(
            onDismissRequest, confirmButton, modifier, dismissButton, icon, heading, body,
            shape, containerColor, iconContentColor, titleContentColor, textContentColor, tonalElevation, properties,
        )
        return
    }
    Dialog(onDismissRequest = onDismissRequest, properties = if (splitWindow) adaptiveDialogProperties(properties) else properties) {
        RiffetMaterialWindow {
            if (splitWindow) {
                Box(Modifier.fillMaxSize()) {
                    if (properties.dismissOnClickOutside) Box(Modifier.matchParentSize()
                        .clickable(remember { MutableInteractionSource() }, indication = null, onClick = onDismissRequest))
                    AdaptiveModalViewport(fullWindowCoordinates = true) {
                        RiffetDialogContent(confirmButton, modifier.pointerInput(Unit) { detectTapGestures(onTap = {}) },
                            dismissButton, icon, title, text, shape, containerColor, iconContentColor, titleContentColor, textContentColor, wideContent)
                    }
                }
            } else {
            RiffetDialogContent(confirmButton, modifier, dismissButton, icon, title, text, shape,
                containerColor, iconContentColor, titleContentColor, textContentColor, wideContent)
            }
        }
    }
}

/** Window-independent presentation shared by alert and form hosts; no business or dismissal logic. */
@Composable
internal fun RiffetDialogContent(
    confirmButton: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    dismissButton: (@Composable () -> Unit)? = null,
    icon: (@Composable () -> Unit)? = null,
    title: (@Composable () -> Unit)? = null,
    text: (@Composable () -> Unit)? = null,
    shape: Shape = RoundedCornerShape(LocalInterfaceStyle.current.metrics.groupRadius),
    containerColor: Color = surfaces.floating,
    iconContentColor: Color = MaterialTheme.colorScheme.secondary,
    titleContentColor: Color = MaterialTheme.colorScheme.onSurface,
    textContentColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    wideContent: Boolean = false,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val style = LocalInterfaceStyle.current
    val type = LocalRiffetTypography.current
    val separator = surfaces.hairline
    val hairline = metrics.hairlineWidth
    if (!style.components.dialogs.stackedActions) {
        BoxWithConstraints(modifier) {
            Surface(Modifier.width(if (wideContent) minOf(metrics.sheetMaxWidth, 640.dp) else maxOf(metrics.alertWidth, 320.dp))
                .heightIn(max = minOf(maxHeight * 0.7f, 640.dp))
                .riffetMaterial(MaterialRole.DIALOG, shape, containerColor)
                .then(if (style.components.dialogs.border) Modifier.border(hairline, surfaces.hairline, shape) else Modifier),
                shape = shape, color = Color.Transparent, tonalElevation = 0.dp) {
                RiffetMaterialContent {
                    Column(Modifier.padding(metrics.dialogInset),
                        horizontalAlignment = if (style.components.dialogs.centeredContent) Alignment.CenterHorizontally else Alignment.Start,
                        verticalArrangement = Arrangement.spacedBy(metrics.controlInset)) {
                        CompositionLocalProvider(LocalContentColor provides iconContentColor) { icon?.invoke() }
                        CompositionLocalProvider(LocalContentColor provides titleContentColor, LocalTextStyle provides type.dialogTitle) { title?.invoke() }
                        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).fillMaxWidth()) {
                            CompositionLocalProvider(LocalContentColor provides textContentColor, LocalTextStyle provides type.dialogBody) { text?.invoke() }
                        }
                        FlowRow(Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(metrics.controlInset, Alignment.End)) {
                            CompositionLocalProvider(LocalDialogAction provides true) {
                                dismissButton?.invoke()
                                CompositionLocalProvider(LocalTextStyle provides type.button.copy(fontWeight = FontWeight.SemiBold)) { confirmButton() }
                            }
                        }
                    }
                }
            }
        }
        return
    }
    val titleStyle = type.dialogTitle.copy(textAlign = TextAlign.Center)
    val messageStyle = type.dialogBody.copy(textAlign = TextAlign.Center)
    val actionStyle = type.button.copy(textAlign = TextAlign.Center)
    val action: @Composable (Boolean, @Composable () -> Unit) -> Unit = { emphasized, slot ->
        CompositionLocalProvider(LocalDialogAction provides true,
            LocalTextStyle provides actionStyle.copy(fontWeight = if (emphasized) FontWeight.SemiBold else FontWeight.Normal)) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) { slot() }
        }
    }
    BoxWithConstraints(modifier) {
        Surface(Modifier.width(if (wideContent) minOf(metrics.sheetMaxWidth, 640.dp) else metrics.alertWidth).heightIn(max = minOf(maxHeight * 0.7f, 640.dp))
            .riffetMaterial(MaterialRole.DIALOG, shape, containerColor),
            shape = shape, color = Color.Transparent, tonalElevation = 0.dp, shadowElevation = 0.dp) {
            RiffetMaterialContent {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    if (wideContent) {
                        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).heightIn(min = maxOf(metrics.controlHeight, metrics.rowHeight)), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { dismissButton?.let { action(false, it) } }
                            Box(Modifier.weight(1.7f).padding(vertical = metrics.controlInset), contentAlignment = Alignment.Center) {
                                CompositionLocalProvider(LocalContentColor provides titleContentColor, LocalTextStyle provides titleStyle) { title?.invoke() }
                            }
                            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { action(true, confirmButton) }
                        }
                        Box(Modifier.fillMaxWidth().height(hairline).background(separator))
                        CompositionLocalProvider(LocalContentColor provides textContentColor,
                            LocalTextStyle provides type.dialogBody.copy(textAlign = TextAlign.Start)) {
                            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).fillMaxWidth().padding(metrics.dialogInset)) { text?.invoke() }
                        }
                    } else {
                        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).fillMaxWidth().padding(metrics.dialogInset),
                            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy((metrics.controlInset / 4))) {
                            if (icon != null) CompositionLocalProvider(LocalContentColor provides iconContentColor) { icon() }
                            CompositionLocalProvider(LocalContentColor provides titleContentColor, LocalTextStyle provides titleStyle) { title?.invoke() }
                            CompositionLocalProvider(LocalContentColor provides textContentColor, LocalTextStyle provides messageStyle) { text?.invoke() }
                        }
                        Box(Modifier.fillMaxWidth().height(hairline).background(separator))
                        // Slots may emit several actions; keep every action in flow order.
                        action(true, confirmButton)
                        if (dismissButton != null) {
                            Box(Modifier.fillMaxWidth().height(hairline).background(separator))
                            action(false, dismissButton)
                        }
                    }
                }
            }
        }
    }
}
