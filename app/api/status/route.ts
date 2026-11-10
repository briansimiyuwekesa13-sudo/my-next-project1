import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Reports which brain is available, without leaking any key material.
 * The keyless community model means open-ended answers work even before the
 * user connects a key of their own.
 */
export async function GET() {
  const serverKey = Boolean(process.env.OPENAI_API_KEY);
  return NextResponse.json({
    mode: "ai",
    model: serverKey ? process.env.OPENAI_MODEL || "gpt-4o-mini" : "community model",
    providers: {
      serverKey,
      community: true,
      userKeySupported: true,
    },
  });
}
