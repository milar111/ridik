/**
 * What the voice layer can do here, answerable without loading the voice layer.
 *
 * One `Platform` check, in its own file, for a reason that has bitten this
 * module twice. `./stt` is exercised under plain Node by the `logic` project,
 * so a `react-native` import at the top of it takes three suites down with a
 * parse error naming none of them; and the barrel in `./index` reaches
 * `expo-speech-recognition`, so a *screen* that imports it to ask one boolean
 * fails to render in tests with "Cannot find native module".
 *
 * Both of those are the same mistake — a cheap question answered through an
 * expensive door. This file imports nothing but `react-native`.
 */
import { Platform } from 'react-native';

/**
 * What to ask the recogniser for when the audio is wanted afterwards.
 *
 * Passed straight through to `recordingOptions`, which is why the platform
 * knowledge is here rather than in `./stt`: that module is loaded under plain
 * Node and cannot read `Platform` at all.
 *
 * The target is **16 kHz mono 16-bit PCM**, because that is what whisper.cpp
 * reads and what an upload engine wants. Android already writes exactly that —
 * it is the format it feeds the recognition service — and ignores these two
 * fields. iOS does not: left alone it records at the input node's own rate,
 * which is 44.1 or 48 kHz of 32-bit float, so the fields are what put the two
 * platforms on one format instead of leaving a resample for later.
 */
export type KeptAudio = {
  persist: true;
  outputSampleRate?: number;
  outputEncoding?: 'pcmFormatInt16';
};

/**
 * Whether the recogniser can hand over the audio it heard, and how.
 *
 * `null` means it cannot, and everything downstream then degrades to the
 * recogniser answering alone — which is what the app did before any of this
 * existed.
 *
 * **Android 13 is a hard floor.** Below `TIRAMISU` the recognition library
 * skips its whole recording block — it cannot pass
 * `RecognizerIntent.EXTRA_AUDIO_SOURCE`, so there is no single stream to tee
 * between the recognition service and a file — and asking anyway is worse than
 * not asking: `recordingOptions` is accepted and *silently ignored*, so a
 * caller waits for a file that is never written. `minSdk` here is 26, so this
 * is a real split in the fleet and not a formality.
 *
 * **iOS needs no version gate**, because the library's own deployment target
 * is 16.4 and so is this app's. What it needs instead is the format above.
 */
export function keptAudioOptions(): KeptAudio | null {
  if (Platform.OS === 'android') {
    return Number(Platform.Version) >= 33 ? { persist: true } : null;
  }
  if (Platform.OS === 'ios') {
    return { persist: true, outputSampleRate: 16_000, outputEncoding: 'pcmFormatInt16' };
  }
  return null;
}

/** Whether an upgrade engine has any audio to work from here. */
export function canCaptureAudio(): boolean {
  return keptAudioOptions() !== null;
}
