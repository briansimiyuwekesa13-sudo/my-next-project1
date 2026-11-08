"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, type AssistantSettings, type ChatMessage } from "./types";

const SETTINGS_KEY = "brian.settings.v1";
const HISTORY_KEY = "brian.history.v1";
const MAX_HISTORY = 120;

function isSettings(value: unknown): value is AssistantSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.assistantName === "string" && typeof v.wakeWord === "string";
}

export function loadSettings(): AssistantSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (!isSettings(parsed)) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function persistSettings(settings: AssistantSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore quota errors */
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AssistantSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSettings(loadSettings());
    setReady(true);
    const onStorage = (event: StorageEvent) => {
      if (event.key === SETTINGS_KEY) setSettings(loadSettings());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((patch: Partial<AssistantSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      persistSettings(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    persistSettings(DEFAULT_SETTINGS);
    setSettings(DEFAULT_SETTINGS);
  }, []);

  return { settings, update, reset, ready };
}

export function useConversation() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ready, setReady] = useState(false);
  const ref = useRef<ChatMessage[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter(
            (m): m is ChatMessage =>
              Boolean(m) &&
              typeof m === "object" &&
              (m as ChatMessage).role !== undefined &&
              typeof (m as ChatMessage).content === "string",
          );
          ref.current = valid.slice(-MAX_HISTORY);
          setMessages(ref.current);
        }
      }
    } catch {
      /* ignore corrupt history */
    }
    setReady(true);
  }, []);

  const commit = useCallback((next: ChatMessage[]) => {
    ref.current = next.slice(-MAX_HISTORY);
    setMessages(ref.current);
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(ref.current));
    } catch {
      /* ignore */
    }
  }, []);

  const append = useCallback(
    (message: ChatMessage) => {
      commit([...ref.current, message]);
    },
    [commit],
  );

  const clear = useCallback(() => {
    commit([]);
  }, [commit]);

  return { messages, append, clear, ready, current: ref };
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `m-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
