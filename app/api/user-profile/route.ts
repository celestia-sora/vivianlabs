import { isSorachanEmail } from "@/lib/auth/policy";
import { requireApiAccess, type AuthUser } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { validateUserProfileInput } from "@/lib/user-profile";
import { loadUserProfileServer, saveUserProfileServer } from "@/lib/user-profile-store";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  let activeUser: AuthUser | null = null;
  const denied = await requireApiAccess(request, (user) => {
    activeUser = user;
  });
  if (denied) return denied;
  const userId = activeUser!.id;
  const isSorachan = isSorachanEmail(activeUser!.email);

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    const profile = await loadUserProfileServer(db, userId, isSorachan);
    return Response.json({ userId, isSorachan, profile }, { headers });
  } catch {
    return Response.json({ error: "User profile is unavailable" }, { status: 503, headers });
  }
}

export async function PATCH(request: Request) {
  let activeUser: AuthUser | null = null;
  const denied = await requireApiAccess(request, (user) => {
    activeUser = user;
  });
  if (denied) return denied;
  const userId = activeUser!.id;
  const isSorachan = isSorachanEmail(activeUser!.email);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  const validated = validateUserProfileInput(body);
  if (!validated.ok) {
    return Response.json({ error: validated.error }, { status: 400, headers });
  }

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    const profile = await saveUserProfileServer(db, userId, isSorachan, validated.value);
    return Response.json({ userId, isSorachan, profile }, { headers });
  } catch {
    return Response.json({ error: "User profile is unavailable" }, { status: 503, headers });
  }
}
