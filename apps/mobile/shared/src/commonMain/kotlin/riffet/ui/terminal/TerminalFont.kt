package riffet.ui.terminal

import androidx.compose.ui.text.font.FontFamily

/**
 * The terminal's typeface. Not `FontFamily.Monospace`: what a platform maps that to is its own
 * choice, and on some Android builds it is a proportional face — measured on a OnePlus, the cells
 * came out as wide as an "M" while every other letter drew narrower, so English bunched up, CJK
 * stood apart and the grid lost columns. Android bundles JetBrains Mono NL (no ligatures, OFL-1.1,
 * licence in res/raw/jetbrains_mono_ofl.txt).
 */
internal expect val terminalFontFamily: FontFamily

@androidx.compose.runtime.Composable
internal fun appearanceTerminalFontFamily(): FontFamily =
    riffet.ui.theme.LocalAppearanceResources.current?.monoFont ?: terminalFontFamily
