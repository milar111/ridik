Pod::Spec.new do |s|
  s.name           = 'RidikSpeech'
  s.version        = '1.0.0'
  s.summary        = 'On-device transcription through Apple SpeechAnalyzer.'
  s.description    = 'Runs one utterance through SpeechAnalyzer/SpeechTranscriber, which is local, free and measures four times fewer word errors than SFSpeechRecognizer.'
  s.license        = 'MIT'
  s.author         = 'Ridik'
  s.homepage       = 'https://github.com/milar111/ridik'
  # The app's own floor, not the framework's. Everything that touches
  # SpeechAnalyzer is behind `@available(iOS 26.0, *)` and the module reports
  # `isSupported: false` below it, so this pod builds and links on iOS 16.4.
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  # A local module is installed by path, so nothing is ever fetched from here.
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
