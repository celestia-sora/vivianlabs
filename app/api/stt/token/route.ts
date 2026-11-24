import { requireApiAccess } from "@/lib/auth/server";
import { NextResponse } from "next/server";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";

export const maxDuration = 15;

const TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";

/**
 * Mints a short-lived, single-use ElevenLabs token so the browser can open the
 * Scribe v2 Realtime WebSocket without ever seeing the API key.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const quota = rateLimit(request, "stt-token", 30);
  if (!quota.allowed) return rateLimitedResponse(quota.retryAfter);
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return NextResponse.json({ error: "ELEVENLABS_API_KEY is not configured", status: 500 }, { status: 500 });
  try {
    const response = await fetch(TOKEN_URL, { method: "POST", headers: { "xi-api-key": key }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      console.warn("Scribe token rejected", { status: response.status });
      return NextResponse.json({ error: "Realtime token request failed", status: response.status }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const data = await response.json() as { token?: unknown };
    if (typeof data.token !== "string" || !data.token) {
      return NextResponse.json({ error: "Realtime token response was invalid", status: 502 }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ token: data.token }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.warn("Scribe token unavailable", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "Realtime token unavailable", status: timedOut ? 504 : 502 }, { status: timedOut ? 504 : 502, headers: { "Cache-Control": "no-store" } });
  }
}
