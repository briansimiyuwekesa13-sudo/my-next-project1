/**
 * Server-only Groq client.
 *
 * Groq exposes an OpenAI-compatible Chat Completions API, so the wire format is
 * familiar — but the endpoint, model names and error shapes are Groq's own.
 *
 * This module is imported exclusively by route handlers. Nothing here may be
 * pulled into a client component: the API key must never reach the browser,
 * a log line or a response body.
 */

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";

export type GroqErrorCode =
  | "no_key"
  | "invalid_key"
  | "model_unavailable"
  | "rate_limited"
  | "timeout"
  | "upstream"
  | "empty_reply"
  | "bad_request";

export interface GroqFailure {
  code: GroqErrorCode;
  /** HTTP status we hand back to our own client. */
  status: number;
  /** Speakable sentence, safe to show the user. */
  message: string;
  /** What the user can do about it. */
  hint: string;
  retryAfterMs?: number;
}

export interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GroqSuccess {
  ok: true;
  reply: string;
  model: string;
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export type GroqResult = GroqSuccess | { ok: false; failure: GroqFailure };

export type KeySource = "user" | "server";

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/**
 * Base URL for the API. GROQ_BASE_URL exists so the test suite can point at a
 * local mock; production always resolves to Groq itself.
 */
export function groqBaseUrl(): string {
  const configured = process.env.GROQ_BASE_URL?.trim();
  return (configured || GROQ_BASE_URL).replace(/\/+$/, "");
}

/** Default model: openai/gpt-oss-120b, overridable per deployment. */
export function groqModel(): string {
  return process.env.GROQ_MODEL?.trim() || GROQ_DEFAULT_MODEL;
}

export function serverGroqKey(): string | undefined {
  const key = process.env.GROQ_API_KEY?.trim();
  return key ? key : undefined;
}

/** Accepts only a plausible key string; never logged, never persisted here. */
export function sanitizeGroqKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim();
  if (key.length < 16 || key.length > 220) return undefined;
  if (!/^[\x21-\x7e]+$/.test(key)) return undefined;
  return key;
}

/**
 * The key the user saved on the device always wins, so every AI request is made
 * with *their* key. A server-side key is only a fallback for a shared install.
 */
export function resolveGroqKey(userKey?: unknown): { key: string; source: KeySource } | null {
  const fromUser = sanitizeGroqKey(userKey);
  if (fromUser) return { key: fromUser, source: "user" };
  const fromServer = serverGroqKey();
  if (fromServer) return { key: fromServer, source: "server" };
  return null;
}

/** Strips anything key-shaped before text can reach a log or a response. */
export function redactSecret(text: string): string {
  return text
    .replace(/gsk_[A-Za-z0-9_-]{8,}/g, "gsk_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["'\s:=]+[A-Za-z0-9._-]{8,}/gi, "api_key=[redacted]");
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export function noKeyFailure(): GroqFailure {
  return {
    code: "no_key",
    status: 503,
    message: "I don't have a Groq API key yet, so I can only do on-device things like timers, calls and apps.",
    hint: "Open Settings, paste your Groq API key (it starts with gsk_) and I'll answer anything.",
  };
}

function parseRetryAfter(header: string | null | undefined, detail: string): number | null {
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
  }
  const match = detail.match(/try again in\s+([\d.]+)\s*(ms|s|seconds?)/i);
  if (match) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) {
      return Math.max(1, Math.ceil(match[2].toLowerCase() === "ms" ? value / 1000 : value));
    }
  }
  return null;
}

/**
 * Turns a Groq HTTP response into a message the user can act on. Invalid keys,
 * unavailable models and rate limits each get their own wording — the previous
 * build collapsed all of them into one vague "couldn't reach a model" note.
 */
