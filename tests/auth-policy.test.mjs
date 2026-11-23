import assert from "node:assert/strict";
import test from "node:test";
import { loadSceneModule as load } from "./scene-module-loader.mjs";
import {
  PRIMARY_LEGACY_EMAIL,
  SELECTED_REQUEST_EMAIL,
  SORACHAN_EMAILS,
  isAllowedUser,
  isSameOriginMutation,
  isSorachanEmail,
} from "../lib/auth/policy.ts";

const user = (email, extras = {}) => ({
  email,
  email_confirmed_at: "2026-10-02T00:00:00Z",
  is_anonymous: false,
  ...extras,
});

test("any confirmed, non-anonymous account with a non-empty email can access", () => {
  assert.equal(isAllowedUser(user("suphloeksangko@gmail.com")), true);
  assert.equal(isAllowedUser(user("duckchan690@gmail.com")), true);
  assert.equal(isAllowedUser(user(" SUPHLOEKSANGKO@GMAIL.COM ")), true);
  assert.equal(isAllowedUser(user("new.free.user@example.com")), true);
});

test("sorachan and legacy email constants remain intact and case-insensitive", () => {
  assert.equal(PRIMARY_LEGACY_EMAIL, "suphloeksangko@gmail.com");
  assert.equal(SELECTED_REQUEST_EMAIL, "viviannextlabs@gmail.com");
  assert.equal(SORACHAN_EMAILS.has("suphloeksangko@gmail.com"), true);
  assert.equal(SORACHAN_EMAILS.has("duckchan690@gmail.com"), true);
  assert.equal(isSorachanEmail("SUPHLOEKSANGKO@GMAIL.COM"), true);
  assert.equal(isSorachanEmail("  duckchan690@gmail.com "), true);
  assert.equal(isSorachanEmail("new.free.user@example.com"), false);
  assert.equal(isSorachanEmail(null), false);
});

test("unconfirmed, anonymous, and missing-email identities cannot access", () => {
  for (const identity of [
    null,
    user(undefined),
    user("", { email_confirmed_at: "2026-10-02T00:00:00Z" }),
    user("   ", { email_confirmed_at: "2026-10-02T00:00:00Z" }),
    user("suphloeksangko@gmail.com", { email_confirmed_at: null }),
    user("suphloeksangko@gmail.com", { email_confirmed_at: "   " }),
    user("duckchan690@gmail.com", { is_anonymous: true }),
    user("attacker@example.com", { email_confirmed_at: null, user_metadata: { email: "duckchan690@gmail.com", email_verified: true } }),
  ]) {
    assert.equal(isAllowedUser(identity), false);
  }
});

test("cookie-authenticated mutations reject cross-site origins", () => {
  const url = "https://vivian-chan.vercel.app/api/memory";
  assert.equal(isSameOriginMutation(new Request(url, { method: "POST", headers: { origin: "https://vivian-chan.vercel.app" } })), true);
  assert.equal(isSameOriginMutation(new Request(url, { method: "POST", headers: { origin: "https://evil.example" } })), false);
  assert.equal(isSameOriginMutation(new Request(url, { method: "POST", headers: { origin: "null" } })), false);
  assert.equal(isSameOriginMutation(new Request(url, { method: "POST", headers: { "sec-fetch-site": "cross-site" } })), false);
  assert.equal(isSameOriginMutation(new Request(url, { method: "GET" })), true);
  assert.equal(isSameOriginMutation(new Request("https://localhost/api/memory", { method: "POST", headers: { host: "vivian-chan.vercel.app", origin: "https://vivian-chan.vercel.app" } })), true);
});

test("authFetch preserves token and stays on page for tier/quota/admin 403 codes", async () => {
  for (const code of ["TIER_REQUIRED", "QUOTA_EXCEEDED", "STORAGE_QUOTA_EXCEEDED", "ADMIN_REQUIRED"]) {
    const store = new Map([["vivian_auth_token", "tok-123"]]);
    const redirects = [];
    const windowMock = {
      localStorage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
      },
      location: { replace: (url) => redirects.push(url) },
    };
    const fetchMod = load(
      "../lib/auth/fetch.ts",
      {},
      {
        window: windowMock,
        Headers,
        fetch: async () => Response.json({ error: "Denied by tier", code }, { status: 403 }),
      },
    );
    const response = await fetchMod.authFetch("/api/chat", { method: "POST" });
    assert.equal(response.status, 403);
    assert.equal(store.get("vivian_auth_token"), "tok-123");
    assert.deepEqual(redirects, []);
    // Body must remain readable by caller (response.clone() used internally).
    const parsed = await response.json();
    assert.equal(parsed.code, code);
  }
});

test("authFetch clears token and redirects on ACCESS_DENIED, non-JSON 403, and 401", async () => {
  for (const scenario of [
    { status: 403, response: () => Response.json({ error: "Denied", code: "ACCESS_DENIED" }, { status: 403 }), expectCleared: true, expectUrl: "/access-denied" },
    { status: 403, response: () => new Response("Forbidden", { status: 403 }), expectCleared: true, expectUrl: "/access-denied" },
    { status: 401, response: () => Response.json({ error: "Expired", code: "AUTH_REQUIRED" }, { status: 401 }), expectCleared: false, expectUrl: "/login?error=session_expired" },
  ]) {
    const store = new Map([["vivian_auth_token", "tok-123"]]);
    const redirects = [];
    const windowMock = {
      localStorage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
      },
      location: { replace: (url) => redirects.push(url) },
    };
    const fetchMod = load(
      "../lib/auth/fetch.ts",
      {},
      {
        window: windowMock,
        Headers,
        fetch: async () => scenario.response(),
      },
    );
    const response = await fetchMod.authFetch("/api/memory");
    assert.equal(response.status, scenario.status);
    assert.equal(store.has("vivian_auth_token"), !scenario.expectCleared);
    assert.deepEqual(redirects, [scenario.expectUrl]);
  }
});

test("DEV_BYPASS_LOGIN grants dev@localhost only in development", async () => {
  const policy = load("../lib/auth/policy.ts");
  const nextServer = {
    NextResponse: {
      json: (body, init) => Response.json(body, init),
    },
  };
  const react = { cache: (fn) => fn };

  const devMod = load(
    "../lib/auth/server.ts",
    { "./policy": policy, "next/server": nextServer, react },
    { process: { env: { NODE_ENV: "development", DEV_BYPASS_LOGIN: "true" } } },
  );
  const devResult = await devMod.getAuthAccess();
  assert.equal(devResult.error, null);
  assert.equal(devResult.user.id, "dev-local-preview");
  assert.equal(devResult.user.email, "dev@localhost");
  assert.equal(policy.isAllowedUser(devResult.user), true);

  const prodMod = load(
    "../lib/auth/server.ts",
    { "./policy": policy, "next/server": nextServer, react },
    { process: { env: { NODE_ENV: "production", DEV_BYPASS_LOGIN: "true" } } },
  );
  const prodResult = await prodMod.getAuthAccess();
  assert.equal(prodResult.user, null);
  assert.equal(prodResult.error.code, "AUTH_UNAVAILABLE");
});
