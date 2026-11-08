import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Reports whether a language model is wired up, without leaking any key. */
export async function GET() {
  const configured = Boolean(process.env.OPENAI_API_KEY);
  return NextResponse.json({
    mode: configured ? "ai" : "offline",
    model: configured ? process.env.OPENAI_MODEL || "gpt-4o-mini" : null,
  });
}
