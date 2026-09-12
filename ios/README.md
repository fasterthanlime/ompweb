# Nook for iOS — first native slice

The app hosts Nook in a persistent WKWebView and supplies native microphone audio
through an explicit versioned bridge. The transcript, composer, visuals, auth
cookies, live dictation socket, and Stable words protocol remain in the web app.
No HTML or JavaScript is injected or patched by the shell.

## Build

Requires Xcode with an iOS SDK and XcodeGen:

```sh
cd ios
xcodegen generate
open Nook.xcodeproj
```

Select the Nook scheme and a simulator, or select a development signing team and
an attached iPhone. The bundle identifier is `rs.vxn.nook`; the minimum OS is iOS 18.
`project.yml` is the project source. Regenerate after editing it; do not edit or
commit the generated Xcode project.

```sh
xcodebuild -project Nook.xcodeproj -scheme Nook \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath /tmp/nook-ios-derived CODE_SIGNING_ALLOWED=NO test
```

`NOOK_SERVER_URL` and `NOOK_LOGIN_URL` in `project.yml` populate the generated
Info.plist.
Defaults are `https://omp-amos.vxn.rs/` and `https://auth.vxn.rs/`. Login navigation
is allowed, but only the exact Nook origin and main frame can access audio.
External links open outside the app. Cookie storage survives app launches.

For local development, override `NOOK_SERVER_URL` at build time with
a reachable development URL (for Simulator, `http://127.0.0.1:30178`).
Local networking is allowed; public servers still require HTTPS. Start the web server with
`OMP_WEB_PACKAGE_DIR` explicitly set to this source checkout. The local dictation
service must also be configured; the bridge does not embed a transcription service.

## Bridge contract and deployment handoff

Web changes: `lib/native-audio.ts`, `lib/dictation-live-capture.ts`, and
`components/DictationControl.tsx`; regression coverage: `lib/native-audio.test.mjs`.
Deploy these using the existing server release process. There are no new server
routes, secrets, provider settings, or changes to the wire transcription protocol.
Ordinary browsers continue through the existing browser capture path.

The updated web bundle detects `window.webkit.messageHandlers.nookAudioV1` and
calls its promise-based `postMessage({command, id})`. `id` is a fresh UUID per
recording. Commands:

- `start`: request app microphone permission, activate audio, reply `{version: 1}`.
- `read`: consume available base64 PCM, at most 96000 bytes per reply.
- `stop`: stop the engine, drain queued conversion, return final base64 PCM.
- `cancel`: release resources and discard queued PCM for the matching ID.

PCM is signed 16-bit little-endian, mono, 24000 Hz. The web client polls serially
at roughly 100 ms, retains PCM for local transcription retry and WAV download,
and uses the existing authenticated same-origin dictation WebSocket. It waits
for the live service readiness acknowledgement before native recording. Native
mode deliberately requires that live service and does not switch to Google.

The native engine bounds its callback stream and pending PCM, stops at five
minutes, and releases audio on navigation, app backgrounding, interruptions,
web-process termination, and controller disposal. Late permission replies and
commands from previous capture IDs cannot operate on a newer capture. Audio and
transcripts are not logged. Capture lifetime events use OSLog.

## Verification and remaining acceptance

The app builds for Simulator with Swift 6 isolation checking. Native tests convert
a known signal from 24/44.1/48 kHz and verify PCM duration and amplitude. Web tests
exercise final-frame draining, canceled permissions, late replies, invalid frames,
and exact retained WAV contents. These are not physical microphone verification.

The composer is still HTML. Public input-assistant groups are cleared, but this
is not proof that every iOS keyboard accessory is gone. Native composer work is
an independent next slice. Downloads, file pickers, external authentication
variants, and app restore need device acceptance too.

Before declaring the microphone issue fixed, deploy the web bridge, install on
the intended iPhone, and verify: first permission request; repeated recording and
app relaunch without another prompt; Immediate and Stable words; Stop vs Send;
cancellation while permission is open; lock/background/interruption and recovery;
retained retry on connection failure; and built-in/Bluetooth microphone routing.
No background recording entitlement or automatic background submission is enabled.

Production deployment remains owned by the server agent. This work does not
invoke deployment, confirmation, or rollback.

## Passkey association

The app declares `webcredentials:auth.vxn.rs` in its generated entitlements.
The auth service uses RP ID `auth.vxn.rs` and publishes
`https://auth.vxn.rs/.well-known/apple-app-site-association` with
`B2N6FSRTPV.rs.vxn.nook` in `webcredentials.apps`. The signed provisioning
profile must support Associated Domains. Regenerate and reinstall after changes;
physical passkey sign-in remains the acceptance check.
