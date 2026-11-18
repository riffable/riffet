package riffet.ui.composer

import androidx.compose.runtime.Composable

/**
 * The microphone a composer's [DictationController] records with (docs/VOICE.md §7); null where this host cannot record.
 * The level a frame reports is its RMS, as the web's capture worklet measures it.
 */
@Composable
expect fun rememberDictationMicrophone(): DictationMicrophone?
