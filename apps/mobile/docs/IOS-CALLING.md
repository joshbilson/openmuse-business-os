# iPhone calling: build and acceptance

OpenMuse's iOS app uses direct WebRTC for simultaneous microphone and playback, a local Expo module for PushKit and CallKit, and direct APNs tokens for ordinary notifications. The iOS implementation requires a custom native build; Expo Go cannot run it. The server is the only holder of model and APNs credentials. The app uses the owner's authenticated `/api/voice/*` routes, and saves its own session secret in the iOS Keychain for an incoming call that opens the app from a stopped state.

## Build

Use the private API URL at build time because Expo embeds `EXPO_PUBLIC_API_URL` in the JavaScript bundle. From the repository root:

```sh
pnpm install --frozen-lockfile
cd apps/mobile
EXPO_PUBLIC_API_URL=https://oracle.your-tailnet.ts.net:10001 pnpm exec expo prebuild --platform ios --no-install
cd ios
pod install
EXPO_PUBLIC_API_URL=https://oracle.your-tailnet.ts.net:10001 xcodebuild -workspace OpenMuse.xcworkspace -scheme OpenMuse -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The bundle ID is `au.com.wineandlarder.openmuse`, under Apple Developer team `K5AYLYH9GW`. The config plugin enables microphone access, background audio/VoIP/remote notifications, and defaults to `aps-environment=development`. Set `EXPO_APNS_ENVIRONMENT=production` **before prebuild** for an Ad Hoc or other distribution-signed build, and use matching APNs server credentials and token environment. Do not ship a development-entitled build as production. A simulator build checks packaging and the ordinary interface; PushKit, real APNs delivery, phone audio routing, locked-screen calls, and cellular transitions require a signed physical iPhone build.

Apps built with the iOS 27 SDK must adopt [UIKit's scene lifecycle](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle). The original Expo 54 native template compiled and installed, but the physical iPhone's crash report identified UIKit's missing-scene-lifecycle assertion at launch. `plugins/with-ios-scene-lifecycle.js` adds the scene manifest and delegate during prebuild, retains one React root, and preserves Expo's app delegate subscribers for PushKit and notifications. A background launch without a window scene also starts that root so queued CallKit events can reach JavaScript. Keep these changes in the plugin and its Swift template; generated `ios/` files are disposable.

For the registered iPhone, the local Ad Hoc profile and existing Apple Distribution identity allow a manually signed Release build without an Xcode account session. After the profile is installed locally, build from `apps/mobile/ios`:

```sh
EXPO_APNS_ENVIRONMENT=production EXPO_PUBLIC_API_URL=https://oracle.your-tailnet.ts.net:10001 xcodebuild \
  -workspace OpenMuse.xcworkspace -scheme OpenMuse -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=K5AYLYH9GW \
  CODE_SIGN_IDENTITY='Apple Distribution: Joshua Bilson (K5AYLYH9GW)' \
  PROVISIONING_PROFILE_SPECIFIER='OpenMuse Wine and Larder iPhone Ad Hoc 2026-09-24' build
```

On 23 September 2026 the Release simulator build completed with bundled JavaScript and the `:10001` URL. Its local artifact is `/Users/joshua/Library/Developer/Xcode/DerivedData/OpenMuse-eykxkrewucovdecnojmuowtqbrvc/Build/Products/Release-iphonesimulator/OpenMuse.app`. It installed and launched on the iOS 26.5 iPhone 17 Pro simulator. The welcome screen appeared; a lingering simulator deep-link confirmation prompt covered part of the screenshot at `/tmp/openmuse-release-simulator-10001.png`. Web, iOS, and Android JavaScript exports also completed with the same API URL. This is a packaging and startup check only.

## Call continuity

The call screen monitors WebRTC/ICE and the provider data channel after setup. It also checks the authenticated Oracle call record every five seconds, because the provider's media path can remain open after Oracle loses its control connection. A brief media or Oracle outage shows **Reconnecting** and may recover within 15 seconds on the existing session. A failed connection, closed provider session/data channel, server-ended call, or prolonged outage ends microphone, native CallKit call, and Oracle session. **Call again** starts a new provider session and call ID in the same conversation. The client does not attempt an unsupported provider renegotiation or record raw audio.

## Physical signing

The connected iPhone is an iPhone 16 Pro Max (`iPhone111`) with Developer Mode enabled. The exact App ID is registered on team `K5AYLYH9GW` with Push Notifications enabled. A dedicated iOS Ad Hoc profile for that iPhone contains the existing Apple Distribution certificate and grants `aps-environment=production`. The profile is installed locally for manual signing. For a physical Release build, prebuild with `EXPO_APNS_ENVIRONMENT=production`, then use that Ad Hoc profile and matching distribution identity; do not rely on Xcode automatic signing to select another team. On 24 September 2026, the Release build containing the scene lifecycle fix succeeded and installed on the connected iPhone with the expected bundle ID, team, profile, and signed production APNs entitlement. The owner confirmed the replacement welcome screen; the app stayed running and the private workspace was also observed after sign-in. Both production alert and VoIP registrations reached Oracle. One real foreground incoming call rang and its answer reached Oracle, but no audio session was created. Audio connection and the remaining state matrix are still acceptance gates; an APNs-accepted ordinary notification has not yet been confirmed visible on the device. An APNs `.p8` filename on disk is not proof that its key, team, bundle entitlement, or VoIP topic is configured correctly. Register actual alert and VoIP tokens from the signed device before testing pushes.

## Physical-device acceptance

- Sign in to the private OpenMuse server over Tailscale. Verify both alert and VoIP device registrations on the server, and that neither access keys nor APNs tokens appear in a generated UI.
- Place an outbound call. Confirm the native CallKit screen, simultaneous microphone and received audio, transcript persistence, clean hangup, and accurate call state after an API/network failure.
- Receive a VoIP push while the app is foregrounded, backgrounded, locked, and not running after system termination. Confirm iOS presents the incoming call promptly before JavaScript starts; answer and decline each state. A stale or expired invitation must not open a microphone session.
- Test a deliberate user force-quit separately from system termination. Record push delivery, CallKit presentation, answer behavior, and any required manual reopening independently; do not infer that one terminated-state result covers the other.
- For a cold launch, measure time from answering CallKit to connected audio, including saved-key access, server authentication, and workspace loading. After reboot, distinguish the period before the first unlock from later locked-screen calls: the saved workspace key uses `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` and cannot authenticate before that first unlock.
- During an active call, lock the screen and switch between Wi-Fi and cellular. Verify two-way audio, CallKit mute, speaker/earpiece, Bluetooth headset, interruption handling, and end on either side.
- Receive an ordinary task notification, open its target thread/activity, rotate/reinstall token state, and verify expired owner authentication reports connection unavailable rather than showing a live call.

Only startup, workspace sign-in, production token registration, and one foreground incoming ring/answer have been observed on the physical phone. The other checks remain pending, and that call did not establish audio. Successful simulator compilation, JavaScript export, or a screenshot does not establish full-duplex audio.
