import { NextResponse } from "next/server";
import { buildSystemPrompt, detectAction, localAnswer } from "@/lib/assistant";
import {
  groqChat,
  noKeyFailure,
  resolveGroqKey,
  type GroqFailure,
  type GroqMessage,
} from "@/lib/groq";
import type { AssistantSettings, ChatTurn } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Groq's gpt-oss-120b has a large context window, so we send a real thread
 * rather than the last question alone. This is what makes "and tomorrow?",
 * "what about the second one?" and pronoun follow-ups work.
 */
const MAX_TURNS = 24;
const MAX_CHARS = 4000;
const MAX_CONTEXT_CHARS = 24_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 40;
const PROVIDER_TIMEOUT_MS = 25_000;
const MAX_TOKENS = 700;

const buckets = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_MAX;
}

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}

function sanitizeTurns(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ChatTurn[] = [];
  for (const item of raw.slice(-MAX_TURNS)) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const text = content.trim().slice(0, MAX_CHARS);
    if (!text) continue;
    turns.push({ role, content: text });
  }
  return turns;
}

function sanitizeSettings(raw: unknown): Partial<AssistantSettings> {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const out: Partial<AssistantSettings> = {};
  if (typeof input.assistantName === "string") out.assistantName = input.assistantName.slice(0, 40);
  if (input.personality === "friendly" || input.personality === "concise" || input.personality === "warm") {
    out.personality = input.personality;
  }
  return out;
}

/** Keeps the most recent turns that fit the context budget. */
function trimToBudget(turns: ChatTurn[]): ChatTurn[] {
  const kept: ChatTurn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (total + turn.content.length > MAX_CONTEXT_CHARS) break;
    kept.unshift(turn);
    total += turn.content.length;
  }
  return kept;
}

function failureResponse(failure: GroqFailure) {
  // No key material, no upstream headers: only the mapped, speakable message.
  return NextResponse.json(
    {
      error: failure.message,
      reply: failure.message,
      hint: failure.hint,
      code: failure.code,
      retryAfterMs: failure.retryAfterMs,
      mode: "offline",
      source: "groq",
    },
    { status: failure.status },
  );
}

export async function POST(request: Request) {
  if (isRateLimited(clientIp(request))) {
    return NextResponse.json(
      { error: "Too many requests — give me a second.", reply: "Too many requests — give me a second." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const turns = sanitizeTurns(payload.messages);
  const lastUserTurn = [...turns].reverse().find((t) => t.role === "user");

  // The client sends the live utterance separately; older clients only sent it
  // inside `messages`, so both shapes are accepted.
  const current =
    (typeof payload.message === "string" ? payload.message.trim().slice(0, MAX_CHARS) : "") ||
    lastUserTurn?.content ||
    "";

  if (!current) {
    return NextResponse.json({ error: "A user message is required." }, { status: 400 });
  }

  // Avoid sending the same sentence twice when the client already appended it.
  const history = [...turns];
  while (
    history.length > 0 &&
    history[history.length - 1].role === "user" &&
    history[history.length - 1].content === current
  ) {
    history.pop();
  }

  const settings = sanitizeSettings(payload.settings);

  // A caller may name a specific Groq model, but the default stays
  // openai/gpt-oss-120b. Nothing is ever swapped for a weaker model silently:
  // an unusable name is reported back instead of being replaced.
  const requestedModel =
    typeof payload.model === "string" && /^[A-Za-z0-9._:/-]{1,64}$/.test(payload.model.trim())
      ? payload.model.trim()
      : undefined;
  const platform: "web" | "android" = payload.platform === "android" ? "android" : "web";
  const timeZone =
    typeof payload.timeZone === "string" && payload.timeZone.length < 64
      ? payload.timeZone
      : undefined;

  const ctx = {
    assistantName: settings.assistantName || "Brian",
    personality: settings.personality,
    timeZone,
    now: new Date(),
    platform,
  };

  // Device intents are decided locally so the spoken answer and the phone
  // action always agree. This is phone integration, not the language model.
  const action = detectAction(current, ctx);
  const local = localAnswer(current, ctx);

  const resolved = resolveGroqKey(payload.apiKey);

  // Exact, instant utilities stay on-device (time, date, maths, conversions):
  // a model can get those subtly wrong, and they must work with no key at all.
  const hasAction = Boolean(action && action.type !== "none");
  const isUtility = local.deterministic === true || hasAction;

  if (isUtility) {
    const reply =
      local.confident === false
        ? hasAction && action
          ? `Okay — ${action.label.toLowerCase()}.`
          : local.reply
        : local.reply;
    return NextResponse.json({
      reply,
      mode: "offline",
      action: local.action ?? (hasAction ? action : undefined),
      source: "device",
    });
  }

  if (!resolved) {
    // No model configured. Answer on-device when the device brain actually
    // knows the answer; otherwise say plainly that a key is needed. Never
    // pretend a weak shared model answered.
    if (local.confident !== false) {
      return NextResponse.json({
        reply: local.reply,
        mode: "offline",
        action: local.action ?? action,
        source: "device",
        note: "Add your Groq API key in Settings for open-ended answers.",
      });
    }
    return failureResponse(noKeyFailure());
  }

  const messages: GroqMessage[] = [
    { role: "system", content: buildSystemPrompt(settings, ctx) },
    ...trimToBudget(history).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: current },
  ];

  const result = await groqChat({
    key: resolved.key,
    model: requestedModel,
    messages,
    maxTokens: MAX_TOKENS,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });

  if (!result.ok) {
    // Only the failure code is logged — never the key, prompt or user's words.
    console.error("groq request failed:", result.failure.code, result.failure.status);
    return failureResponse(result.failure);
  }

  return NextResponse.json({
    reply: result.reply,
    mode: "ai",
    action,
    source: "groq",
    provider: "groq",
    model: result.model,
    keySource: resolved.source,
    usage: result.usage,
  });
}
