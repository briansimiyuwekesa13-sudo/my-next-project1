"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useBrian } from "@/lib/use-brian";
import { useSettings } from "@/lib/store";
import type { AssistantAction } from "@/lib/types";

const SUGGESTIONS = [
  "What time is it?",
  "Set an alarm for 7:30 am",
  "Open YouTube",
  "Remind me in 20 minutes",
  "Call 555 0134",
  "Tell me a joke",
];

function ActionCard({ action }: { action: AssistantAction }) {
  const [notifNote, setNotifNote] = useState<string | null>(null);

  const requestNotifications = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setNotifNote("This browser has no notification support.");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setNotifNote(
        permission === "granted"
          ? "Notification access granted — the Android build can now read them aloud."
          : "Permission was not granted, so I can't read notifications.",
      );
    } catch {
      setNotifNote("The browser blocked the permission prompt.");
    }
  };

  return (
    <div className="action-card">
      {action.type === "notifications" ? (
        <button type="button" onClick={requestNotifications}>
          {action.label}
        </button>
      ) : action.href ? (
        <a href={action.href} target={action.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
          {action.label}
        </a>
      ) : (
        <button type="button" onClick={() => setNotifNote(action.detail ?? "Nothing else to do here.")}>
          {action.label}
        </button>
      )}
      {(notifNote ?? action.detail) && <p>{notifNote ?? action.detail}</p>}
    </div>
  );
}

export default function Home() {
  const { settings, update, ready } = useSettings();
  const brian = useBrian(settings, update);
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [brian.messages.length, brian.interim, brian.phase]);

  // Resume hands-free listening on load when the user left it enabled and the
  // browser already trusts us with the microphone.
  useEffect(() => {
    if (!ready || !settings.continuousListening || brian.micOn) return;
    let cancelled = false;
    const permissions = navigator.permissions;
    if (!permissions?.query) return;
    permissions
      .query({ name: "microphone" as PermissionName })
      .then((status) => {
        if (!cancelled && status.state === "granted") brian.startListening();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ready, settings.continuousListening, brian.micOn, brian.startListening]);

  const status = useMemo(() => {
    if (brian.error) {
      return { title: "Microphone unavailable", sub: brian.error };
    }
    switch (brian.phase) {
      case "listening":
        return { title: "I'm listening", sub: "Speak naturally — no buttons, no commands." };
      case "thinking":
        return { title: "Thinking…", sub: "Pulling that together for you." };
      case "speaking":
        return { title: "Speaking", sub: "Talk over me any time — I'll stop and listen." };
      case "wake":
        return {
          title: `Say “${settings.wakeWord}”`,
          sub: "Listening for the wake word only. Nothing is recorded or uploaded.",
        };
      default:
        return {
          title: `Hi, I'm ${settings.assistantName}`,
          sub: `Tap the mic, or enable background listening and just say “${settings.wakeWord}”.`,
        };
    }
  }, [brian.phase, brian.error, settings.wakeWord, settings.assistantName]);

  const orbClass = `orb-wrap ${
    brian.phase === "speaking"
      ? "is-speaking"
      : brian.phase === "thinking"
        ? "is-thinking"
        : brian.micOn
          ? "is-listening"
          : "is-off"
  }`;

  const submitDraft = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    brian.sendText(text);
  };

  const modeChip =
    brian.aiMode === "ai" ? (
      <span className="chip chip--live">
        <span className="dot" /> AI model{brian.model ? ` · ${brian.model}` : ""}
      </span>
    ) : brian.aiMode === "offline" ? (
      <span className="chip chip--violet">
        <span className="dot" /> Local brain
      </span>
    ) : (
      <span className="chip">
        <span className="dot dot--pulse" /> Connecting
      </span>
    );

  return (
    <main className="shell">
      <header className="topbar">
        <span className="brand">
          {settings.assistantName}
          <small>voice assistant</small>
        </span>
        <span className="topbar-spacer" />
        {modeChip}
        <Link href="/settings" className="icon-btn" aria-label="Settings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </Link>
      </header>

      {brian.micOn && (
        <div className="live-bar">
          <span className="dot dot--pulse" />
          <span>
            <strong>Microphone live</strong> — listening for “{settings.wakeWord}”
          </span>
          <button type="button" onClick={brian.stopListening}>
            Stop
          </button>
        </div>
      )}

      {brian.voiceRejected && (
        <div className="notice">
          That voice doesn&apos;t match your saved voice profile, so I stayed quiet. Enrol again in Settings if it&apos;s
          you.
        </div>
      )}

      {brian.heardNotForMe && !brian.engaged && (
        <div className="notice notice--info">
          I heard talking, but it wasn&apos;t addressed to me. Start with “{settings.wakeWord}” and I&apos;ll join in.
        </div>
      )}

      <section className="stage">
        <div className={orbClass}>
          <span className="orb-ring ring-1" />
          <span className="orb-ring ring-2" />
          <span className="orb-ring ring-3" />
          <div className="orb-core" />
          <span className="orb-glyph">
            {brian.phase === "speaking" ? "speaking" : brian.phase === "thinking" ? "thinking" : brian.micOn ? "listening" : "standby"}
          </span>
        </div>
        <h1 className="stage-status">{status.title}</h1>
        <p className="stage-sub">{status.sub}</p>
        {brian.phase === "speaking" && (
          <div className="wave" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        )}
      </section>

      <div className="thread" ref={threadRef}>
        {brian.messages.length === 0 && (
          <p className="empty-hint">
            Everything you say here stays in this conversation on your device.
            <br />
            Try “{settings.wakeWord}, what time is it?”
          </p>
        )}

        {brian.messages.map((message) => (
          <div key={message.id} className={`bubble bubble--${message.role}`}>
            <div>{message.content}</div>
            {message.action && <ActionCard action={message.action} />}
            <div className="bubble-meta">
              <span>
                {new Date(message.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
              {message.role === "assistant" && message.mode === "offline" && <span className="local">local brain</span>}
              {message.role === "user" && message.source === "voice" && <span>voice</span>}
            </div>
          </div>
        ))}

        {brian.interim && <div className="interim">{brian.interim}…</div>}
      </div>

      <div className="composer">
        <div className="composer-inner">
          {brian.messages.length === 0 && (
            <div className="chips">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="chip-suggest"
                  onClick={() => brian.sendText(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          {brian.phase === "speaking" && (
            <div className="stop-row">
              <button type="button" className="stop-btn" onClick={brian.interrupt}>
                Stop speaking
              </button>
            </div>
          )}

          <form className="input-row" onSubmit={submitDraft}>
            <button
              type="button"
              className={`mic-btn ${brian.micOn ? "is-on" : "is-off"}`}
              onClick={brian.toggleMic}
              aria-pressed={brian.micOn}
              aria-label={brian.micOn ? "Stop listening" : "Start listening"}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <path d="M12 18v3" />
              </svg>
            </button>

            <div className="text-field">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={`Ask ${settings.assistantName} anything…`}
                aria-label="Message Brian"
                enterKeyHint="send"
              />
              <button type="submit" className="send-btn" disabled={!draft.trim()} aria-label="Send">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12h15" />
                  <path d="M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
