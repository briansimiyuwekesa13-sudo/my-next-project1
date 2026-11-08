import type { AssistantAction, AssistantSettings, Personality } from "./types";
import { normalizeText } from "./wake-word";

export interface AnswerContext {
  assistantName: string;
  personality?: Personality;
  timeZone?: string;
  now?: Date;
  platform?: "web" | "android";
}

export interface LocalAnswer {
  reply: string;
  action?: AssistantAction;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40",
  fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90",
};

export function formatClock(date: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

export function formatDay(date: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone,
    }).format(date);
  } catch {
    return date.toDateString();
  }
}

function greetingFor(date: Date, timeZone?: string): string {
  let hour = date.getHours();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone,
    }).format(date);
    hour = Number(parts) || hour;
  } catch {
    /* keep local hour */
  }
  if (hour < 5) return "You're up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Recursive-descent arithmetic — no eval, digits and operators only. */
function evaluateExpression(raw: string): number | null {
  const s = raw.replace(/\s+/g, "");
  if (!/^[\d+\-*/().]+$/.test(s)) return null;
  let i = 0;

  const peek = () => s[i];
  const parseNumber = (): number => {
    const start = i;
    while (i < s.length && /[\d.]/.test(s[i])) i++;
    if (start === i) throw new Error("number expected");
    return Number(s.slice(start, i));
  };
  const parseFactor = (): number => {
    if (peek() === "-") {
      i++;
      return -parseFactor();
    }
    if (peek() === "+") {
      i++;
      return parseFactor();
    }
    if (peek() === "(") {
      i++;
      const value = parseSum();
      if (peek() !== ")") throw new Error("unbalanced");
      i++;
      return value;
    }
    return parseNumber();
  };
  const parseProduct = (): number => {
    let value = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = s[i++];
      const rhs = parseFactor();
      value = op === "*" ? value * rhs : value / rhs;
    }
    return value;
  };
  const parseSum = (): number => {
    let value = parseProduct();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      const rhs = parseProduct();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  };

  try {
    const result = parseSum();
    if (i !== s.length || !Number.isFinite(result)) return null;
    return result;
  } catch {
    return null;
  }
}

