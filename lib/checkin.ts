/**
 * Natural check-ins when the user has gone quiet.
 *
 * The request: "it should just check on me naturally after 2 mins when am silent."
 *
 * Design notes:
 *  - A check-in is a normal spoken turn, so it appears in the conversation and
 *    can be talked over like anything else.
 *  - It only ever happens while the microphone is armed and nothing is being
 *    said, so Brian never talks over the user or starts talking to an empty
 *    room when listening is off.
 *  - Each further nudge is spaced further apart, and after a few tries Brian
 *    says it is going quiet instead of nagging.
 */

export interface CheckInContext {
  /** Local hour, 0-23, used for a time-of-day tone. */
  hour: number;
  /** 0 for the first check-in, 1 for the next, and so on. */
  attempt: number;
  /** What the user last said, so the nudge can be contextual. */
  lastUserText?: string;
  /** Assistant name for the final "going quiet" line. */
  assistantName?: string;
  /** Deterministic variant selector, mainly for tests. */
  seed?: number;
}

/** How many times Brian will check in before going quiet. */
export const MAX_CHECK_INS = 3;

const FIRST: string[] = [
  "Hey, I'm still here if you want to pick things back up.",
  "You've gone quiet — everything alright?",
  "Still with me? No rush at all.",
  "I'm here whenever you're ready.",
];

const SECOND: string[] = [
  "Still here. Want me to set a reminder while you're thinking?",
  "Take your time. I'll keep listening.",
  "No rush — just say the word if you need anything.",
];

const NIGHT: string[] = [
  "It's getting late. I can set an alarm for tomorrow if you want.",
  "Quiet hours — I'm still here if you need me.",
];

function looksLikeQuestion(text?: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  return /\?$/.test(t) || /^(what|why|how|when|where|who|which|can|could|do|does|did|is|are|will|would|should)\b/i.test(t);
}

function pick(list: string[], seed: number): string {
  return list[Math.abs(seed) % list.length];
}

/**
 * Choose a check-in line. Deliberately varied so it does not sound like a
 * repeating alert, and contextual when the user's last turn was a question.
 */
export function pickCheckIn(ctx: CheckInContext): string {
  const attempt = Math.max(0, Math.min(ctx.attempt, MAX_CHECK_INS));
  const seed = ctx.seed ?? attempt;

  if (attempt >= MAX_CHECK_INS) {
    const name = ctx.assistantName?.trim() || "Brian";
    return `I'll go quiet for now. Say “Hey ${name}” whenever you need me.`;
  }

  if (attempt === 0 && looksLikeQuestion(ctx.lastUserText)) {
    return "Still thinking about that one? I can go deeper if you'd like.";
  }

  if (attempt >= 2) {
    return pick(
      [
        "I'll stay out of the way for a bit. Just say my name.",
        "Going quiet now — I'm one word away if you need me.",
      ],
      seed,
    );
  }

  if (attempt === 1) return pick(SECOND, seed);

  // First nudge: gentle, time aware.
  const night = ctx.hour >= 22 || ctx.hour < 6;
  if (night) return pick(NIGHT, seed);
  if (ctx.hour < 12) return pick(["Morning's still young — anything I can do?", ...FIRST], seed);
  return pick(FIRST, seed);
}

/**
 * Gap before the next check-in. The first arrives after the configured silence
 * window, then each one waits progressively longer.
 */
export function checkInDelayMs(baseMs: number, attempt: number): number {
  const base = Math.max(15_000, baseMs);
  const factor = 1 + Math.max(0, attempt) * 0.75;
  return Math.round(base * factor);
}
