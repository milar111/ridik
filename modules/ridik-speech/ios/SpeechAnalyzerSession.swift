/**
 One utterance through Apple's `SpeechAnalyzer`, which is the best English
 recogniser on this platform and is neither the one this app was using nor a
 paid one.

 ## Why this file exists at all

 `SFSpeechRecognizer` measures 9.02% word error rate on clean speech and
 16.25% on hard audio. `SpeechAnalyzer`, on the same audio, measures 2.12% and
 4.56% — roughly a four-fold reduction, for free, on the phone, with nothing
 uploaded. It also beats the cloud engine this app can be pointed at
 (AssemblyAI's 4.7% on noisy audio) while adding no recipient to the consent
 screen and costing nothing per utterance.

 ## Deliberately free of `ExpoModulesCore`

 Everything here is `Speech` and `AVFoundation`. `RidikSpeechModule.swift` is
 the only file that knows this is an Expo module, and it is thin on purpose:
 this one can then be compiled against the simulator SDK as a plain executable
 and *run*, transcribing a file, which is how an iOS 26 speech path is
 verified on the host against real models.

 ## The shape of the API, and why it is a class of closures

 `SpeechAnalyzer` is an actor and `SpeechTranscriber.results` is an
 `AsyncSequence`, so the natural expression is one task reading results and
 handing them out. The audio tap is the one thing that runs on a real-time
 thread, and all it touches is `AsyncStream.Continuation.yield` — which is
 documented as safe to call from anywhere and never blocks. Nothing else is
 shared with it.
 */
import AVFoundation
import Foundation
import Speech

/// A failure with a code the JavaScript side can branch on. The message is
/// what a person reads, so it names a way forward wherever there is one.
enum SpeechAnalyzerFailure: Error {
  case unsupported
  case localeUnsupported(String)
  case assets(String)
  case microphoneDenied
  case audio(String)
  case analyzer(String)
  case busy

  var code: String {
    switch self {
    case .unsupported: return "unsupported"
    case .localeUnsupported: return "language-not-supported"
    case .assets: return "assets"
    case .microphoneDenied: return "not-allowed"
    case .audio: return "audio-capture"
    case .analyzer: return "analyzer"
    case .busy: return "busy"
    }
  }

  var message: String {
    switch self {
    case .unsupported:
      return "This iPhone cannot run on-device transcription."
    case .localeUnsupported(let locale):
      return "On-device transcription has no model for \(locale)."
    case .assets(let detail):
      return "Could not prepare the on-device speech model. \(detail)"
    case .microphoneDenied:
      return "Ridik needs microphone access to listen."
    case .audio(let detail):
      return "Something interrupted the microphone. \(detail)"
    case .analyzer(let detail):
      return "On-device transcription failed. \(detail)"
    case .busy:
      return "Already listening."
    }
  }
}

/// What a finished utterance carries back.
struct SpeechAnalyzerResult: Sendable {
  let text: String
  /**
   A real 0..1 reading, which `SFSpeechRecognizer` mostly declines to give and
   Android almost never does. It is the mean over the transcript's runs
   weighted by how much text each one covers — see `confidence(of:)`.
   */
  let confidence: Double?
}

/// Whether this phone can do it, and whether it can do it *now*.
struct SpeechAnalyzerAvailability: Sendable {
  /// The locale the framework resolved the request to, or nil if it has none.
  let locale: String?
  /// `unsupported` | `supported` (a download away) | `downloading` | `installed`
  let status: String
}

@available(iOS 26.0, *)
final class SpeechAnalyzerSession {
  /// A partial transcript, for the caption under the microphone.
  var onPartial: (@Sendable (String) -> Void)?
  /// The recogniser has the microphone and is listening.
  var onStart: (@Sendable () -> Void)?

  private let engine = AVAudioEngine()
  private var analyzer: SpeechAnalyzer?
  private var transcriber: SpeechTranscriber?
  private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
  private var resultsTask: Task<Void, Never>?
  private var tapped = false
  private var sessionActive = false

  /**
   Everything finalised so far, in order.

   With `.volatileResults` on, the transcriber reports a moving tail that keeps
   being rewritten and then freezes a prefix of it as final. Keeping the two
   apart is what lets the caption show the whole sentence as it is being said
   while only the frozen half is ever treated as heard.
   */
  private var finalized: [String] = []
  private var volatile = ""
  private var weightedConfidence = 0.0
  private var confidenceWeight = 0.0
  private var failure: SpeechAnalyzerFailure?

