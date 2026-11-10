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

The repository's dependency security check resolves the web app's npm packages
(80 packages, 0 findings) but it cannot resolve this module: Gradle lockfiles are
absent, and producing them needs a Gradle toolchain plus the Android SDK, neither
of which exists in the environment where the web app is built and deployed. The
scan therefore reports this module as **uncovered / incomplete** — a coverage gap,
not a clean result.

### What was checked directly

Every dependency coordinate declared by this module was queried against the
public OSV advisory database (`POST https://api.osv.dev/v1/query`, ecosystem
`Maven`). The single build-time artifact that could not be queried here is
recorded below the table, so this list is not mistaken for full coverage:

| Coordinate | Version | Advisories |
| --- | --- | --- |
| androidx.core:core-ktx | 1.13.1 | none |
| androidx.lifecycle:lifecycle-runtime-ktx | 2.8.5 | none |
| androidx.activity:activity-compose | 1.9.2 | none |
| androidx.compose.ui:ui | 1.7.2 | none |
| androidx.compose.material3:material3 | 1.3.0 | none |
| androidx.datastore:datastore-preferences | 1.1.1 | none |
| org.jetbrains.kotlinx:kotlinx-coroutines-android | 1.8.1 | none |
| com.squareup.okhttp3:okhttp | 4.12.0 | none |
| com.android.tools.build:gradle (AGP) | 8.5.2 | none |
| org.jetbrains.kotlin:kotlin-gradle-plugin | 2.0.20 | **GHSA-r937-wjx7-w2jp / CVE-2026-53914** |

### Not queried: the Compose compiler extension

`composeOptions.kotlinCompilerExtensionVersion = "1.5.15"` in
`app/build.gradle.kts` resolves `androidx.compose.compiler:compiler:1.5.15` at
build time. It is deliberately absent from the table above: an OSV lookup needs
an outbound request, and outbound requests from the sandbox used to build this
repository are restricted. The managed scanner cannot reach it either without a
resolved lockfile. It is a Kotlin compiler plugin that runs only while compiling
and is never packaged into the APK, so it does not ship to users. To finish the
direct inventory, run this from a machine with network access:

```bash
curl -s -X POST https://api.osv.dev/v1/query \
  -H 'Content-Type: application/json' \
  -d '{"package":{"name":"androidx.compose.compiler:compiler","ecosystem":"Maven"},"version":"1.5.15"}'
```

### Known advisory: Kotlin Gradle Plugin

GHSA-r937-wjx7-w2jp ("Unsafe Deserialization in Kotlin Build Cache Enables Code
Execution") affects `kotlin-gradle-plugin` for every release below `2.4.20-Beta1`.
No stable fixed release exists yet — the only fix is a beta. It is a **build-time**
issue: it requires local access from a high-privileged actor and is triggered by
deserialising build-cache entries, so it is not shipped in the APK and is not
reachable by the assistant's users.

This project does not enable the Gradle build cache (no `gradle.properties`, no
`org.gradle.caching` or `buildCache` configuration), so the vulnerable path is not
active. Moving Kotlin from 2.0.20 to a 2.4.x beta would be an unverifiable major
toolchain migration for a source-only module, so the version is deliberately left
at 2.0.20 — revisit when a stable 2.4.x is released.

### What remains uncovered

The transitive graph behind these coordinates is still unscanned; only the direct
declarations above were resolved. To close that fully, generate real lockfiles on
a machine with Android Studio (or a Gradle install):

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
