/**
 The Expo half of on-device transcription. All of the work is in
 `SpeechAnalyzerSession.swift`; this file is the wire.

 It stays thin for one reason: nothing in it can be compiled without
 `ExpoModulesCore`, and the engine underneath it can — so the engine is
 verifiable outside an app build and this is not. Keep the split.

 ## One session, refused rather than queued

 The microphone is a single global resource and so is the analyzer. A second
 `start` while one is running is a bug in the caller, and answering it by
 tearing down the first would lose an utterance somebody is halfway through
 saying. `src/voice/apple.ts` aborts before it starts, exactly as `stt.ts`
 does with the platform recogniser.
 */
import ExpoModulesCore

public class RidikSpeechModule: Module {
  /**
   Held for the life of the module rather than per call, because `stop()` and
   `abort()` arrive as separate JavaScript calls and have to find the session
   that `start()` created.
   */
  private var session: Any?

  public func definition() -> ModuleDefinition {
    Name("RidikSpeech")

    Events("onPartial", "onStart")

    /**
     Whether this build can transcribe on the phone at all.

     A constant rather than a function: it cannot change while the process
     lives, and `src/voice/stt.ts` reads it on the way into every utterance.
     */
    Property("isSupported") { () -> Bool in
      guard #available(iOS 26.0, *) else { return false }
      return SpeechAnalyzerSession.isSupported
    }

    /**
     Can this phone transcribe this language, and is the model here yet.

     `{ locale, status }` in one round trip, because the caller asks it on the
     way into an utterance and two hops is latency before anything listens.
     */
    AsyncFunction("describe") { (locale: String) -> [String: Any] in
      guard #available(iOS 26.0, *) else { return ["status": "unsupported"] }
      let availability = await SpeechAnalyzerSession.describe(locale)
      // Keys are omitted rather than set to `nil`. A `[String: Any?]` crossing
      // the bridge is a conversion this app cannot test — no simulator has the
      // analyzer — and a `stop()` that rejected on serialising an *absent
      // confidence* would look exactly like a failed transcription. The JS side
      // normalises the missing key to `null`.
      var payload: [String: Any] = ["status": availability.status]
      if let locale = availability.locale { payload["locale"] = locale }
      return payload
    }

    /// Fetches the model so a *later* utterance can use it. Never called in
    /// front of one — see `install` in `SpeechAnalyzerSession.swift`.
    AsyncFunction("install") { (locale: String) in
      guard #available(iOS 26.0, *) else {
        throw SpeechFailureException(SpeechAnalyzerFailure.unsupported)
      }
      do {
        try await SpeechAnalyzerSession.install(locale)
      } catch {
        throw Self.wrap(error)
      }
    }

    AsyncFunction("start") { (locale: String, contextualStrings: [String]) in
      guard #available(iOS 26.0, *) else {
        throw SpeechFailureException(SpeechAnalyzerFailure.unsupported)
      }
      if self.session != nil { throw SpeechFailureException(SpeechAnalyzerFailure.busy) }

      let session = SpeechAnalyzerSession()
      // Captured weakly: the module outlives any one utterance, and a strong
      // capture here would keep a finished session alive through its own
      // event closures.
      session.onPartial = { [weak self] text in
        self?.sendEvent("onPartial", ["text": text])
      }
      session.onStart = { [weak self] in
        self?.sendEvent("onStart", [:])
      }
      self.session = session

      do {
        try await session.start(locale: locale, contextualStrings: contextualStrings)
      } catch {
        // A start that failed owns no microphone, so the slot has to be freed
        // or every later attempt answers `busy` for the life of the process.
        self.session = nil
        throw Self.wrap(error)
      }
    }

    /**
     Ends the utterance and returns it.

     `confidence` is *absent* rather than 0 when the analyzer reported none —
     `evaluateTranscript` treats a low number as "badly heard" and an absent
     one as "unknown", and those are different answers.
     */
    AsyncFunction("stop") { () -> [String: Any] in
      guard #available(iOS 26.0, *), let session = self.session as? SpeechAnalyzerSession else {
        return ["text": ""]
      }
      defer { self.session = nil }
      do {
        let result = try await session.finish()
        var payload: [String: Any] = ["text": result.text]
        if let confidence = result.confidence { payload["confidence"] = confidence }
        return payload
      } catch {
        throw Self.wrap(error)
      }
    }

    /// Gives the microphone back and reports nothing. Safe when idle.
    AsyncFunction("abort") {
      guard #available(iOS 26.0, *), let session = self.session as? SpeechAnalyzerSession else {
        return
      }
      self.session = nil
      await session.abort()
    }

    OnDestroy {
      guard #available(iOS 26.0, *), let session = self.session as? SpeechAnalyzerSession else {
        return
      }
      self.session = nil
      // The module is going away; the microphone must not go with it.
      Task { await session.abort() }
    }
  }

  /// Keeps the failure's own code and sentence rather than flattening both to
  /// "something went wrong" — `apple.ts` branches on the code.
  private static func wrap(_ error: Error) -> Exception {
    if let failure = error as? SpeechAnalyzerFailure {
      return SpeechFailureException(failure)
    }
    return SpeechUnknownException(error.localizedDescription)
  }
}

/**
 A failure the JavaScript side can branch on.

 The `code` is deliberately the same vocabulary `expo-speech-recognition`
 emits (`language-not-supported`, `not-allowed`, `audio-capture`, `busy`) so
 that `toSttError`'s existing mapping in `src/voice/stt.ts` covers both engines
 rather than growing a second table that can drift from the first.

 **Deliberately not `@available(iOS 26.0, *)`.** It stores a
 `SpeechAnalyzerFailure` and reads two strings off it, so there is no iOS 26 API
 in here — and gating it made the `else` branch of every
 `guard #available(iOS 26.0, *)` uncompilable, which is precisely the branch
 that has to report "this OS cannot do it". Annotate what actually touches the
 framework and nothing else.
 */
internal final class SpeechFailureException: Exception {
  private let failure: SpeechAnalyzerFailure

  init(_ failure: SpeechAnalyzerFailure) {
    self.failure = failure
    super.init()
  }

  override var code: String { "ERR_SPEECH_\(failure.code.uppercased().replacingOccurrences(of: "-", with: "_"))" }
  override var reason: String { failure.message }
}

internal final class SpeechUnknownException: GenericException<String> {
  override var code: String { "ERR_SPEECH_ANALYZER" }
  override var reason: String { param }
}
