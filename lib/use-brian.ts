"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getRecognitionCtor,
  speechSupport,
  type RecognitionEvent,
  type SpeechRecognitionLike,
} from "./speech-types";
import { detectWakeWord } from "./wake-word";
import { isDuplicateUtterance, shouldIgnoreAsEcho } from "./voice-guard";
import { newId, useConversation } from "./store";
import { compareVoice, clearProfile, loadProfile, saveProfile, VoiceSampler, type VoiceProfile } from "./voiceprint";
import type { AssistantAction, AssistantSettings, ChatMessage, ChatTurn } from "./types";

export type Phase = "idle" | "wake" | "listening" | "thinking" | "speaking" | "error";

const ENGAGED_TIMEOUT_MS = 20_000;
const RESTART_DELAY_MS = 320;
const WAKE_ACK_WINDOW_MS = 4_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Splits long answers so Chrome does not truncate them mid-sentence. */
function chunkText(text: string, max = 190): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return [clean];
  const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) ?? [clean];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if ((current + sentence).length > max && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function preferredVoice(
  voices: SpeechSynthesisVoice[],
  settings: AssistantSettings,
): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  if (settings.voiceURI) {
    const exact = voices.find((v) => v.voiceURI === settings.voiceURI);
    if (exact) return exact;
  }
  const sameLang = voices.filter((v) => v.lang.toLowerCase().startsWith(settings.language.slice(0, 2)));
  const pool = sameLang.length ? sameLang : voices;
  const ranked = ["natural", "neural", "google", "samantha", "ava", "jenny", "aria", "serena"];
  for (const needle of ranked) {
    const hit = pool.find((v) => v.name.toLowerCase().includes(needle));
    if (hit) return hit;
  }
  return pool.find((v) => v.localService) ?? pool[0];
}