  /// True when the framework is present and this OS is new enough to have it.
  static var isSupported: Bool {
    SpeechTranscriber.isAvailable
  }

  /**
   Can this phone transcribe this language, and is the model here yet.

   One call rather than two, because it sits in front of the microphone: the
   caller asks this on the way into an utterance, and two round trips to a
   native module is latency spent before anything is listening.

   The locale is *asked for* rather than compared. The framework maps a request
   onto its own supported set, so `en-GB` may well be served by `en-US`, and a
   caller matching identifiers itself would refuse a locale that works.
   */
  static func describe(_ identifier: String) async -> SpeechAnalyzerAvailability {
    guard isSupported else { return SpeechAnalyzerAvailability(locale: nil, status: "unsupported") }
    let wanted = Locale(identifier: identifier)
    guard let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
      return SpeechAnalyzerAvailability(locale: nil, status: "unsupported")
    }
    let transcriber = SpeechTranscriber(locale: resolved, preset: .progressiveTranscription)
    let status: String
    switch await AssetInventory.status(forModules: [transcriber]) {
    case .unsupported: status = "unsupported"
    case .supported: status = "supported"
    case .downloading: status = "downloading"
    case .installed: status = "installed"
    @unknown default: status = "unsupported"
    }
    return SpeechAnalyzerAvailability(locale: resolved.identifier(.bcp47), status: status)
  }

  /**
   Downloads the model for a locale, so that a *later* utterance can use it.

   Called instead of listening, never before it. A first run whose model is
   missing uses the old recogniser for that utterance and starts this in the
   background — because the alternative is a microphone that appears to hang
   for as long as a download takes, which is the one thing a voice app cannot
   do to its first sentence.
   */
  static func install(_ identifier: String) async throws {
    guard isSupported else { throw SpeechAnalyzerFailure.unsupported }
    let wanted = Locale(identifier: identifier)
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
      throw SpeechAnalyzerFailure.localeUnsupported(identifier)
    }
    let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    try await installAssets(for: transcriber, locale: locale)
  }

  /**
   Starts listening. The transcript arrives through `finish()`.

   **It refuses rather than downloading.** An earlier version installed assets
   here, which put a model download inside the path that opens the microphone —
   the one thing this design exists to avoid. `describe()` is what the caller
   asks first, and it only starts when the answer is `installed`; if the model
   has gone away in between, failing fast is right, because `src/voice/stt.ts`
   answers a start failure with the platform recogniser and the user carries on
   talking. Waiting would be a microphone that appears to hang.

   The results task is reading before the engine starts, so nothing spoken in
   the first moments is dropped.
   */
  func start(locale identifier: String, contextualStrings: [String]) async throws {
    guard Self.isSupported else { throw SpeechAnalyzerFailure.unsupported }
    guard analyzer == nil else { throw SpeechAnalyzerFailure.busy }
    guard AVAudioApplication.shared.recordPermission == .granted else {
      throw SpeechAnalyzerFailure.microphoneDenied
    }

    let wanted = Locale(identifier: identifier)
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
      throw SpeechAnalyzerFailure.localeUnsupported(identifier)
    }

    /*
     `.volatileResults` is what makes a live caption possible, and it is the
     whole reason this engine can replace the recogniser rather than sit under
     it as a rescue: the upload engines in `assemblyai.ts` and `whisper.ts`
     cannot produce partials at all.

     `.transcriptionConfidence` costs nothing and buys the review gate a real
     number — `wasPoorlyHeard` in `src/llm/confirm.ts` has been working from
     `null` on this platform since it was written.
     */
    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [.volatileResults],
      attributeOptions: [.transcriptionConfidence]
    )
    self.transcriber = transcriber

    try await Self.requireInstalled(transcriber, locale: locale)

    let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    guard let format else {
      throw SpeechAnalyzerFailure.analyzer("No compatible audio format.")
    }

    let (stream, builder) = AsyncStream<AnalyzerInput>.makeStream()
    inputBuilder = builder

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    self.analyzer = analyzer

    /*
     The user's own proper nouns. `src/voice/dictionary.ts` is the fix for the
     one error the rest of the pipeline cannot recover from, and it survives
     this engine intact: `AnalysisContext.contextualStrings` is a
     `[ContextualStringsTag: [String]]` and `.general` is the tag for exactly
     this (checked against the SDK's `.swiftinterface`).
     */
    if !contextualStrings.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings = [.general: contextualStrings]
      try await analyzer.setContext(context)
    }

    startReadingResults(from: transcriber)

    // Warms the model so the first word is not the slow one. Advisory: a
    // failure here costs latency, not the utterance.
    try? await analyzer.prepareToAnalyze(in: format)

    do {
      try await analyzer.start(inputSequence: stream)
    } catch {
      await teardown()
      throw SpeechAnalyzerFailure.analyzer(error.localizedDescription)
    }

    do {
      try startAudio(converting: format)
    } catch let error as SpeechAnalyzerFailure {
      await teardown()
      throw error
    } catch {
      await teardown()
      throw SpeechAnalyzerFailure.audio(error.localizedDescription)
    }

    onStart?()
  }

  /**
   Ends the utterance and returns everything that was heard.

   `finalizeAndFinishThroughEndOfInput` is what turns the moving tail into a
   final result, so this waits for it rather than reporting the volatile text:
   the last few words of most sentences are only ever volatile, and returning
   them unfinalised would ship the recogniser's first guess as its answer.
   */
  func finish() async throws -> SpeechAnalyzerResult {
    guard let analyzer else { throw SpeechAnalyzerFailure.analyzer("Nothing is listening.") }

    stopAudio()
    inputBuilder?.finish()
    inputBuilder = nil

    do {
      try await analyzer.finalizeAndFinishThroughEndOfInput()
    } catch {
      // Whatever was already finalised is still worth having; a transport
      // failure at the end of an utterance must not discard the sentence.
      failure = failure ?? .analyzer(error.localizedDescription)
    }

    await resultsTask?.value
    let result = collect()
    let raised = failure
    await teardown()

    // Only when there is nothing to show for it. A sentence that arrived and
    // then hit an error on the way out is a sentence, exactly as it is for the
    // Galaxy S23's farewell `ERROR_CLIENT` in `src/voice/stt.ts`.
    if let raised, result.text.isEmpty { throw raised }
    return result
  }

  /// Throws the utterance away and gives the microphone back. Reports nothing.
  func abort() async {
    stopAudio()
    inputBuilder?.finish()
    inputBuilder = nil
    if let analyzer { await analyzer.cancelAndFinishNow() }
    await teardown()
  }

  /* ----------------------------------------------------------- internals -- */

  /**
   The model has to be here already — see `start()`.

   Reserving is what stops the OS reclaiming it, and it is deliberately never
   released: the reservation is the app saying "keep English on this phone",
   which is true between utterances as much as during one. Releasing it at the
   end of every session, which an earlier version did, made it protect only the
   session it could not have been reclaimed during anyway. Best effort, because
   a phone already at `maximumReservedLocales` still transcribes.
   */
  private static func requireInstalled(_ transcriber: SpeechTranscriber, locale: Locale) async throws {
    guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
      throw SpeechAnalyzerFailure.assets("The on-device model for \(locale.identifier(.bcp47)) is not installed.")
    }
    _ = try? await AssetInventory.reserve(locale: locale)
  }

  /// Static so `install()` and `requireInstalled()` share the asset rules.
  @discardableResult
  private static func installAssets(
    for transcriber: SpeechTranscriber,
    locale: Locale
  ) async throws -> Locale? {
    switch await AssetInventory.status(forModules: [transcriber]) {
    case .installed:
      break
    case .unsupported:
      throw SpeechAnalyzerFailure.localeUnsupported(locale.identifier(.bcp47))
    case .supported, .downloading:
      /*
       A model download, not a recording: nothing the user said, or has ever
       said, is part of this request. So it adds no recipient to the consent
       screen and is allowed on the path where the audio may not leave the
       phone — which is the point of it. Before this, a declined-consent
       iPhone with no downloaded dictation model got
       `NO_OFFLINE_VOICE_MESSAGE` and no way forward; now it can fetch the
       thing that makes the promise keepable.
       */
      do {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
          try await request.downloadAndInstall()
        }
      } catch {
        throw SpeechAnalyzerFailure.assets(error.localizedDescription)
      }
    @unknown default:
      throw SpeechAnalyzerFailure.localeUnsupported(locale.identifier(.bcp47))
    }

    // Reserving is what stops the OS reclaiming the model between launches.
    // Best effort: a phone at `maximumReservedLocales` still transcribes.
    return (try? await AssetInventory.reserve(locale: locale)) == true ? locale : nil
  }

  private func startReadingResults(from transcriber: SpeechTranscriber) {
    resultsTask = Task { [weak self] in
      do {
        for try await result in transcriber.results {
          guard let self else { return }
          let text = String(result.text.characters)
          if result.isFinal {
            self.noteFinal(text, confidence: SpeechConfidence.mean(of: result.text))
          } else {
            self.noteVolatile(text)
          }
        }
      } catch {
        guard let self else { return }
        // Cancellation is `abort()` doing its job, not a failure to report.
        if !(error is CancellationError) {
          self.failure = .analyzer(error.localizedDescription)
        }
      }
    }
  }

  private func noteFinal(_ text: String, confidence: Double?) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    volatile = ""
    guard !trimmed.isEmpty else { return }
    finalized.append(trimmed)
    if let confidence {
      let weight = Double(trimmed.count)
      weightedConfidence += confidence * weight
      confidenceWeight += weight
    }
    onPartial?(joined())
  }

  private func noteVolatile(_ text: String) {
    volatile = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let caption = joined()
    guard !caption.isEmpty else { return }
    onPartial?(caption)
  }

  /// Finalised text plus the tail still being revised — what is on screen.
  private func joined() -> String {
    (finalized + (volatile.isEmpty ? [] : [volatile]))
      .joined(separator: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /**
   The finalised sentence and how well it was heard.

   The volatile tail is deliberately included: `finish()` finalises through the
   end of input before calling this, so anything still volatile at that point
   is a fragment the analyzer never got to freeze — and most of a sentence is
   worth more than none of it, which is the same call `store.ts` makes when it
   keeps a dying recogniser's last partial in `recovered`.
   */
  private func collect() -> SpeechAnalyzerResult {
    let text = joined()
    let confidence = confidenceWeight > 0 ? weightedConfidence / confidenceWeight : nil
    return SpeechAnalyzerResult(text: text, confidence: confidence)
  }

  private func startAudio(converting format: AVAudioFormat) throws {
    let session = AVAudioSession.sharedInstance()
    do {
      /*
       `.record` rather than `.playAndRecord`: this session only listens, and
       taking the playback route as well would duck other audio for no reason.
       `.measurement` was the other candidate and is wrong here — it disables
       the input processing chain, and the word-error figures this engine was
       chosen for were measured on ordinarily processed audio.
       */
      try session.setCategory(.record, mode: .default)
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      sessionActive = true
    } catch {
      throw SpeechAnalyzerFailure.audio(error.localizedDescription)
    }

    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0 else {
      throw SpeechAnalyzerFailure.audio("The input node reported no format.")
    }
    guard let converter = AVAudioConverter(from: inputFormat, to: format) else {
      throw SpeechAnalyzerFailure.audio("Cannot convert the microphone's format.")
    }

    // Both captures are `Sendable` and the tap is called serially on one audio
    // thread, so this closure shares nothing with the rest of the class:
    // yielding to a continuation is safe from any thread by construction.
    let builder = inputBuilder

    input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
      guard let converted = Self.convert(buffer, with: converter, to: format) else { return }
      builder?.yield(AnalyzerInput(buffer: converted))
    }
    tapped = true

    engine.prepare()
    do {
      try engine.start()
    } catch {
      throw SpeechAnalyzerFailure.audio(error.localizedDescription)
    }
  }

  /**
   One microphone buffer in the analyzer's format.

   The block-based `convert` is the only one that handles a sample-rate change,
   which this almost always is — the input node runs at the hardware rate and
   `bestAvailableAudioFormat` asks for the model's.
   */
  private static func convert(
    _ buffer: AVAudioPCMBuffer,
    with converter: AVAudioConverter,
    to format: AVAudioFormat
  ) -> AVAudioPCMBuffer? {
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1024
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      return nil
    }

    var consumed = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, outStatus in
      if consumed {
        outStatus.pointee = .noDataNow
        return nil
      }
      consumed = true
      outStatus.pointee = .haveData
      return buffer
    }

    guard status != .error, output.frameLength > 0 else { return nil }
    return output
  }

  private func stopAudio() {
    if engine.isRunning { engine.stop() }
    if tapped {
      engine.inputNode.removeTap(onBus: 0)
      tapped = false
    }
    if sessionActive {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      sessionActive = false
    }
  }

  private func teardown() async {
    stopAudio()
    resultsTask?.cancel()
    resultsTask = nil
    analyzer = nil
    transcriber = nil
    inputBuilder?.finish()
    inputBuilder = nil
    finalized.removeAll()
    volatile = ""
    weightedConfidence = 0
    confidenceWeight = 0
    failure = nil
  }
}
