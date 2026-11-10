import { NextResponse } from "next/server";
import { groqChat, noKeyFailure, resolveGroqKey } from "@/lib/groq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 60_000;
const MAX_CHECKS = 10;
const buckets = new Map<string, { count: number; resetAt: number }>();

function limited(ip: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_CHECKS;
}

/**
 * Real connection test for the saved key: makes one tiny Chat Completions call
 * to Groq and reports the mapped outcome. The key is never echoed back.
 */
export async function POST(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local";

  if (limited(ip)) {
    return NextResponse.json(
      { ok: false, message: "Too many connection tests — give it a moment." },
      { status: 429 },
    );
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const resolved = resolveGroqKey(payload.apiKey);

  if (!resolved) {
    const failure = noKeyFailure();
    return NextResponse.json(
      { ok: false, code: failure.code, message: failure.message, hint: failure.hint },
      { status: failure.status },
    );
  }

  const started = Date.now();
  const result = await groqChat({
    key: resolved.key,
    messages: [{ role: "user", content: "Reply with the single word: ready" }],
    maxTokens: 96,
    temperature: 0,
    timeoutMs: 15_000,
  });

  if (!result.ok) {
    console.error("groq connection test failed:", result.failure.code, result.failure.status);
    return NextResponse.json(
      {
        ok: false,
        code: result.failure.code,
        message: result.failure.message,
        hint: result.failure.hint,
        retryAfterMs: result.failure.retryAfterMs,
      },
      { status: result.failure.status },
    );
  }

  return NextResponse.json({
    ok: true,
    model: result.model,
    latencyMs: Date.now() - started,
    keySource: resolved.source,
    sample: result.reply.slice(0, 80),
  });
}
