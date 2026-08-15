Pod::Spec.new do |s|
  s.name           = 'RidikWidgets'
  s.version        = '1.0.0'
  s.summary        = 'Hands the home-screen widget its snapshot.'
  s.description    = 'Writes the published WidgetSnapshot into the shared App Group and asks WidgetKit to redraw.'
  s.license        = 'MIT'
  s.author         = 'Ridik'
  s.homepage       = 'https://github.com/milar111/ridik'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  # A local module is installed by path, so nothing is ever fetched from here.
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Relative to this file, so only the module's own Swift is compiled into the
  # app. The widget extension's sources live in `targets/RidikWidget/` and are
  # built by a second Xcode target — sweeping them in here would try to compile
  # a `@main` WidgetBundle into the application binary.
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
