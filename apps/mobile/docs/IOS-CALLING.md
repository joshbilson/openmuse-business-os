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

The bundle ID is `au.com.wineandlarder.openmuse`, under Apple Development team `6L9MH922NF`. The config plugin enables microphone access, background audio/VoIP/remote notifications, and `aps-environment=development`. Set `EXPO_APNS_ENVIRONMENT=production` **before prebuild** for a production-signed build, and use matching APNs server credentials and token environment. Do not ship a development-entitled build as production. A simulator build checks packaging and the ordinary interface; PushKit, real APNs delivery, phone audio routing, locked-screen calls, and cellular transitions require a signed physical iPhone build.

On 23 September 2026 the Release simulator build completed with bundled JavaScript and the `:10001` URL. Its local artifact is `/Users/joshua/Library/Developer/Xcode/DerivedData/OpenMuse-eykxkrewucovdecnojmuowtqbrvc/Build/Products/Release-iphonesimulator/OpenMuse.app`. It installed and launched on the iOS 26.5 iPhone 17 Pro simulator. The welcome screen appeared; a lingering simulator deep-link confirmation prompt covered part of the screenshot at `/tmp/openmuse-release-simulator-10001.png`. Web, iOS, and Android JavaScript exports also completed with the same API URL. This is a packaging and startup check only.

## Call continuity

The call screen monitors WebRTC/ICE and the provider data channel after setup. It also checks the authenticated Oracle call record every five seconds, because the provider's media path can remain open after Oracle loses its control connection. A brief media or Oracle outage shows **Reconnecting** and may recover within 15 seconds on the existing session. A failed connection, closed provider session/data channel, server-ended call, or prolonged outage ends microphone, native CallKit call, and Oracle session. **Call again** starts a new provider session and call ID in the same conversation. The client does not attempt an unsupported provider renegotiation or record raw audio.

## Current signing gate

The connected iPhone is an iPhone 16 Pro Max (`iPhone111`). A local Apple Development certificate for team `6L9MH922NF` exists, but Xcode currently has no usable account session or development profile for this bundle ID. A device build with `-allowProvisioningUpdates` failed with:

> No Accounts: Add a new account in Accounts settings.
>
> No profiles for 'au.com.wineandlarder.openmuse' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'au.com.wineandlarder.openmuse'.

After the owner signs into the matching Apple Developer account in Xcode, verify that the App ID has Push Notifications and the required VoIP/CallKit background capabilities, then let Xcode create a matching development profile. An APNs `.p8` filename on disk is not proof that its key, team, bundle entitlement, or VoIP topic is configured correctly. Register actual alert and VoIP tokens from the signed device before testing pushes.

## Physical-device acceptance

- Sign in to the private OpenMuse server over Tailscale. Verify both alert and VoIP device registrations on the server, and that neither access keys nor APNs tokens appear in a generated UI.
- Place an outbound call. Confirm the native CallKit screen, simultaneous microphone and received audio, transcript persistence, clean hangup, and accurate call state after an API/network failure.
- Receive a VoIP push while the app is foregrounded, backgrounded, locked, and terminated. Confirm iOS presents the incoming call promptly before JavaScript starts; answer and decline each state. A stale or expired invitation must not open a microphone session.
- During an active call, lock the screen and switch between Wi-Fi and cellular. Verify two-way audio, CallKit mute, speaker/earpiece, Bluetooth headset, interruption handling, and end on either side.
- Receive an ordinary task notification, open its target thread/activity, rotate/reinstall token state, and verify expired owner authentication reports connection unavailable rather than showing a live call.

These are pending physical acceptance checks. Successful simulator compilation, JavaScript export, or a screenshot does not establish real incoming-call delivery or full-duplex audio.
