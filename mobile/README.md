# Termivin mobile

Flutter app (Android + iOS) for managing the terminals and AI agents running
in Termivin on your PC — through the relay you host
([`server/`](../server/README.md)). Design: [`docs/REMOTE.md`](../docs/REMOTE.md).

Laid out like Telegram:

- **Chat list** with folder tabs — *All*, *Needs you* (approvals, unanswered asks, crashes), one per workspace. Each workspace is a group chat, each terminal a character; rows show who is working ("working · ▶ npm test…") or waiting on you.
- **Chats**: your messages are typed into the agent when it is idle (or left as bus mail); while it works a pinned bar shows progress; when it finishes you get **one summary** (headline, full reply and steps on inline buttons). Prompts waiting on you arrive as bot messages with inline buttons.
- **Profile** of a terminal (tap the chat header): Chat / Terminal / Restart / Stop, session title, folder, permission mode.
- **Terminal**: the real screen, live, with quick keys.
- **Drawer**: switch PCs like accounts, Workspaces, Activity, Settings (paired phones, audit, unpair).

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
