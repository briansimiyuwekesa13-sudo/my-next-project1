import { NextResponse } from "next/server";
import { GROQ_BASE_URL, groqModel, serverGroqKey } from "@/lib/groq";

export const dynamic = "force-dynamic";

/**
 * Reports which brain is available, without leaking any key material.
 * There is no community model any more: either the user's Groq key (or a
 * server-side one) answers, or the app says plainly that none is configured.
 */
export async function GET() {
  return NextResponse.json({
    mode: "ai",
    provider: "groq",
    model: groqModel(),
    baseUrl: GROQ_BASE_URL,
    providers: {
      groq: true,
      serverKey: Boolean(serverGroqKey()),
      userKeySupported: true,
      community: false,
    },
  });
}
