/**
 * Guards that stop the assistant from answering itself.
 *
 * Reported symptom: saying "Hi" produced about five replies that cut each
 * other off before the full answer. Three things combined to cause that:
 *
 *  1. Chrome delivers the same final transcript more than once, and every
 *     delivery started a new request.
 *  2. The microphone kept listening while the assistant spoke, so its own
 *     voice was transcribed and treated as a new question ("barge-in").
 *  3. Each new reply cancelled the previous one mid-sentence, so the fragments
 *     played on top of each other.
 *
 * These helpers are pure functions so the behaviour can be tested without a
 * real microphone.
 */

export interface UtteranceRecord {
  text: string;
  at: number;
}

/** Default window in which a repeated transcript is treated as a duplicate. */
export const DEDUPE_WINDOW_MS = 2500;

/** How long after speech ends a trailing echo is still ignored. */
export const ECHO_GRACE_MS = 900;

export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the same words arrived again within `windowMs`.
 * Chrome re-delivers identical finals, and recognition restarts replay the
 * tail of the previous session, so this is the first line of defence.
 */
export function isDuplicateUtterance(
  previous: UtteranceRecord,
  text: string,
  now: number,
  windowMs: number = DEDUPE_WINDOW_MS,
): boolean {
  if (!previous.text) return false;
  if (now - previous.at > windowMs) return false;
  const a = normalizeUtterance(previous.text);
  const b = normalizeUtterance(text);
  if (!a || !b) return false;
  return a === b;
}

/**
 * True when what the microphone heard is mostly words the assistant just said.
 * A genuine interruption is a different sentence and scores low here.
 */
export function isSelfEcho(heard: string, spoken: string, threshold = 0.6): boolean {
  const h = normalizeUtterance(heard);
  const s = normalizeUtterance(spoken);
  if (!h || !s) return false;

  // A fragment of our own sentence, e.g. we said "the capital of Japan is
  // Tokyo" and the mic picked up "capital of Japan".
  if (h.length >= 4 && s.includes(h)) return true;

  const spokenWords = new Set(s.split(" ").filter((word) => word.length > 2));
  const heardWords = h.split(" ").filter(Boolean);
  if (heardWords.length === 0 || spokenWords.size === 0) return false;

  const overlap = heardWords.filter((word) => spokenWords.has(word)).length;
  return overlap / heardWords.length >= threshold;
}

/**
 * Decide whether a transcript should be discarded because it is the
 * assistant's own voice rather than the user.
 *
 * While speaking we use a stricter threshold, because a false positive here
 * only costs the user a repeat, while a false negative makes the assistant
 * talk over itself. Just after speech ends a trailing echo is still ignored.
 */
export function shouldIgnoreAsEcho(
  heard: string,
  spoken: string,
  isSpeaking: boolean,
  msSinceSpeechEnd: number,
  graceMs: number = ECHO_GRACE_MS,
): boolean {
  if (isSpeaking) return isSelfEcho(heard, spoken, 0.5);
  if (msSinceSpeechEnd >= 0 && msSinceSpeechEnd < graceMs) {
    return isSelfEcho(heard, spoken, 0.5);
  }
  return false;
}
