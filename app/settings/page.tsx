"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { clearHistory, useSettings } from "@/lib/store";
import { DEFAULT_SETTINGS, type Personality } from "@/lib/types";
import { VoiceSampler, clearProfile, loadProfile, saveProfile, type VoiceProfile } from "@/lib/voiceprint";

const WAKE_SUGGESTIONS = ["Hey Brian", "Hey Sophie", "Computer", "Okay Jarvis", "Hey Assistant"];

const LANGUAGES = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "en-AU", label: "English (Australia)" },
  { value: "es-ES", label: "Español" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "hi-IN", label: "हिन्दी" },
];

const PERSONALITIES: { value: Personality; label: string }[] = [
  { value: "friendly", label: "Friendly — warm, chatty, a little playful" },
  { value: "concise", label: "Concise — short, straight answers" },
  { value: "warm", label: "Warm — calm and reassuring" },
];

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="row" style={{ padding: "12px 0", borderTop: "1px solid rgba(126,158,214,0.1)" }}>
      <div className="grow">
        <strong style={{ fontSize: 13.5 }}>{label}</strong>
        <div className="sub" style={{ color: "var(--muted)", fontSize: 11.5, lineHeight: 1.5 }}>
          {hint}
        </div>
      </div>
      <button
        type="button"
        className={`toggle ${checked ? "is-on" : ""}`}
        aria-pressed={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export default function SettingsPage() {
  const { settings, update, reset, ready } = useSettings();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [ai, setAi] = useState<{ mode: string; model: string | null } | null>(null);
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  useEffect(() => {
    setProfile(loadProfile());
    let cancelled = false;
    fetch("/api/status")
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setAi(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const preview = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(
      `Hi, I'm ${settings.assistantName}. This is how I sound when we talk.`,
    );
    const voice = window.speechSynthesis.getVoices().find((item) => item.voiceURI === settings.voiceURI);
    if (voice) utterance.voice = voice;
    utterance.lang = settings.language;
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.volume = settings.volume;
    window.speechSynthesis.speak(utterance);
  }, [settings]);

  const enrol = async () => {
    if (enrolling) return;
    setNotice(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setNotice("This browser can't access the microphone for voice enrolment.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const sampler = new VoiceSampler(stream);
      await sampler.start();
      setEnrolling(true);
      setNotice("Speak normally for a few seconds — try “Hey Brian, what's on my schedule today?”");

      window.setTimeout(() => {
        const snapshot = sampler.snapshot();
        sampler.stop();
        stream.getTracks().forEach((track) => track.stop());
        setEnrolling(false);
        if (!snapshot) {
          setNotice("I didn't catch enough speech. Try again somewhere quieter.");
          return;
        }
        saveProfile(snapshot);
        setProfile(snapshot);
        setNotice(`Voice profile saved from ${snapshot.samples} samples. Only averaged pitch data is stored.`);
      }, 5000);
    } catch {
      setEnrolling(false);
      setNotice("Microphone permission was denied, so I can't create a voice profile.");
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <span className="brand">
          {settings.assistantName}
          <small>settings</small>
        </span>
        <span className="topbar-spacer" />
        <Link href="/" className="btn">
          Back to talking
        </Link>
      </header>

      <div className="page-head">
        <div>
          <h1>Make it yours</h1>
          <p>Wake word, voice, listening behaviour and privacy — all stored on this device.</p>
        </div>
      </div>

      {notice && <div className="notice notice--good">{notice}</div>}

      <section className="card">
        <h2>Assistant</h2>
        <p className="hint">What it's called and how it talks to you.</p>

        <div className="field">
          <label htmlFor="name">Assistant name</label>
          <input
            id="name"
            type="text"
            value={settings.assistantName}
            maxLength={24}
            onChange={(event) => update({ assistantName: event.target.value })}
            placeholder="Brian"
          />
        </div>

        <div className="field">
          <label htmlFor="personality">Personality</label>
          <select
            id="personality"
            value={settings.personality}
            onChange={(event) => update({ personality: event.target.value as Personality })}
          >
            {PERSONALITIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="card">
        <h2>Wake word</h2>
        <p className="hint">
          Say it from anywhere in the room — the home screen, another app, or with the screen off (Android).
        </p>
        <div className="field">
          <label htmlFor="wake">Wake phrase</label>
          <input
            id="wake"
            type="text"
            value={settings.wakeWord}
            maxLength={32}
            onChange={(event) => update({ wakeWord: event.target.value })}
          />
          <div className="sub">Two or three syllables works best — “Hey Brian”, “Hey Sophie”, “Computer”.</div>
        </div>
        <div className="chips">
          {WAKE_SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="chip-suggest"
              onClick={() => update({ wakeWord: suggestion })}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Voice</h2>
        <p className="hint">Pick an installed voice, then tune how it sounds.</p>

        <div className="field">
          <label htmlFor="voice">Speaking voice</label>
          <select id="voice" value={settings.voiceURI} onChange={(event) => update({ voiceURI: event.target.value })}>
            <option value="">Automatic — best natural voice</option>
            {voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} ({voice.lang}){voice.localService ? " · on device" : ""}
              </option>
            ))}
          </select>
          <div className="sub">
            {voices.length === 0
              ? "No voices reported yet — they load once the browser finishes preparing speech."
              : `${voices.length} voices available. On-device voices work offline.`}
          </div>
        </div>

        <div className="field">
          <label htmlFor="language">Language</label>
          <select id="language" value={settings.language} onChange={(event) => update({ language: event.target.value })}>
            {LANGUAGES.map((language) => (
              <option key={language.value} value={language.value}>
                {language.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="rate">Speed — {settings.rate.toFixed(2)}×</label>
          <input
            id="rate"
            type="range"
            min={0.6}
            max={1.6}
            step={0.02}
            value={settings.rate}
            onChange={(event) => update({ rate: Number(event.target.value) })}
          />
        </div>

        <div className="field">
          <label htmlFor="pitch">Pitch — {settings.pitch.toFixed(2)}</label>
          <input
            id="pitch"
            type="range"
            min={0.5}
            max={1.6}
            step={0.02}
            value={settings.pitch}
            onChange={(event) => update({ pitch: Number(event.target.value) })}
          />
        </div>

        <div className="field">
          <label htmlFor="volume">Volume — {Math.round(settings.volume * 100)}%</label>
          <input
            id="volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.volume}
            onChange={(event) => update({ volume: Number(event.target.value) })}
          />
        </div>

        <div className="btn-row">
          <button type="button" className="btn btn--primary" onClick={preview}>
            Hear this voice
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Listening</h2>
        <p className="hint">Background listening keeps the microphone open for the wake word only.</p>

        <Toggle
          checked={settings.continuousListening}
          onChange={(next) => update({ continuousListening: next })}
          label="Background listening"
          hint="Stay armed for the wake word after answering, so you never press a button. A live indicator is always shown."
        />

        <Toggle
          checked={settings.ownerOnly}
          onChange={(next) => update({ ownerOnly: next })}
          label="Respond only to my voice"
          hint="Compares a local acoustic profile before answering. Enrol your voice below to switch this on."
        />

        <div className="field">
          <label>Owner voice profile</label>
          <div className="sub">
            {profile
              ? `Saved · ${profile.samples} samples · average pitch ${Math.round(profile.pitch)} Hz`
              : "No profile yet. Enrol to let Brian recognise you."}
          </div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={enrol} disabled={enrolling}>
              {enrolling ? "Listening… speak now" : profile ? "Re-enrol my voice" : "Enrol my voice"}
            </button>
            {profile && (
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  clearProfile();
                  setProfile(null);
                  update({ ownerOnly: false });
                  setNotice("Voice profile deleted from this device.");
                }}
              >
                Delete profile
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Intelligence</h2>
        <p className="hint">
          {ai?.mode === "ai"
            ? `Connected to ${ai.model ?? "an AI model"} for open-ended conversation, with on-device fallback.`
            : ai?.mode === "offline"
              ? "Running the on-device brain: time, alarms, reminders, calls, apps, settings and small talk all work without a model key."
              : "Checking which brain is available…"}
        </p>
        <div className="sub" style={{ color: "var(--muted)", fontSize: 11.5, lineHeight: 1.6 }}>
          Conversation context is kept for the current chat only, and history stays on this device.
        </div>
      </section>

      <section className="card">
        <h2>Privacy</h2>
        <p className="hint">Brian never records secretly, and you can see exactly when the mic is open.</p>
        <ul className="privacy-list">
          <li>The live bar and the orb both show when the microphone is active.</li>
          <li>Wake-word matching happens on the device before anything is sent.</li>
          <li>Speech is only sent for an answer after you address the assistant.</li>
          <li>No audio is ever stored — the voice profile keeps averaged numbers only.</li>
          <li>Notification reading is opt-in and used only when you ask for it.</li>
        </ul>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              clearHistory();
              setNotice("Conversation history cleared from this device.");
            }}
          >
            Clear conversation history
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              reset();
              setNotice("Settings restored to defaults.");
            }}
          >
            Reset settings
          </button>
        </div>
        {!ready && <div className="sub">Loading saved settings…</div>}
      </section>

      <p className="foot">
        Installed as a home-screen app, Brian keeps the same conversation and settings. On Android, the native module in{" "}
        <code>android/</code> adds background wake-word listening, calls, alarms and notification reading — see{" "}
        <code>android/README.md</code>. Defaults: {DEFAULT_SETTINGS.assistantName} · “{DEFAULT_SETTINGS.wakeWord}”.
      </p>
    </main>
  );
}
