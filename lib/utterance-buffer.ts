/**
 * Sentence assembly for speech recognition.
 *
 * Reported symptom: "I asked how you doing but it only recorded one word, Hi."
 * Chrome finalises a transcript in fragments — "Hi" arrives as a final result
 * while the rest of the sentence is still being transcribed. Answering on the
 * first final fragment therefore replies to half a thought, and the remainder
 * arrives while the assistant is already talking, where it gets dropped.
 *
 * The fix is to wait for a short quiet gap before treating the transcript as
 * one utterance, and to join fragments that belong to the same breath.
 */

/** How long the user must stay quiet before we treat the sentence as finished. */
export const UTTERANCE_QUIET_MS = 700;

/** Nothing longer than this is treated as one breath; it is flushed anyway. */
export const MAX_UTTERANCE_CHARS = 320;

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Join a newly finalised fragment onto whatever we were already holding.
 * Avoids duplicating text when the recogniser replays a fragment it already
 * reported, and keeps sentence punctuation sane.
 */
export function mergeFinal(pending: string, next: string): string {
  const a = tidy(pending);
  const b = tidy(next);
  if (!a) return b;
  if (!b) return a;

  // The recogniser re-reported a fragment we already have.
  if (a.toLowerCase().endsWith(b.toLowerCase())) return a;
  if (a.toLowerCase() === b.toLowerCase()) return a;

  const needsSpace = !/[\s]$/.test(a);
  return tidy(needsSpace ? `${a} ${b}` : `${a}${b}`);
}

/**
 * True when the buffered text already reads like a finished thought, so we can
 * answer without waiting out the full quiet window. Only very clear endings
 * qualify — a trailing "?" or "." — never a bare word.
 */
export function looksFinished(text: string): boolean {
  const t = tidy(text);
  if (!t) return false;
  if (t.length >= MAX_UTTERANCE_CHARS) return true;
  const words = t.split(" ").length;
  if (words < 3) return false;
  return /[?.!]$/.test(t);
}

/**
 * Decide whether to flush the buffer now.
 * `quietFor` is how long the microphone has been silent, in milliseconds.
 */
export function shouldFlush(text: string, quietFor: number): boolean {
  const t = tidy(text);
  if (!t) return false;
  if (t.length >= MAX_UTTERANCE_CHARS) return true;
  if (looksFinished(t)) return true;
  return quietFor >= UTTERANCE_QUIET_MS;
}
