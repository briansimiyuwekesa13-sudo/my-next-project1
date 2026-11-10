import { NextResponse } from "next/server";
import { buildSystemPrompt, detectAction, localAnswer } from "@/lib/assistant";
import type { AssistantSettings, ChatTurn } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TURNS = 20;
const MAX_CHARS = 4000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 40;
const PROVIDER_TIMEOUT_MS = 20_000;

/**
 * Keyless, OpenAI-compatible endpoint. Used only when neither the user's own
 * key nor a server key is configured, so open-ended questions still get a real
 * answer out of the box. Settings can switch it off for stricter privacy.
 */
const COMMUNITY_ENDPOINT = "https://text.pollinations.ai/openai";
const COMMUNITY_MODEL = "openai";

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

/** Accepts only a plausible key string; never logged, never persisted here. */
function sanitizeKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim();
  if (key.length < 16 || key.length > 220) return undefined;
  if (!/^[\x21-\x7e]+$/.test(key)) return undefined;
  return key;
}

interface Provider {
  id: "user-key" | "server-key" | "community";
  endpoint: string;
  key?: string;
  model: string;
}

function buildChain(userKey: string | undefined, useCommunity: boolean): Provider[] {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const endpoint = `${base}/chat/completions`;

  const chain: Provider[] = [];
  if (userKey) chain.push({ id: "user-key", endpoint, key: userKey, model });

  const serverKey = process.env.OPENAI_API_KEY?.trim();
  if (serverKey && serverKey !== userKey) {
    chain.push({ id: "server-key", endpoint, key: serverKey, model });
  }
  if (useCommunity) {
    chain.push({ id: "community", endpoint: COMMUNITY_ENDPOINT, model: COMMUNITY_MODEL });
  }
  return chain;
}

async function callProvider(
  provider: Provider,
  messages: { role: string; content: string }[],
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.key ? { Authorization: `Bearer ${provider.key}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.7,
      max_tokens: 350,
      messages,
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // Deliberately no headers or key material in this message.
    throw new Error(`${provider.id}:${response.status}:${detail.slice(0, 120)}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error(`${provider.id}:empty`);
  return reply;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local";

  if (isRateLimited(ip)) {
    return jsonError("Too many requests — give me a second.", 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const turns = sanitizeTurns(payload.messages);
  const lastUser = [...turns].reverse().find((t) => t.role === "user");

  if (!lastUser) {
    return jsonError("A user message is required.", 400);
  }

  const settings = sanitizeSettings(payload.settings);
  const platform: "web" | "android" =
    payload.platform === "android" ? "android" : "web";

  const now = new Date();
  const timeZone =
    typeof payload.timeZone === "string" && payload.timeZone.length < 64
      ? payload.timeZone
      : undefined;

  const ctx = {
    assistantName: settings.assistantName || "Brian",
    personality: settings.personality,
    timeZone,
    now,
    platform,
  };

  // Device intents are decided locally so the answer and the action agree.
  const action = detectAction(lastUser.content, ctx);

  const userKey = sanitizeKey(payload.apiKey);
  const useCommunity = payload.useCommunityModel !== false;
  const chain = buildChain(userKey, useCommunity);

  if (chain.length === 0) {
    const local = localAnswer(lastUser.content, ctx);
    return NextResponse.json({
      reply: local.reply,
      mode: "offline",
      action: local.action,
      note: "No model connected — answered on-device.",
    });
  }

  const messages = [
    { role: "system", content: buildSystemPrompt(settings, ctx) },
    ...turns.map((t) => ({ role: t.role, content: t.content })),
  ];

  const failures: string[] = [];

  for (const provider of chain) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
      const reply = await callProvider(provider, messages, controller.signal);
      return NextResponse.json({
        reply,
        mode: "ai",
        action,
        model: provider.id === "community" ? "community model" : provider.model,
        provider: provider.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      failures.push(message);
      console.error("chat provider failed:", message.slice(0, 200));
    } finally {
      clearTimeout(timeout);
    }
  }

  const local = localAnswer(lastUser.content, ctx);
  const keyRejected = failures.some(
    (f) => f.startsWith("user-key:401") || f.startsWith("user-key:403"),
  );

  return NextResponse.json({
    reply: local.reply,
    mode: "offline",
    action: local.action,
    note: keyRejected
      ? "That saved key was rejected — check it in Settings."
      : "Could not reach a model; answered on-device.",
  });
}
