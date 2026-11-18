package riffet.ui.pairing

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Lucide `scan-line` and `clipboard-paste` (ISC, see LucideIcons.generated.kt), drawn like the
 * generated set. They stay here rather than in `RiffetIcons`: every icon there needs a glyph in each
 * icon pack, and the pack snapshots are built from upstream sources this repository doesn't vendor.
 */
internal object PairingIcons {
    val ScanLine: ImageVector by lazy {
        glyph("ScanLine", "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10")
    }

    val ClipboardPaste: ImageVector by lazy {
        glyph("ClipboardPaste", "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 14h10M16 4h2a2 2 0 0 1 2 2v1.344M17 18l4-4-4-4M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113")
    }

    /** Lucide `server` and `wifi`. */
    val Server: ImageVector by lazy {
        glyph("Server", "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zM6 6h.01M6 18h.01")
    }

    val Wifi: ImageVector by lazy {
        glyph("Wifi", "M12 20h.01M2 8.82a15 15 0 0 1 20 0M5 12.859a10 10 0 0 1 14 0M8.5 16.429a5 5 0 0 1 7 0")
    }

    private fun glyph(name: String, pathData: String): ImageVector =
        ImageVector.Builder("Pairing$name", 24.dp, 24.dp, 24f, 24f)
            .addPath(
                pathData = addPathNodes(pathData),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.25f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
            .build()
}