export function useBrian(settings: AssistantSettings, updateSettings: (patch: Partial<AssistantSettings>) => void) {
  const router = useRouter();
  const { messages, append, clear: clearHistory, current: historyRef } = useConversation();

  const [phase, setPhase] = useState<Phase>("idle");
  const [micOn, setMicOn] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [aiMode, setAiMode] = useState<"ai" | "offline" | "unknown">("unknown");
  const [model, setModel] = useState<string | null>(null);
  const [voiceRejected, setVoiceRejected] = useState(false);
  const [heardNotForMe, setHeardNotForMe] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [profile, setProfile] = useState<VoiceProfile | null>(null);

  const supported = useMemo(() => speechSupport(), []);
  const isAndroid = useMemo(
    () => typeof navigator !== "undefined" && /android/i.test(navigator.userAgent),
    [],
  );

  const settingsRef = useRef(settings);
  const micOnRef = useRef(micOn);
  const engagedRef = useRef(engaged);
  const speakingRef = useRef(false);
  const lastSpokenRef = useRef("");
  /** Bumped on every new reply so an older chunk chain cannot resume. */
  const speakTokenRef = useRef(0);
  const speechEndedAtRef = useRef(0);
  const lastUtteranceRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const wakeAckRef = useRef(0);
  const busyRef = useRef(false);
  const profileRef = useRef<VoiceProfile | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const samplerRef = useRef<VoiceSampler | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handleUtteranceRef = useRef<(text: string) => void>(() => undefined);
  const submitRef = useRef<(text: string, source: "voice" | "typed") => void>(() => undefined);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    micOnRef.current = micOn;
  }, [micOn]);
  useEffect(() => {
    engagedRef.current = engaged;
  }, [engaged]);

  /* --------------------------- voices --------------------------- */
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener?.("voiceschanged", load);
    return () => synth.removeEventListener?.("voiceschanged", load);
  }, []);

  /* --------------------------- profile -------------------------- */
  useEffect(() => {
    const stored = loadProfile();
    if (stored) {
      setProfile(stored);
      profileRef.current = stored;
    }
  }, []);

  /* --------------------------- status --------------------------- */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { mode?: "ai" | "offline"; model?: string | null } | null) => {
        if (cancelled || !data?.mode) return;
        setAiMode(data.mode);
        setModel(data.model ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------- text to speech --------------------- */
  const speak = useCallback(
    (text: string) => {
      if (!("speechSynthesis" in window) || !text.trim()) return;
      const synth = window.speechSynthesis;
      // A new answer replaces the old one: invalidating the previous token stops
      // its chunk chain, so two replies can never talk over each other.
      const token = ++speakTokenRef.current;
      synth.cancel();
      const chunks = chunkText(text);
      const voice = preferredVoice(voices, settingsRef.current);
      speakingRef.current = true;
      lastSpokenRef.current = text;
      setPhase("speaking");

      let index = 0;
      const finish = () => {
        if (token !== speakTokenRef.current) return;
        speakingRef.current = false;
        speechEndedAtRef.current = Date.now();
        setPhase(engagedRef.current && micOnRef.current ? "listening" : micOnRef.current ? "wake" : "idle");
      };

      const speakNext = () => {
        if (token !== speakTokenRef.current) return; // superseded by a newer reply
        if (index >= chunks.length) {
          finish();
          return;
        }
        const utterance = new SpeechSynthesisUtterance(chunks[index++]);
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        } else {
          utterance.lang = settingsRef.current.language;
        }
        utterance.rate = clamp(settingsRef.current.rate, 0.5, 1.8);
        utterance.pitch = clamp(settingsRef.current.pitch, 0.5, 1.8);
        utterance.volume = clamp(settingsRef.current.volume, 0, 1);
        utterance.onend = speakNext;
        utterance.onerror = speakNext;
        synth.speak(utterance);
      };
      speakNext();
    },
    [voices],
  );

  const interrupt = useCallback(() => {
    speakTokenRef.current += 1;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    speakingRef.current = false;
    speechEndedAtRef.current = Date.now();
    setPhase(engagedRef.current ? "listening" : micOnRef.current ? "wake" : "idle");
  }, []);

  /* --------------------------- timers --------------------------- */
  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
  }, []);

  const armSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = window.setTimeout(() => {
      engagedRef.current = false;
      setEngaged(false);
      setInterim("");
      setPhase(micOnRef.current ? "wake" : "idle");
    }, ENGAGED_TIMEOUT_MS);
  }, [clearSilenceTimer]);

  const engage = useCallback(() => {
    engagedRef.current = true;
    setEngaged(true);
    armSilenceTimer();
  }, [armSilenceTimer]);

  const disengage = useCallback(() => {
    engagedRef.current = false;
    setEngaged(false);
    setInterim("");
    setPhase(micOnRef.current ? "wake" : "idle");
    clearSilenceTimer();
  }, [clearSilenceTimer]);

  /* --------------------------- actions -------------------------- */
  const stopListening = useCallback(() => {
    setMicOn(false);
    micOnRef.current = false;
    setInterim("");
    setPhase("idle");
    clearSilenceTimer();
    speakTokenRef.current += 1;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    speakingRef.current = false;
    speechEndedAtRef.current = Date.now();
  }, [clearSilenceTimer]);

  const startListening = useCallback(() => {
    if (!supported.recognition) {
      setError("This browser has no speech recognition. Chrome on Android works best — you can still type below.");
      return;
    }
    setError(null);
    setMicOn(true);
    micOnRef.current = true;
    setPhase("wake");
  }, [supported.recognition]);

  const toggleMic = useCallback(() => {
    if (micOnRef.current) stopListening();
    else startListening();
  }, [startListening, stopListening]);

  const handleAction = useCallback(
    (action?: AssistantAction) => {
      if (!action) return;
      if (action.type === "settings") {
        if (action.command === "stop-listening") stopListening();
        else if (action.command === "start-listening") startListening();
        else if (action.href) router.push(action.href);
      }
    },
    [router, startListening, stopListening],
  );

  const submit = useCallback(
    async (raw: string, source: "voice" | "typed") => {
      const text = raw.trim();
      if (!text || busyRef.current) return;
      busyRef.current = true;
      setInterim("");
      const userMessage: ChatMessage = {
        id: newId(),
        role: "user",
        content: text,
        at: Date.now(),
        source,
      };
      append(userMessage);
      setPhase("thinking");
      armSilenceTimer();

      const turns: ChatTurn[] = historyRef.current
        .slice(-16)
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: turns,
            settings: {
              assistantName: settingsRef.current.assistantName,
              personality: settingsRef.current.personality,
            },
            platform: isAndroid ? "android" : "web",
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            // Sent per request only; the server never stores or logs it.
            apiKey: settingsRef.current.apiKey || undefined,
            useCommunityModel: settingsRef.current.useCommunityModel !== false,
          }),
        });
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        const data = (await response.json()) as {
          reply?: string;
          mode?: "ai" | "offline";
          action?: AssistantAction;
          model?: string;
          note?: string;
        };
        const reply = (data.reply ?? "").trim() || "I'm here, but I didn't catch that.";
        append({
          id: newId(),
          role: "assistant",
          content: reply,
          at: Date.now(),
          mode: data.mode ?? "offline",
          action: data.action,
          note: data.note,
        });
        setAiMode(data.mode ?? "offline");
        if (data.model) setModel(data.model);
        handleAction(data.action);
        speak(reply);
      } catch {
        const fallback = "I couldn't reach my brain just now. Check the connection and try me again.";
        append({ id: newId(), role: "assistant", content: fallback, at: Date.now(), mode: "offline" });
        speak(fallback);
      } finally {
        busyRef.current = false;
      }
    },
    [append, armSilenceTimer, handleAction, historyRef, isAndroid, speak],
  );

  const sendText = useCallback(
    (text: string) => {
      void submit(text, "typed");
    },
    [submit],
  );

  const handleUtterance = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      const now = Date.now();

      // Chrome re-delivers the same final transcript, and a recognition restart
      // replays the tail of the last session. Answering each delivery is what
      // turned a single "Hi" into several replies.
      if (isDuplicateUtterance(lastUtteranceRef.current, text, now)) return;
      lastUtteranceRef.current = { text, at: now };

      // Never answer our own voice: not while speaking, and not during the short
      // window where the tail of our sentence is still being transcribed.
      if (
        shouldIgnoreAsEcho(
          text,
          lastSpokenRef.current,
          speakingRef.current,
          now - speechEndedAtRef.current,
        )
      ) {
        return;
      }
      if (speakingRef.current) interrupt(); // barge-in: the user cut me off

      const prof = profileRef.current;
      if (settingsRef.current.ownerOnly && prof) {
        const sample = samplerRef.current?.latest;
        if (sample) {
          const { match } = compareVoice(prof, sample);
          if (!match) {
            setVoiceRejected(true);
            window.setTimeout(() => setVoiceRejected(false), 4000);
            return;
          }
        }
      }

      if (!engagedRef.current) {
        const hit = detectWakeWord(text, settingsRef.current.wakeWord);
        if (!hit.matched) {
          setHeardNotForMe(true);
          window.setTimeout(() => setHeardNotForMe(false), 2200);
          return;
        }
        engage();
        wakeAckRef.current = now;
        if (hit.remainder) void submit(hit.remainder, "voice");
        else speak("Yes?");
        return;
      }

      // Interim results engage us before the final arrives, so the bare wake
      // word would otherwise be answered a second time.
      const again = detectWakeWord(text, settingsRef.current.wakeWord);
      if (again.matched && !again.remainder) {
        if (now - wakeAckRef.current < WAKE_ACK_WINDOW_MS) return;
        wakeAckRef.current = now;
        armSilenceTimer();
        speak("Yes?");
        return;
      }

      armSilenceTimer();
      void submit(text, "voice");
    },
    [armSilenceTimer, engage, interrupt, speak, submit],
  );

  useEffect(() => {
    handleUtteranceRef.current = handleUtterance;
    submitRef.current = (text, source) => void submit(text, source);
  }, [handleUtterance, submit]);

  /* ---------------------- speech recognition -------------------- */
  useEffect(() => {
    if (!micOn) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError("This browser can't do speech recognition. Chrome on Android works best — you can still type below.");
      setMicOn(false);
      micOnRef.current = false;
      return;
    }

    const recognition = new Ctor();
    recognition.lang = settingsRef.current.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: RecognitionEvent) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alternative = result?.[0];
        if (!alternative) continue;
        if (result.isFinal) finalText += `${alternative.transcript} `;
        else interimText += `${alternative.transcript} `;
      }
      const interimClean = interimText.trim();
      setInterim(interimClean);

      // Wake the assistant as soon as the wake word appears in interim speech.
      if (!engagedRef.current && interimClean) {
        const hit = detectWakeWord(interimClean, settingsRef.current.wakeWord);
        if (hit.matched) engage();
      }
      if (finalText.trim()) {
        setInterim("");
        handleUtteranceRef.current(finalText.trim());
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("Microphone access was blocked. Allow it in your browser settings to talk to me.");
        setMicOn(false);
        micOnRef.current = false;
        setPhase("idle");
      }
      // "no-speech", "aborted" and "network" are normal; onend restarts us.
    };

    recognition.onend = () => {
      if (!micOnRef.current) return;
      if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = window.setTimeout(() => {
        if (!micOnRef.current) return;
        try {
          recognition.start();
        } catch {
          /* already starting */
        }
      }, RESTART_DELAY_MS);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setPhase("wake");
    } catch {
      /* start() can throw if called twice */
    }

    return () => {
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    };
  }, [micOn, engage]);

  /* --------------------- owner-voice sampler -------------------- */
  useEffect(() => {
    const shouldSample = micOn && settings.ownerOnly && Boolean(profile);
    if (!shouldSample) {
      samplerRef.current?.stop();
      samplerRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      return;
    }
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const sampler = new VoiceSampler(stream);
        samplerRef.current = sampler;
        void sampler.start();
      })
      .catch(() => {
        setError("I couldn't open a second audio stream for voice matching. Owner-only mode is paused.");
      });

    return () => {
      cancelled = true;
      samplerRef.current?.stop();
      samplerRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [micOn, settings.ownerOnly, profile]);

  const enrollVoice = useCallback(async (seconds = 5): Promise<boolean> => {
    setEnrolling(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const sampler = new VoiceSampler(stream);
      await sampler.start();
      await new Promise((resolve) => window.setTimeout(resolve, seconds * 1000));
      const snapshot = sampler.snapshot();
      sampler.stop();
      stream.getTracks().forEach((track) => track.stop());
      if (!snapshot) {
        setError("I didn't hear enough speech to learn your voice. Try again and say a full sentence.");
        return false;
      }
      saveProfile(snapshot);
      setProfile(snapshot);
      profileRef.current = snapshot;
      return true;
    } catch {
      setError("Microphone access was blocked, so I couldn't capture your voice.");
      return false;
    } finally {
      setEnrolling(false);
    }
  }, []);

  const removeVoiceProfile = useCallback(() => {
    clearProfile();
    setProfile(null);
    profileRef.current = null;
    updateSettings({ ownerOnly: false });
  }, [updateSettings]);

  const clearConversation = useCallback(() => {
    clearHistory();
    disengage();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    speakingRef.current = false;
  }, [clearHistory, disengage]);

  useEffect(() => {
    return () => {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
      if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current);
    };
  }, []);

  return {
    messages,
    phase,
    micOn,
    engaged,
    interim,
    error,
    voices,
    aiMode,
    model,
    voiceRejected,
    heardNotForMe,
    enrolling,
    profile,
    supported,
    isAndroid,
    startListening,
    stopListening,
    toggleMic,
    sendText,
    interrupt,
    speak,
    clearConversation,
    enrollVoice,
    removeVoiceProfile,
    disengage,
  };
}
