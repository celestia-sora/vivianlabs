// Local AuthUser shape (verified identity from vivianAuth /api/verify).
export interface AuthUserLike {
  email?: string | null;
  email_confirmed_at?: string | null;
  is_anonymous?: boolean;
}

export const PRIMARY_LEGACY_EMAIL = "suphloeksangko@gmail.com";
export const SELECTED_REQUEST_EMAIL = "viviannextlabs@gmail.com";

export const SORACHAN_EMAILS = new Set<string>([
  PRIMARY_LEGACY_EMAIL,
  "duckchan690@gmail.com",
]);

export function normalizeEmail(email: string | null | undefined): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function isSorachanEmail(email: string | null | undefined): boolean {
  const normalized = normalizeEmail(email);
  return normalized.length > 0 && SORACHAN_EMAILS.has(normalized);
}

// Any confirmed, non-anonymous account with a non-empty email can access the Free tier.
export function isAllowedUser(user: AuthUserLike | null): boolean {
  const email = normalizeEmail(user?.email);
  const confirmed = typeof user?.email_confirmed_at === "string" && user.email_confirmed_at.trim().length > 0;
  return Boolean(user && !user.is_anonymous && email && confirmed);
}

export function isSameOriginMutation(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  // Next may normalize request.url to its internal hostname. Host identifies
  // the origin the browser actually requested; no forwarded-host redirect is used.
  const target = new URL(request.url);
  const host = request.headers.get("host");
  if (host) target.host = host;
  return origin === target.origin;
}
