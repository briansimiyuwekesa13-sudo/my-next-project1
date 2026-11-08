/**
 * Wake-word helpers. Everything here is pure string work so it can run on the
 * device (no network, no audio leaves the phone for wake-word matching).
 */

const FILLERS = new Set(["hey", "hi", "ok", "okay", "yo", "hello", "um", "uh"]);

export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9'+\-*/. ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** Tolerates the usual mis-hearings ("brain" for "brian", "sophie"/"sofie"). */
function tokenMatches(heard: string, expected: string): boolean {
  if (heard === expected) return true;
  if (expected.length >= 4 && heard.length >= 3 && levenshtein(heard, expected) <= 1) {
    return true;
  }
  return false;
}

export interface WakeWordHit {
  matched: boolean;
  /** Everything the user said after the wake word. */
  remainder: string;
}

/**
 * Looks for the wake word near the start of an utterance so that a sentence
 * like "I told Brian to call me later" is *not* treated as an activation.
 */
export function detectWakeWord(transcript: string, wakeWord: string): WakeWordHit {
  const wakeTokens = normalizeText(wakeWord).split(" ").filter(Boolean);
  const tokens = normalizeText(transcript).split(" ").filter(Boolean);
  if (!wakeTokens.length || !tokens.length) {
    return { matched: false, remainder: transcript.trim() };
  }

  // Allow a couple of leading filler words: "ok hey brian ...".
  const maxStart = Math.min(tokens.length - wakeTokens.length, 2);
  for (let start = 0; start <= maxStart; start++) {
    if (start > 0 && !FILLERS.has(tokens[start - 1])) break;
    let ok = true;
    for (let i = 0; i < wakeTokens.length; i++) {
      if (!tokenMatches(tokens[start + i], wakeTokens[i])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return {
        matched: true,
        remainder: tokens.slice(start + wakeTokens.length).join(" ").trim(),
      };
    }
  }
  return { matched: false, remainder: transcript.trim() };
}

/** Rough overlap check used to stop the assistant from answering its own TTS. */
export function isLikelyEcho(transcript: string, lastSpoken: string): boolean {
  const a = normalizeText(transcript).split(" ").filter((w) => w.length > 2);
  const b = new Set(normalizeText(lastSpoken).split(" ").filter((w) => w.length > 2));
  if (!a.length || !b.size) return false;
  const hits = a.filter((w) => b.has(w)).length;
  return hits / a.length >= 0.6;
}