function tryMath(norm: string): string | null {
  const expression = norm
    .replace(/what('s| is)?|calculate|compute|equals?|please|how much is|the result of/g, " ")
    .replace(/\bplus\b/g, "+")
    .replace(/\bminus\b/g, "-")
    .replace(/\b(times|multiplied by|x)\b/g, "*")
    .replace(/\b(divided by|over)\b/g, "/")
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, (w) => NUMBER_WORDS[w] ?? w)
    .replace(/\bpercent of\b/g, "/100*")
    .trim();

  if (!/[+\-*/]/.test(expression)) return null;
  const value = evaluateExpression(expression);
  if (value === null) return null;
  const rounded = Math.round(value * 1e6) / 1e6;
  return `That's ${rounded.toLocaleString("en-US")}.`;
}

/* ------------------------------------------------------------------ *
 * Phone actions
 * ------------------------------------------------------------------ */

interface AppTarget {
  label: string;
  web?: string;
  pkg?: string;
  action?: string;
}

const APPS: Record<string, AppTarget> = {
  youtube: { label: "YouTube", web: "https://www.youtube.com", pkg: "com.google.android.youtube" },
  maps: { label: "Google Maps", web: "https://maps.google.com", pkg: "com.google.android.apps.maps" },
  "google maps": { label: "Google Maps", web: "https://maps.google.com", pkg: "com.google.android.apps.maps" },
  spotify: { label: "Spotify", web: "https://open.spotify.com", pkg: "com.spotify.music" },
  whatsapp: { label: "WhatsApp", web: "https://web.whatsapp.com", pkg: "com.whatsapp" },
  instagram: { label: "Instagram", web: "https://www.instagram.com", pkg: "com.instagram.android" },
  gmail: { label: "Gmail", web: "https://mail.google.com", pkg: "com.google.android.gm" },
  email: { label: "Gmail", web: "https://mail.google.com", pkg: "com.google.android.gm" },
  chrome: { label: "Chrome", web: "https://www.google.com", pkg: "com.android.chrome" },
  browser: { label: "Browser", web: "https://www.google.com", pkg: "com.android.chrome" },
  camera: { label: "Camera", action: "android.media.action.IMAGE_CAPTURE" },
  messages: { label: "Messages", web: "sms:", pkg: "com.google.android.apps.messaging" },
  "text messages": { label: "Messages", web: "sms:", pkg: "com.google.android.apps.messaging" },
  settings: { label: "Settings", action: "android.settings.SETTINGS" },
  wifi: { label: "Wi-Fi settings", action: "android.settings.WIFI_SETTINGS" },
  bluetooth: { label: "Bluetooth settings", action: "android.settings.BLUETOOTH_SETTINGS" },
  clock: { label: "Clock", pkg: "com.google.android.deskclock" },
  calendar: { label: "Calendar", web: "https://calendar.google.com", pkg: "com.google.android.calendar" },
};

function androidIntentFor(target: AppTarget): string {
  if (target.action) return `intent:#Intent;action=${target.action};end`;
  if (target.pkg && target.web?.startsWith("http")) {
    const host = target.web.replace(/^https?:\/\//, "");
    return `intent://${host}#Intent;scheme=https;package=${target.pkg};end`;
  }
  if (target.pkg) return `intent:#Intent;package=${target.pkg};end`;
  return target.web ?? "";
}

function appAction(target: AppTarget, platform: "web" | "android"): AssistantAction {
  const intent = androidIntentFor(target);
  const href = platform === "android" ? intent || target.web : target.web ?? intent;
  return {
    type: "open-app",
    label: `Open ${target.label}`,
    href,
    androidIntent: intent || undefined,
    detail: platform === "android" ? undefined : "App launch works in the Android build; the web build opens the web app.",
  };
}

function alarmIntent(hour: number, minute: number, label: string): string {
  return (
    "intent:#Intent;action=android.intent.action.SET_ALARM" +
    `;i.android.intent.extra.alarm.HOUR=${hour}` +
    `;i.android.intent.extra.alarm.MINUTES=${minute}` +
    `;S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(label).replace(/;/g, ",")}` +
    ";end"
  );
}

function timerIntent(seconds: number, label: string): string {
  return (
    "intent:#Intent;action=android.intent.action.SET_TIMER" +
    `;i.android.intent.extra.alarm.LENGTH=${seconds}` +
    `;S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(label).replace(/;/g, ",")}` +
    ";end"
  );
}

function parseClockTime(text: string): { hour: number; minute: number } | null {
  const match = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const suffix = match[3];
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  if (!suffix && hour <= 7) hour += 12; // "alarm for 7" usually means evening? keep 7am
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function parseDurationSeconds(text: string): number | null {
  const match = text.match(/(\d+)\s*(second|sec|minute|min|hour|hr)/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit.startsWith("sec")) return amount;
  if (unit.startsWith("min")) return amount * 60;
  return amount * 3600;
}

export function detectAction(
  transcript: string,
  ctx: AnswerContext,
): AssistantAction | undefined {
  const norm = normalizeText(transcript);
  const platform = ctx.platform ?? "web";

  // --- listening / privacy controls -------------------------------------
  if (/^(stop listening|stop the mic|turn off the mic|mute yourself|mic off|go to sleep)\b/.test(norm)) {
    return { type: "settings", label: "Turn the microphone off", command: "stop-listening" };
  }
  if (/^(start listening|turn on the mic|mic on|wake up|listen again)\b/.test(norm)) {
    return { type: "settings", label: "Turn the microphone on", command: "start-listening" };
  }
  if (/^(open|show) (your |the )?settings\b/.test(norm)) {
    return { type: "settings", label: "Open settings", href: "/settings" };
  }

  // --- calls -------------------------------------------------------------
  const call = norm.match(/^(?:please\s+)?(?:can you\s+)?(?:call|dial|phone|ring)\s+(?:up\s+)?(.+)$/);
  if (call) {
    const target = call[1].replace(/\b(my|the|a)\b/g, "").replace(/\s+/g, " ").trim();
    const digits = target.replace(/[^\d+]/g, "");
    if (digits.length >= 3) {
      return {
        type: "call",
        label: `Call ${target}`,
        href: `tel:${digits}`,
        detail: "Your phone places the call — the microphone stream is released first.",
      };
    }
    return {
      type: "call",
      label: `Call ${target || "someone"}`,
      href: "tel:",
      detail: "Contacts live on the phone, so I need the number: say “call 555 0134” or tap to open the dialer.",
    };
  }

  // --- alarms & reminders -------------------------------------------------
  const alarm = norm.match(/^(?:set|create|make)\s+(?:an?\s+)?alarm\s+(?:for\s+)?(.+)$/);
  if (alarm) {
    const time = parseClockTime(alarm[1]);
    if (time) {
      return {
        type: "alarm",
        label: `Alarm for ${alarm[1].trim()}`,
        androidIntent: alarmIntent(time.hour, time.minute, "Brian alarm"),
        href: alarmIntent(time.hour, time.minute, "Brian alarm"),
        detail: platform === "android" ? undefined : "Android opens its clock app with this alarm prefilled.",
      };
    }
    return { type: "alarm", label: "Open the clock app", href: "intent:#Intent;action=android.intent.action.SHOW_ALARMS;end" };
  }

  const reminder = norm.match(/^(?:remind me|set (?:a )?reminder)(?:\s+to)?\s+(.+)$/);
  if (reminder) {
    const duration = parseDurationSeconds(reminder[1]);
    if (duration) {
      return {
        type: "reminder",
        label: `Reminder in ${Math.round(duration / 60) || 1} min`,
        androidIntent: timerIntent(duration, reminder[1]),
        href: timerIntent(duration, reminder[1]),
        detail: "Opens the phone's timer so the reminder fires even if this page closes.",
      };
    }
    return {
      type: "reminder",
      label: "Create a reminder",
      androidIntent: "intent:#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.dir/event;end",
      detail: "Add it to your calendar with one tap — say “remind me in 20 minutes” for a timer instead.",
    };
  }

  // --- open apps ----------------------------------------------------------
  const open = norm.match(/^(?:open|launch|start|go to)\s+(.+)$/);
  if (open) {
    const requested = open[1].replace(/\b(app|the|my)\b/g, "").replace(/\s+/g, " ").trim();
    const target = APPS[requested];
    if (target) return appAction(target, platform);
    if (/^https?:|\.(com|org|net|io)\b/.test(requested)) {
      const url = requested.startsWith("http") ? requested : `https://${requested}`;
      return { type: "web", label: `Open ${requested}`, href: url };
    }
  }

  // --- notifications ------------------------------------------------------
  if (/\b(read|check|any|what).{0,20}notification/.test(norm)) {
    return {
      type: "notifications",
      label: "Enable notification access",
      href: "intent:#Intent;action=android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS;end",
      detail:
        "Browsers cannot read notifications. The Android build asks for notification-access permission and reads them aloud.",
    };
  }

  return undefined;
}

/* ------------------------------------------------------------------ *
 * Offline conversational brain
 * ------------------------------------------------------------------ */

export function localAnswer(input: string, ctx: AnswerContext): LocalAnswer {
  const norm = normalizeText(input);
  const name = ctx.assistantName || "Brian";
  const now = ctx.now ?? new Date();
  const action = detectAction(input, ctx);

  if (!norm) {
    return { reply: `I'm listening. What do you need?` };
  }

  // Direct device actions first — they deserve a short, confident answer.
  if (action) {
    switch (action.type) {
      case "call":
        return {
          reply: action.detail ? `On it. ${action.detail}` : `Calling now.`,
          action,
        };
      case "alarm":
        return { reply: `Alarm set. Tap the card if your phone asks for confirmation.`, action };
      case "reminder":
        return { reply: `Done — I've set that up for you.`, action };
      case "open-app":
        return { reply: `Opening it now.`, action };
      case "notifications":
        return {
          reply: `I can read notifications in the Android build, once you grant notification access.`,
          action,
        };
      case "settings":
        return {
          reply:
            action.command === "stop-listening"
              ? `Microphone off. Say the wake word or tap the mic when you want me again.`
              : action.command === "start-listening"
                ? `I'm listening.`
                : `Opening settings.`,
          action,
        };
      case "web":
        return { reply: `Opening ${action.label.replace(/^Open\s+/, "")}.`, action };
    }
  }

  // Time & date
  if (/\b(what|tell me).{0,12}\b(time|clock)\b|\bwhat time is it\b|\btime now\b/.test(norm)) {
    return { reply: `It's ${formatClock(now, ctx.timeZone)}.` };
  }
  if (/\b(what|which).{0,12}\b(day|date)\b|\btoday's date\b|\bwhat is today\b/.test(norm)) {
    return { reply: `Today is ${formatDay(now, ctx.timeZone)}.` };
  }

  // Identity & personality
  if (/^(hi|hey|hello|yo|good morning|good afternoon|good evening|morning|evening)\b/.test(norm)) {
    return {
      reply: `${greetingFor(now, ctx.timeZone)}. ${name} here — I'm listening.`,
    };
  }
  if (/\b(who are you|what are you|your name|introduce yourself)\b/.test(norm)) {
    return {
      reply: `I'm ${name}, your voice assistant. Say “${ctx.assistantName ? "Hey " + name : "Hey Brian"}” any time and I'll be right here.`,
    };
  }
  if (/\b(how are you|how's it going|how are things)\b/.test(norm)) {
    return { reply: `Running smoothly and glad you asked. How are you doing?` };
  }
  if (/\b(thank you|thanks|cheers|appreciate it)\b/.test(norm)) {
    return { reply: `Any time. That's what I'm here for.` };
  }
  if (/\b(bye|goodbye|good night|see you|that's all)\b/.test(norm)) {
    return { reply: `Talk soon. I'll be here when you need me.` };
  }
  if (/\b(tell me a joke|make me laugh|something funny)\b/.test(norm)) {
    return {
      reply: `Why did the phone go to therapy? It had too many unresolved notifications.`,
    };
  }
  if (/\b(what can you do|help|commands|capabilities)\b/.test(norm)) {
    return {
      reply:
        "I can talk naturally, remember our conversation, tell the time, call a number, open apps, set alarms and reminders, and read your notifications in the Android build. Just speak normally.",
    };
  }
  if (/\b(flip a coin|toss a coin)\b/.test(norm)) {
    return { reply: `It's ${Math.random() < 0.5 ? "heads" : "tails"}.` };
  }
  if (/\b(roll a dice|roll a die|roll the dice)\b/.test(norm)) {
    return { reply: `You rolled a ${1 + Math.floor(Math.random() * 6)}.` };
  }

  const math = tryMath(norm);
  if (math) return { reply: math };

  // Fallback: be honest, stay useful.
  return {
    reply:
      "That one needs my language model, which isn't connected yet. I can still handle the time, calls, alarms, reminders, apps and maths — or you can add a model key in Settings and I'll answer anything.",
  };
}

/* ------------------------------------------------------------------ *
 * Prompt for the language model
 * ------------------------------------------------------------------ */

const PERSONALITY: Record<Personality, string> = {
  friendly: "Warm, upbeat and genuinely curious. Light humour when it fits.",
  concise: "Direct and efficient. One or two short sentences, no filler.",
  warm: "Calm, reassuring and attentive, like a trusted friend.",
};

export function buildSystemPrompt(settings: Partial<AssistantSettings>, ctx: AnswerContext): string {
  const name = settings.assistantName || ctx.assistantName || "Brian";
  const personality = PERSONALITY[settings.personality ?? ctx.personality ?? "friendly"];
  const now = ctx.now ?? new Date();
  const time = formatClock(now, ctx.timeZone);
  const day = formatDay(now, ctx.timeZone);

  return [
    `You are ${name}, a personal voice assistant that the user talks to out loud.`,
    `Personality: ${personality}`,
    "Your replies are spoken aloud by a text-to-speech engine, so:",
    "- Answer in plain conversational sentences. Never use markdown, bullet points, emoji or code blocks.",
    "- Keep most answers to one to three sentences unless the user asks for detail.",
    "- Write numbers and units the way a person would say them.",
    "- Never describe yourself as an AI language model; you are simply ${name}.".replace("${name}", name),
    "Remember the conversation so far and use it — follow-up questions like “and tomorrow?” must make sense.",
    `Right now it is ${time} on ${day}${ctx.timeZone ? ` (${ctx.timeZone})` : ""}.`,
    "Device actions (calling, alarms, opening apps) are handled by the app itself; if the user asks for one, confirm briefly and do not pretend you performed anything else.",
    "If you genuinely don't know something, say so plainly and offer the closest thing you can do.",
  ].join("\n");
}
