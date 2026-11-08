import { NextResponse } from "next/server";
import { buildSystemPrompt, detectAction, localAnswer } from "@/lib/assistant";
import type { AssistantSettings, ChatTurn } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TURNS = 20;
const MAX_CHARS = 4000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 40;

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

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  if (!apiKey) {
    const local = localAnswer(lastUser.content, ctx);
    return NextResponse.json({
      reply: local.reply,
      mode: "offline",
      action: local.action,
      note: "No model key configured — using the on-device brain.",
    });
  }

  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 350,
        messages: [
          { role: "system", content: buildSystemPrompt(settings, ctx) },
          ...turns.map((t) => ({ role: t.role, content: t.content })),
        ],
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      console.error("chat upstream failed", upstream.status, detail.slice(0, 300));
      const local = localAnswer(lastUser.content, ctx);
      return NextResponse.json({
        reply: local.reply,
        mode: "offline",
        action: local.action,
        note: `Model unavailable (${upstream.status}); answered locally.`,
      });
    }

    const data = (await upstream.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      const local = localAnswer(lastUser.content, ctx);
      return NextResponse.json({
        reply: local.reply,
        mode: "offline",
        action: local.action,
        note: "Empty model response; answered locally.",
      });
    }

    return NextResponse.json({ reply, mode: "ai", action, model });
  } catch (error) {
    console.error("chat proxy error", error);
    const local = localAnswer(lastUser.content, ctx);
    return NextResponse.json({
      reply: local.reply,
      mode: "offline",
      action: local.action,
      note: "Could not reach the model; answered locally.",
    });
  } finally {
    clearTimeout(timeout);
  }
}
