/**
 * Regression check for the "one Hi produced five overlapping replies" bug.
 *
 * Replays the transcripts Chrome actually delivers (repeated finals, wake-word
 * acknowledgement, the assistant hearing its own speech) through the same
 * guards lib/use-brian.ts uses, and asserts how many replies would start.
 *
 * Run: tsx scripts/qa-voice-guard.ts
 */
import assert from "node:assert/strict";
import {
  DEDUPE_WINDOW_MS,
  ECHO_GRACE_MS,
  isDuplicateUtterance,
  isSelfEcho,
  normalizeUtterance,
  shouldIgnoreAsEcho,
} from "../lib/voice-guard";
import { UTTERANCE_QUIET_MS, mergeFinal, shouldFlush } from "../lib/utterance-buffer";
import { MAX_CHECK_INS, checkInDelayMs, pickCheckIn } from "../lib/checkin";
import { localAnswer } from "../lib/assistant";

type AnswerCtx = Parameters<typeof localAnswer>[1];
type CheckInCtx = Parameters<typeof pickCheckIn>[0];

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

/**
 * Minimal model of handleUtterance: returns the utterances that would be
 * submitted, i.e. that survive duplicate + echo filtering.
 */
function simulate(
  events: Array<{ text: string; at: number; speaking?: boolean; spoken?: string }>,
): string[] {
  const accepted: string[] = [];
  let last = { text: "", at: 0 };
  let speechEndedAt = -Infinity;
  let wasSpeaking = false;

  for (const event of events) {
    const speaking = event.speaking ?? false;
    const spoken = event.spoken ?? "";
    // Speech that finished before this transcript arrived starts the grace window.
    if (wasSpeaking && !speaking) speechEndedAt = event.at;
    wasSpeaking = speaking;

    if (isDuplicateUtterance(last, event.text, event.at)) continue;
    last = { text: event.text, at: event.at };
    if (shouldIgnoreAsEcho(event.text, spoken, speaking, event.at - speechEndedAt)) continue;
    accepted.push(event.text);
  }
  return accepted;
}

/* --------------------------- reported scenario --------------------------- */

check("saying \"Hi\" once produces exactly one reply", () => {
  // Chrome delivers the same final repeatedly, and the restart replays the tail.
  const events = [
    { text: "Hi", at: 1_000 },
    { text: "Hi", at: 1_180 },
    { text: "Hi", at: 1_640 },
    { text: "hi", at: 2_050 },
    { text: "Hi.", at: 2_480 },
  ];
  assert.deepEqual(simulate(events), ["Hi"]);
});

check("the assistant's own answer is never treated as a new question", () => {
  const answer = "Hey there! I'm doing great, thanks for asking. What's up with you?";
  const events = [
    { text: "Hi", at: 1_000 },
    // Microphone picks the reply up while it plays...
    { text: "Hey there I'm doing great thanks for asking", at: 1_900, speaking: true, spoken: answer },
    { text: "what's up with you", at: 2_600, speaking: true, spoken: answer },
    // ...and the tail lands just after speech ends.
    { text: "doing great thanks for asking", at: 3_400, spoken: answer },
  ];
  assert.deepEqual(simulate(events), ["Hi"]);
});

check("a real interruption during speech still goes through", () => {
  const answer = "Sure, I can walk you through setting an alarm step by step.";
  const accepted = simulate([
    { text: "Hi", at: 1_000 },
    { text: "what's the weather tomorrow", at: 2_000, speaking: true, spoken: answer },
  ]);
  assert.deepEqual(accepted, ["Hi", "what's the weather tomorrow"]);
});

check("two different questions in a row are both answered", () => {
  const accepted = simulate([
    { text: "what time is it", at: 1_000 },
    { text: "set an alarm for seven", at: 2_000 },
  ]);
  assert.equal(accepted.length, 2);
});

check("the wake word is not answered twice after it engaged the assistant", () => {
  // Interim results engage us; the final then re-announces the wake word.
  const events = [
    { text: "hey brian", at: 1_000 },
    { text: "hey brian", at: 1_400 },
    { text: "hey brian what time is it", at: 2_200 },
  ];
  assert.equal(simulate(events).length, 2); // one wake-word turn + one real question
});

/* ------------------------------ unit level ------------------------------ */

check("normalizeUtterance ignores case and punctuation", () => {
  assert.equal(normalizeUtterance("  Hey,   Brian! "), "hey brian");
});

check("duplicates expire after the dedupe window", () => {
  const first = { text: "what time is it", at: 1_000 };
  assert.equal(isDuplicateUtterance(first, "what time is it", 1_000 + DEDUPE_WINDOW_MS - 1), true);
  assert.equal(isDuplicateUtterance(first, "what time is it", 1_000 + DEDUPE_WINDOW_MS + 1), false);
});

check("different words are never deduped", () => {
  const first = { text: "play some music", at: 1_000 };
  assert.equal(isDuplicateUtterance(first, "pause the music", 1_100), false);
});

