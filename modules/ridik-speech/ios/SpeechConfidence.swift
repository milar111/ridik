/**
 How well a transcript was heard, as one number.

 Its own file, and free of `AVFAudio`, for two reasons. It is the only pure
 arithmetic in this module — everything else is a microphone, an audio session
 or an actor — and being pure it is the only part that can be *checked*: a
 host bench compiles this exact file against real models and prints what it
 returns, on macOS as well as in the simulator, because `AVAudioSession` does
 not exist on macOS and would make the whole session file uncompilable there.

 So this is the shipped function the bench measures, not a copy of it.
 */
import Foundation
import Speech

@available(iOS 26.0, macOS 26.0, *)
enum SpeechConfidence {
  /**
   The mean over the transcript's runs, weighted by how much text each covers.

   `src/voice/stt.ts` takes the *minimum* across segments, and that is right
   there because a segment is a clause. Here a run can be a single word, so a
   minimum would report the worst word in the sentence as the confidence of the
   whole sentence — against a 0.7 threshold that rejects almost everything,
   which is a working recogniser made to look broken.

   `nil` rather than 0 when nothing reported: `evaluateTranscript` reads a low
   number as "badly heard" and an absent one as "unknown", and those are
   different answers. Requires `.transcriptionConfidence` in the transcriber's
   `attributeOptions`; without it every run is bare and this is always `nil`.
   */
  static func mean(of text: AttributedString) -> Double? {
    var total = 0.0
    var weight = 0.0
    for run in text.runs {
      guard let value = run.transcriptionConfidence else { continue }
      let length = Double(text[run.range].characters.count)
      guard length > 0 else { continue }
      total += value * length
      weight += length
    }
    return weight > 0 ? total / weight : nil
  }
}
