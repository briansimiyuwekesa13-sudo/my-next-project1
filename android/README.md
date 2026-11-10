# Brian — Android app (source)

This folder contains the native Android client for Brian. It is a **source-only**
deliverable: it has not been compiled, packaged or tested on a device in this
environment, because Android SDK tooling and emulators are not available here.

The web app in the repository root is the runnable, deployed experience. The
Android module adds what the browser cannot do:

| Capability | Android implementation |
| --- | --- |
| Background listening | `BrianService` — a microphone foreground service with a persistent, user-dismissible notification |
| Wake word | `WakeWordDetector` — on-device audio energy + zero-crossing/pitch matching, no audio leaves the device |
| Natural speech | Android `SpeechRecognizer` (free-form dictation, not commands) |
| Natural voice | `TextToSpeech` with the user's chosen installed voice, plus barge-in cancellation |
| Phone actions | `PhoneActions` — calls, app launch, alarms, calendar reminders, notification reading, settings |
| Owner voice | `VoiceEnrollment` — local pitch/brightness profile used to gate responses |
| AI + memory | `ChatClient` — posts the rolling conversation to `/api/chat` on the deployed web app |

## Dependency scanning

The repository's dependency security check resolves the web app's npm packages,
but it cannot resolve this module. Gradle lockfiles are absent, and producing
them requires a Gradle toolchain and the Android SDK — neither exists in the
environment where the web app is built and deployed. So the Android module is
reported as **uncovered**, not as clean.

To close that gap on a machine with Android Studio (or a Gradle install):

```bash
# from android/
# 1. Enable dependency locking once, in app/build.gradle.kts:
#    android { dependencyLocking { lockAllConfigurations() } }
# 2. Generate the wrapper, then the lockfiles
gradle wrapper --gradle-version 8.9
./gradlew dependencies --write-locks
```

Commit the resulting `gradle.lockfile` files. The scanner can then evaluate the
resolved Android dependencies, and this module stops being a coverage gap.

## Build

```bash
# from android/
export ANDROID_HOME=/path/to/Android/sdk
./gradlew assembleDebug     # requires the Gradle wrapper (see note below)
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Notes:

- Add a Gradle wrapper (`gradle wrapper --gradle-version 8.9`) or open the folder
  in Android Studio, which generates it.
- Set the assistant endpoint in `BrianSettings`/`strings.xml`
  (`brian_endpoint`) to your deployed URL, e.g. `https://your-app.appjet.app`.
- The app targets Android 14 (API 34). Microphone foreground services require
  `FOREGROUND_SERVICE_MICROPHONE` (declared) and runtime
  `RECORD_AUDIO` permission (requested at runtime).

## Privacy behaviour

- Nothing is recorded unless the user has explicitly enabled listening; the
  foreground notification is always visible while the microphone is open.
- Wake-word detection runs entirely on-device over a rolling PCM window.
- Conversation history is stored in app-private `SharedPreferences` and can be
  cleared from the settings screen.
- Notification access is opt-in via `NotificationListenerService` and used only
  to read aloud what the user asks for.
