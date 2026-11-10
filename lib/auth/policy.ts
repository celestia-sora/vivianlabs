// Local AuthUser shape (verified identity from vivianAuth /api/verify).
export interface AuthUserLike {
  email?: string | null;
  email_confirmed_at?: string | null;
  is_anonymous?: boolean;
}

const INVITED_EMAILS = new Set([
  "suphloeksangko@gmail.com",
  "duckchan690@gmail.com",
]);

// Only confirmed, non-anonymous accounts on the invitation list can access.
// Normalize case and surrounding whitespace before checking the verified email.
export function isAllowedUser(user: AuthUserLike | null): boolean {
  const email = user?.email?.trim().toLowerCase();
  return Boolean(user && !user.is_anonymous && email && INVITED_EMAILS.has(email) && user.email_confirmed_at);
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
