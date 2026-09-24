Pod::Spec.new do |s|
  s.name           = 'VoipCall'
  s.version        = '0.1.0'
  s.summary        = 'Native PushKit and CallKit support for OpenMuse'
  s.description    = s.summary
  s.license        = { :type => 'MIT' }
  s.author         = 'OpenMuse'
  s.homepage       = 'https://github.com/CopilotKit/OpenMuse'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.source_files   = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.dependency 'JitsiWebRTC', '~> 124.0.0'
  s.frameworks = 'CallKit', 'PushKit', 'AVFoundation', 'Security'
end
