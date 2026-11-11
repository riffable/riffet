package riffet.android

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService
import riffet.shared.AppLanguages

/** The Quick Settings tile: the same entry as the launcher shortcut, over the current app. */
class QuickChatTileService : TileService() {

    override fun onStartListening() {
        super.onStartListening()
        qsTile?.let { tile ->
            tile.label = AppLanguages.localize(this).getString(R.string.quick_chat)
            tile.updateTile()
        }
    }

    override fun onClick() {
        val intent = Intent(this, QuickChatActivity::class.java)
            .setAction(QuickChatActivity.ACTION_QUICK_CHAT)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(
                PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
            )
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
