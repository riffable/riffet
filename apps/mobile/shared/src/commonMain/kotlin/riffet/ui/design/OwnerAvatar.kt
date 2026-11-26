package riffet.ui.design

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImagePainter
import coil3.compose.LocalPlatformContext
import coil3.compose.rememberAsyncImagePainter
import coil3.request.ImageRequest
import coil3.size.Scale
import riffet.contracts.OwnerInfo
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.rememberRiffetImageLoader

/**
 * The workbench owner's avatar (docs/OWNER.md): the picture when there is one, else the name's
 * first character, else a person glyph, on a neutral surface so a name never picks a colour.
 * [imageUrl] is `RiffetApi.ownerAvatarUrl`; the shared image loader sends the device credentials.
 */
@Composable
internal fun OwnerAvatar(owner: OwnerInfo?, imageUrl: String?, size: Dp, modifier: Modifier = Modifier) {
    val colors = LocalRiffetColors.current
    val monogram = owner?.monogram
    Box(modifier.size(size).clip(CircleShape).background(colors.bgMuted), contentAlignment = Alignment.Center) {
        if (monogram != null) {
            Text(
                monogram,
                style = LocalRiffetTypography.current.headline.copy(fontSize = (size.value * 0.42f).sp, fontWeight = FontWeight.Medium),
                color = colors.fg2, maxLines = 1, overflow = TextOverflow.Clip,
            )
        } else Icon(RiffetIcons.User, null, Modifier.size(size * 0.5f), colors.fg2)
        if (imageUrl != null) OwnerAvatarImage(imageUrl, size)
    }
}

/** Drawn over the fallback, so a slow or failed load leaves the monogram showing. */
@Composable
private fun OwnerAvatarImage(url: String, size: Dp) {
    val painter = rememberAvatarPainter(url, size)
    val state by painter.state.collectAsState()
    if (state is AsyncImagePainter.State.Success) Image(painter, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
}

/** A round avatar's picture at [size], through the shared loader that sends the device credentials. */
@Composable
internal fun rememberAvatarPainter(url: String, size: Dp): AsyncImagePainter {
    val context = LocalPlatformContext.current
    val pixels = with(LocalDensity.current) { size.roundToPx() }.coerceAtLeast(1)
    val request = remember(url, pixels, context) {
        ImageRequest.Builder(context).data(url).size(pixels, pixels).scale(Scale.FILL).build()
    }
    return rememberAsyncImagePainter(model = request, imageLoader = rememberRiffetImageLoader(), contentScale = ContentScale.Crop)
}
