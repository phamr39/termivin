# Termivin mobile

Flutter app (Android + iOS) for managing the terminals and AI agents running
in Termivin on your PC — through the relay you host
([`server/`](../server/README.md)). Design: [`docs/REMOTE.md`](../docs/REMOTE.md).

| Tab | What it is for |
| --- | --- |
| **Inbox** | Everything waiting for you: permission prompts (with the exact options read from the PC's screen), questions between agents nobody answered, terminals that crashed, PCs that went offline |
| **Chat** | Each workspace is a group chat, each terminal a character you can message. Prompt mode types your message into the agent when it is idle (queued while it is busy); bus mode leaves it in the agent's mailbox. Claude Code's replies and tool steps appear as they happen |
| **Workspaces** | Every terminal with its live status and what it is doing; resume, restart (keep session), stop, rename, change Claude's permission mode, start new terminals |
| **Terminal** | The real screen, live, at the PC's size; quick keys (Esc, Enter, 1/2/3, y/n, arrows, ⇧Tab, ^C); a keyboard when the phone has the `input` scope |
| **Activity / System** | Agent traffic timeline; PCs, paired phones, revoke, audit log, unpair |

## Install

**Android** — a ready APK is built by `flutter build apk --release`
(`build/app/outputs/flutter-apk/app-release.apk`; `--split-per-abi` gives a
smaller `app-arm64-v8a-release.apk` for phones). Copy it to the phone and
open it (allow installing from this source). The release build is signed
with the debug key — fine for sideloading; see *Publishing* for store builds.

**iOS** — needs a Mac with Xcode (iOS builds cannot be made on Windows):

```bash
cd mobile
flutter pub get
cd ios && pod install && cd ..
open ios/Runner.xcworkspace     # set your Team under Signing & Capabilities
flutter run --release           # to a connected iPhone
```

Bundle id `com.termivin.mobile`, deployment target iOS 15.5 (camera scanning).

## Develop

```bash
flutter pub get
flutter analyze
flutter test
flutter run          # emulator/simulator or a device
```

Against a relay on the same PC, the Android emulator reaches it at
`http://10.0.2.2:8787` — put that in the desktop's *Address the phone uses*
field before showing the pairing code, or edit it on the pairing screen.

## Push notifications (optional)

The app talks to the relay over a WebSocket while it is open. To be alerted
when it is closed, set up Firebase Cloud Messaging:

1. Create a Firebase project; add an Android app (`com.termivin.mobile`) and
   an iOS app; upload your APNs key for iOS.
2. `dart pub global activate flutterfire_cli && flutterfire configure` in
   `mobile/`, add `firebase_core` + `firebase_messaging`, and send the FCM
   token to the relay with `{"t":"push.register","token":…,"platform":…}`
   (the relay already stores it and sends pushes).
3. On the server, mount the service-account JSON and set
   `RELAY_FCM_SERVICE_ACCOUNT` (see `server/README.md`).

This is left as a step because it needs your own Firebase project; the relay
side is done.

## Publishing

- Android: create an upload keystore and a `key.properties`, reference it in
  `android/app/build.gradle.kts` (`signingConfigs`), then
  `flutter build appbundle`.
- iOS: `flutter build ipa` on a Mac, upload with Transporter/Xcode.
