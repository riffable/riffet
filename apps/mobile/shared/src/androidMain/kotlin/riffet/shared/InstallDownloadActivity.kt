package riffet.shared

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast

/** Keeps the selected APK across the system's unknown-source permission screen. */
class InstallDownloadActivity : Activity() {
    private var waitingForPermission = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        waitingForPermission = savedInstanceState?.getBoolean("waiting") == true
        if (waitingForPermission) return
        val uri = intent.data
        if (uri?.scheme != "content") return fail(text(R.string.host_install_bad_package))
        try {
            contentResolver.openAssetFileDescriptor(uri, "r")?.use { }
                ?: return fail(text(R.string.host_install_missing_package))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
                waitingForPermission = true
                @Suppress("DEPRECATION")
                startActivityForResult(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")), 1)
            } else install(uri)
        } catch (_: Exception) {
            fail(text(R.string.host_install_open_failed))
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("waiting", waitingForPermission)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Uses the platform Activity result callback for the system settings screen")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 1) return
        waitingForPermission = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
            fail(text(R.string.host_install_permission_denied))
            return
        }
        val uri = intent.data ?: return fail(text(R.string.host_install_missing_package))
        install(uri)
    }

    private fun install(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, APK_MIME_TYPE)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .apply { clipData = ClipData.newRawUri(text(R.string.host_install_clip_label), uri) })
            finish()
        } catch (_: Exception) {
            fail(text(R.string.host_install_launch_failed))
        }
    }

    private fun fail(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        finish()
    }

    private fun text(id: Int): String = AppLanguages.localize(this).getString(id)
}
