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
