package riffet.ui.composer

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import riffet.contracts.DICTATION_SAMPLE_RATE
import riffet.shared.AppLog
import kotlin.concurrent.thread
import kotlin.math.sqrt

private const val FRAME_SAMPLES = DICTATION_SAMPLE_RATE / 10
private const val TAG = "DictationMic"

@Composable
actual fun rememberDictationMicrophone(): DictationMicrophone? {
    val context = LocalContext.current.applicationContext
    val microphone = remember { AndroidMicrophone(context) }
    // Asked for the first time the mic button is pressed, not before: most people never dictate.
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed -> microphone.permissionAnswered(allowed) }
    microphone.askPermission = { permission.launch(Manifest.permission.RECORD_AUDIO) }
    // Leaving the app finishes what was said rather than recording into the dark.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(microphone, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) microphone.interrupt() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); microphone.stop() }
    }
    return microphone
}

/** `AudioRecord` at the dictation's own rate, so frames go out as recorded; one reader thread per recording. */
private class AndroidMicrophone(private val context: Context) : DictationMicrophone {
    var askPermission: () -> Unit = {}
    private var waiting: DictationSink? = null
    @Volatile private var recording: Recording? = null

    override fun start(sink: DictationSink) {
        stop()
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) begin(sink)
        else { waiting = sink; askPermission() }
    }

    fun permissionAnswered(allowed: Boolean) {
        val sink = waiting ?: return
        waiting = null
        if (allowed) begin(sink) else sink.failed(MicrophoneProblem.Denied)
    }

    override fun stop() {
        waiting = null
        recording?.stop()
        recording = null
    }

    fun interrupt() {
        val current = recording ?: return
        stop()
        current.sink.interrupted()
    }

    @SuppressLint("MissingPermission") // Checked by start.
    private fun begin(sink: DictationSink) {
        val minimum = AudioRecord.getMinBufferSize(DICTATION_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minimum <= 0) { sink.failed(MicrophoneProblem.NoMicrophone); return }
        val record = try {
            // VOICE_RECOGNITION: the platform's tuning for speech to text, without the call path's processing.
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, DICTATION_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum, FRAME_SAMPLES * 2 * 4))
        } catch (error: Exception) {
            AppLog.log(TAG, "open failed: ${error.message}")
            sink.failed(MicrophoneProblem.Failed); return
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) { record.release(); sink.failed(MicrophoneProblem.Failed); return }
        try {
            record.startRecording()
        } catch (error: Exception) {
            AppLog.log(TAG, "start failed: ${error.message}")
            record.release(); sink.failed(MicrophoneProblem.Failed); return
        }
        recording = Recording(record, sink)
    }

    private class Recording(private val record: AudioRecord, val sink: DictationSink) {
        @Volatile private var running = true
        private val reader = thread(name = "dictation-mic") {
            val samples = ShortArray(FRAME_SAMPLES)
            try {
                while (running) {
                    var filled = 0
                    while (running && filled < FRAME_SAMPLES) {
                        val read = record.read(samples, filled, FRAME_SAMPLES - filled)
                        if (read < 0) { if (running) sink.failed(MicrophoneProblem.Failed); running = false; break }
                        filled += read
                    }
                    if (!running) break
                    val bytes = ByteArray(FRAME_SAMPLES * 2)
                    var squares = 0.0
                    for (i in 0 until FRAME_SAMPLES) {
                        val sample = samples[i].toInt()
                        bytes[i * 2] = sample.toByte()
                        bytes[i * 2 + 1] = (sample shr 8).toByte()
                        val unit = sample / 32768.0
                        squares += unit * unit
                    }
                    sink.frame(bytes, sqrt(squares / FRAME_SAMPLES).toFloat())
                }
            } finally {
                runCatching { record.stop() }
                record.release()
            }
        }

        /** Also stops the platform recorder, so a read waiting for audio returns at once. */
        fun stop() { running = false; runCatching { record.stop() } }
    }
}
