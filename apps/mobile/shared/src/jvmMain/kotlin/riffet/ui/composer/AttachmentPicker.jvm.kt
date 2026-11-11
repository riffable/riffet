package riffet.ui.composer

import androidx.compose.runtime.Composable

/*
 * The JVM target exists so the network and state logic can be compiled and tested without an
 * Android SDK (see `shared/build.gradle.kts`). It is a test host, not a desktop product: there is
 * no document picker and the outbox only has to outlive a single test.
 */

@Composable
actual fun rememberAttachmentPicker(onError: (String) -> Unit, onPicked: (List<PickedAttachment>) -> Unit): AttachmentPicker =
    UnavailableAttachmentPicker()

actual suspend fun readClipboardAttachments(): List<PickedAttachment> = emptyList()