check("self-echo detection: fragment of our own sentence", () => {
  assert.equal(isSelfEcho("capital of Japan", "The capital of Japan is Tokyo."), true);
});

check("self-echo detection: unrelated question", () => {
  assert.equal(isSelfEcho("call my sister", "The capital of Japan is Tokyo."), false);
});

check("self-echo detection: ignores very short noise", () => {
  assert.equal(isSelfEcho("hi", "The capital of Japan is Tokyo."), false);
});

check("grace window is bounded", () => {
  const spoken = "I'm doing great, thanks for asking.";
  assert.equal(shouldIgnoreAsEcho("doing great thanks for asking", spoken, false, 200), true);
  assert.equal(shouldIgnoreAsEcho("doing great thanks for asking", spoken, false, ECHO_GRACE_MS + 50), false);
});

/* ------------------ sentence assembly (the "only Hi" bug) ------------------ */

check("a fragment that ends mid-thought waits for the rest of the sentence", () => {
  assert.equal(shouldFlush("Hi", 0), false);
  assert.equal(shouldFlush("Hi I was wondering if you could", 0), false);
});

check("a complete sentence is answered immediately", () => {
  assert.equal(shouldFlush("How are you doing?", 0), true);
  assert.equal(shouldFlush("What time is it.", 0), true);
});

check("a pause always releases whatever was captured", () => {
  assert.equal(shouldFlush("Hi I was wondering", UTTERANCE_QUIET_MS), true);
});

check("replayed fragments are not duplicated in the sentence", () => {
  const merged = normalizeUtterance(mergeFinal("Hi how are you", "how are you"));
  assert.equal(merged.split("how are you").length - 1, 1, merged);
  assert.ok(merged.includes("hi"), merged);
});

check("the whole thought is submitted once, not the first word", () => {
  // Chrome finalises "Hi" first, then delivers the rest of the same sentence.
  let buffer = "";
  const submitted: string[] = [];
  for (const text of ["Hi", "how are you doing", "how are you doing"]) {
    buffer = mergeFinal(buffer, text);
    if (shouldFlush(buffer, 0)) {
      submitted.push(buffer);
      buffer = "";
    }
  }
  if (buffer) submitted.push(buffer); // quiet window or engine restart released it
  assert.deepEqual(submitted, ["Hi how are you doing"]);
});

/* ------------------------- human-like small talk ------------------------- */

const answerCtx = {
  assistantName: "Brian",
  timeZone: "UTC",
  now: new Date("2026-11-10T09:00:00Z"),
} as unknown as AnswerCtx;

const WARM = /doing (well|good)|pretty good|all good|i'm good/i;

check('"how u doing" gets a warm answer instead of a fallback', () => {
  const { reply } = localAnswer("how u doing", answerCtx);
  assert.ok(WARM.test(reply), reply);
});

check("casual spellings reach the same intent", () => {
  assert.ok(WARM.test(localAnswer("how r u", answerCtx).reply));
  assert.ok(WARM.test(localAnswer("you good?", answerCtx).reply));
});

check("a greeting still works", () => {
  const { reply } = localAnswer("hi", answerCtx);
  assert.ok(/brian here|listening|morning|afternoon|evening/i.test(reply), reply);
});

check("greeting plus a question answers the question", () => {
  const { reply } = localAnswer("hi, how are you?", answerCtx);
  assert.ok(WARM.test(reply), reply);
});

/* ---------------------------- silence check-ins ---------------------------- */

const ci = (o: Record<string, unknown>) => pickCheckIn(o as unknown as CheckInCtx);

check("a check-in waits the configured silence before speaking", () => {
  assert.equal(checkInDelayMs(120_000, 0), 120_000);
  assert.ok(checkInDelayMs(120_000, 1) > 120_000);
});

check("check-ins are varied and stop after a few", () => {
  const lines = new Set<string>();
  for (let seed = 0; seed < 40; seed += 1) {
    lines.add(ci({ hour: 14, attempt: 0, assistantName: "Brian", seed }));
  }
  assert.ok(lines.size >= 3, `only ${lines.size} distinct lines`);
  assert.ok(MAX_CHECK_INS >= 2 && MAX_CHECK_INS <= 5, String(MAX_CHECK_INS));
});

check("a late-night check-in does not say good morning", () => {
  for (let seed = 0; seed < 40; seed += 1) {
    const line = ci({ hour: 2, attempt: 0, assistantName: "Brian", seed });
    assert.ok(!/morning/i.test(line), line);
  }
});

check("a check-in is a spoken line, not an empty string", () => {
  for (let seed = 0; seed < 20; seed += 1) {
    assert.ok(ci({ hour: 9, attempt: 0, seed }).trim().length > 5);
  }
});

if (failures > 0) {
  console.error(`\n${failures} voice-guard check(s) failed`);
  process.exit(1);
}
console.log("\nall voice-guard checks passed");