export function mapGroqFailure(
  status: number,
  body: string,
  retryAfterHeader?: string | null,
  model: string = groqModel(),
): GroqFailure {
  const detail = redactSecret(body).replace(/\s+/g, " ").trim().slice(0, 300);
  const modelComplaint =
    /model/i.test(detail) &&
    /(not found|does not exist|decommission|deactivat|unsupported|invalid model|no access|not supported)/i.test(detail);

  if (status === 401) {
    return {
      code: "invalid_key",
      status: 401,
      message: "Groq rejected that API key.",
      hint: "Check the key in Settings — it should start with gsk_ and still be active on console.groq.com.",
    };
  }

  if (status === 403) {
    return {
      code: "invalid_key",
      status: 403,
      message: "That Groq key isn't allowed to use this model.",
      hint: `Make sure your Groq project has access to ${model}.`,
    };
  }

  if (status === 404 || modelComplaint) {
    return {
      code: "model_unavailable",
      status: 404,
      message: `The model ${model} isn't available on your Groq account.`,
      hint: "Switch to the default openai/gpt-oss-120b, or set GROQ_MODEL to a model your account can use.",
    };
  }

  if (status === 429) {
    const seconds = parseRetryAfter(retryAfterHeader, detail);
    return {
      code: "rate_limited",
      status: 429,
      message: seconds
        ? `Groq is rate limiting me — try again in about ${seconds} seconds.`
        : "Groq is rate limiting me right now — give it a moment.",
      hint: "Wait a few seconds, or check your Groq plan's requests-per-minute limit.",
      retryAfterMs: seconds ? seconds * 1000 : undefined,
    };
  }

  if (status === 413) {
    return {
      code: "bad_request",
      status: 413,
      message: "That conversation got too long for one request.",
      hint: "Start a new conversation to keep things fast.",
    };
  }

  if (status >= 500) {
    return {
      code: "upstream",
      status: 502,
      message: "Groq is having trouble answering right now.",
      hint: "Try again in a moment — your key and settings are fine.",
    };
  }

  return {
    code: "bad_request",
    status: 400,
    message: `Groq couldn't handle that request${detail ? `: ${detail}` : "."}`,
    hint: "Try rephrasing, or check the model name in Settings.",
  };
}

/* ------------------------------------------------------------------ *
 * Chat Completions
 * ------------------------------------------------------------------ */

export async function groqChat(options: {
  key: string;
  model?: string;
  messages: GroqMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<GroqResult> {
  const model = options.model?.trim() || groqModel();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 25_000);

  const body: Record<string, unknown> = {
    model,
    messages: options.messages,
    temperature: options.temperature ?? 0.7,
    top_p: 0.95,
    max_tokens: options.maxTokens ?? 700,
    stream: false,
  };

  // gpt-oss reasons before it answers; "low" keeps spoken replies quick without
  // hurting quality. Other Groq models reject the field, so only send it there.
  if (/gpt-oss/i.test(model)) body.reasoning_effort = "low";

  try {
    const response = await fetch(`${groqBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.key}`,
        "User-Agent": "Brian-Voice-Assistant/1.0",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        failure: mapGroqFailure(response.status, text, response.headers.get("retry-after"), model),
      };
    }

    const data = (await response.json()) as {
      model?: string;
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!reply) {
      return {
        ok: false,
        failure: {
          code: "empty_reply",
          status: 502,
          message: "Groq answered with nothing I could read out.",
          hint: "Try asking again — if it keeps happening, switch the model in Settings.",
        },
      };
    }

    return {
      ok: true,
      reply,
      model: data.model || model,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      usage: data.usage,
    };
  } catch (error) {
    const aborted =
      error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
    return {
      ok: false,
      failure: aborted
        ? {
            code: "timeout",
            status: 504,
            message: "Groq took too long to answer.",
            hint: "Try again — shorter questions come back faster.",
          }
        : {
            code: "upstream",
            status: 502,
            message: "I couldn't reach Groq just now.",
            hint: "Check the connection and try again.",
          },
    };
  } finally {
    clearTimeout(timeout);
  }
}
