# Brian — AI voice assistant

Talk to your phone naturally. Say **“Hey Brian”**, speak in plain language, and get
an immediate spoken answer. No buttons, no fixed commands.

Two deliverables live in this repository:

| Path | What it is |
| --- | --- |
| repository root | The runnable **web/PWA** app (Next.js). Deployed and installable to the Android home screen. |
| `android/` | A **native Android (Kotlin)** module for true background wake-word service, call placing, alarm/reminder intents and notification reading. Source-only in this environment. |

---

## What it does

**Voice recognition**
- Continuous listening once the microphone is armed.
- Customisable wake word (default “Hey Brian”, tolerant of accents, homophones and
  mis-transcriptions).
- Natural language — “what’s the weather gonna be like”, “call my sister”, “remind me
  in twenty minutes”, “open spotify”.
- Owner-voice recognition: enrol your voice once and Brian ignores other speakers.
- Recognises when you are talking to someone else and stays quiet.

**Voice responses**
- Prefers natural, neural voices installed on the device and rejects obvious
  robotic ones.
- Speak over Brian to interrupt — it stops immediately (barge-in).
- Hands-free conversation: after answering, it re-opens the microphone so you can
  keep talking without touching the phone.

**Intelligence**
- `/api/chat` proxies a language model when `OPENAI_API_KEY` is configured, with
  conversation context and a friendly personality.
- With no key, a genuine on-device intent engine still handles time, dates, calls,
  alarms, reminders, app launching, settings, maths, timers, jokes and small talk —
  so the app is never a dead demo.
- Conversation memory is stored on the device and can be cleared at any time.

**Background**
- A persistent notification is required while the microphone is open; listening
  stops when you turn it off.
- The Android service survives app minimisation and restarts after reboot when the
  user left it enabled.
- Android 14+ note: a true always-on wake word needs the
  `FOREGROUND_SERVICE_MICROPHONE` service, which is what the Kotlin module uses. The
  web app can only listen while its tab/PWA is active — that is a browser platform
  limit, not a design choice.

**Phone integration**
- Calls (`tel:` / `ACTION_CALL`), app launching, alarms, reminders, time and date,
  supported settings shortcuts, notification reading (opt-in), and web search.

**Privacy**
- Never records secretly: an always-visible indicator and an explicit “Stop” control.
- Wake-word matching happens locally; audio is not uploaded for wake detection.
- The voice profile stores averaged acoustic numbers only — never audio.
- Notification access and microphone are opt-in, revocable, and explained in the UI.

---

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000
npm run build && npm start
```

Optional AI mode:

```bash
OPENAI_API_KEY=sk-...        # enables the language-model path
OPENAI_MODEL=gpt-4o-mini     # optional override
```

Without a key the app runs in offline mode; `/api/status` reports which mode is
active.

## Using it on Android

1. Open the deployed URL in Chrome and choose **Add to Home screen** — it installs
   as a standalone PWA with its own icon.
2. Allow the microphone when prompted, pick a voice and a wake word in **Settings**.
3. Arm listening with the microphone button and say the wake word.

For always-on background wake word, call placement and notification reading, build
the native module — see [`android/README.md`](android/README.md).

## Layout

```
app/
  page.tsx            conversation screen (orb, transcript, mic, actions)
  settings/page.tsx   voice, wake word, personality, privacy, owner voice
  api/chat/route.ts   AI proxy with rate limiting + offline fallback
  api/status/route.ts which brain is active
  globals.css         futuristic dark theme
lib/
  assistant.ts        intent engine, offline answers, system prompt
  wake-word.ts        local wake-word matching + echo rejection
  use-brian.ts        voice engine: recognition, TTS, barge-in, turn taking
  voiceprint.ts       on-device owner-voice sampling
  store.ts            persisted settings + conversation
android/              Kotlin module (service, wake word, TTS, actions)
```

## Honest limitations

- Browser speech recognition support varies; Chrome on Android is the best target.
  A text input is always available as a fallback.
- The web app cannot listen while fully closed; the Android module exists for that.
- Owner-voice matching is an acoustic heuristic, not biometric security.
- The Kotlin module is not compiled or device-tested in this environment.
