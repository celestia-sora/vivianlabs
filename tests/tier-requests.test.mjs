import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  TierRequestError,
  buildSelectedRequestMailto,
  buildTierReviewUrls,
  createSelectedTierRequest,
  createTierActionToken,
  listAllTierRequests,
  listUserTierRequests,
  reviewTierRequest,
  reviewTierRequestByToken,
  verifyTierActionToken,
} from "../lib/tier-requests.ts";
import { TierError, ensureUserAccount } from "../lib/user-tiers.ts";

function createRequestDb() {
  const accounts = new Map();
  const requests = [];

  const db = {
    accounts,
    requests,
    async rpc(name, args) {
      if (name === "vivian_claim_legacy_data") {
        return { data: { claimed: false }, error: null };
      }
      if (name === "vivian_review_tier_request") {
        const req = requests.find((r) => r.id === args.p_request_id);
        if (!req) return { data: null, error: { code: "P0002", message: "Not found" } };
        const targetStatus = args.p_action === "approve" ? "approved" : "rejected";
        if (req.status !== "pending") {
          if (req.status === targetStatus) {
            return { data: { already_reviewed: true, request: { ...req } }, error: null };
          }
          return { data: null, error: { code: "23514", message: "Already reviewed" } };
        }
        req.status = targetStatus;
        req.reviewed_by = args.p_reviewed_by;
        req.review_note = args.p_review_note ?? "";
        req.reviewed_at = "2026-11-23T07:00:00.000Z";
        req.updated_at = "2026-11-23T07:00:00.000Z";
        if (args.p_action === "approve") {
          const acc = accounts.get(req.user_id) ?? {
            user_id: req.user_id,
            email: req.email,
            tier: "free",
            legacy_claimed_at: null,
            created_at: "2026-11-23T00:00:00.000Z",
            updated_at: "2026-11-23T00:00:00.000Z",
          };
          if (acc.tier !== "sorachan") acc.tier = "selected";
          accounts.set(req.user_id, acc);
        }
        return { data: { already_reviewed: false, request: { ...req } }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
    from(table) {
      let action = "select";
      let payload = null;
      let options = {};
      const filters = [];
      let single = false;
      const q = {
        select() { return q; },
        insert(v) { action = "insert"; payload = v; return q; },
        upsert(v, opts = {}) { action = "upsert"; payload = v; options = opts; return q; },
        update(v) { action = "update"; payload = v; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        order() { return q; },
        limit() { return q; },
        maybeSingle() { single = true; return q; },
        single() { single = true; return q; },
        then(resolve, reject) {
          let result;
          if (table === "vivian_user_accounts") {
            if (action === "upsert") {
              if (!accounts.has(payload.user_id) || !options.ignoreDuplicates) {
                accounts.set(payload.user_id, {
                  legacy_claimed_at: null,
                  created_at: "2026-11-23T00:00:00.000Z",
                  updated_at: "2026-11-23T00:00:00.000Z",
                  ...accounts.get(payload.user_id),
                  ...payload,
                });
              }
              const row = accounts.get(payload.user_id);
              result = { data: single ? row : [row], error: null };
            } else if (action === "update") {
              const matched = [...accounts.values()].filter((r) => filters.every((f) => f(r)));
              for (const row of matched) Object.assign(row, payload);
              result = { data: single ? matched[0] ?? null : matched, error: null };
            } else {
              const matched = [...accounts.values()].filter((r) => filters.every((f) => f(r)));
              result = { data: single ? matched[0] ?? null : matched, error: null };
            }
          } else if (table === "vivian_tier_requests") {
            if (action === "insert") {
              if (requests.some((r) => r.user_id === payload.user_id && r.status === "pending")) {
                result = { data: null, error: { code: "23505", message: "duplicate pending" } };
              } else {
                const row = {
                  id: randomUUID(),
                  reviewed_by: null,
                  review_note: "",
                  reviewed_at: null,
                  created_at: "2026-11-23T06:00:00.000Z",
                  updated_at: "2026-11-23T06:00:00.000Z",
                  ...payload,
                };
                requests.push(row);
                result = { data: row, error: null };
              }
            } else {
              const matched = requests.filter((r) => filters.every((f) => f(r)));
              result = { data: single ? matched[0] ?? null : matched, error: null };
            }
          } else {
            result = { data: null, error: new Error(`Unknown table ${table}`) };
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return db;
}

test("HMAC-SHA256 action tokens sign, verify, reject tampering, and enforce 14-day expiry", () => {
  const reqId = "00000000-0000-4000-8000-000000000010";
  const secret = "test-tier-secret";
  const now = Date.parse("2026-11-23T00:00:00.000Z");

  const token = createTierActionToken(reqId, "approve", { now, secret });
  const verified = verifyTierActionToken(token, { now: now + 13 * 86_400_000, secret });
  assert.deepEqual(verified, {
    requestId: reqId,
    action: "approve",
    exp: now + 14 * 86_400_000,
  });

  // Expired at 14d + 1ms
  assert.equal(verifyTierActionToken(token, { now: now + 14 * 86_400_000 + 1, secret }), null);

  // Wrong secret or tampered signature fails
  assert.equal(verifyTierActionToken(token, { now, secret: "wrong-secret" }), null);
  assert.equal(verifyTierActionToken(`${token.slice(0, -1)}X`, { now, secret }), null);
  assert.equal(verifyTierActionToken("malformed", { now, secret }), null);
});

test("buildSelectedRequestMailto and buildTierReviewUrls produce valid fallback and action links", () => {
  const reqId = "00000000-0000-4000-8000-000000000011";
  const mailto = buildSelectedRequestMailto({
    userEmail: "Alice@Example.com",
    userId: "u-alice",
    displayName: "Alice",
    reason: "Want to upload my Live2D model",
    requestId: reqId,
  });
  assert.ok(mailto.startsWith("mailto:viviannextlabs@gmail.com?subject="));
  assert.match(decodeURIComponent(mailto), /alice@example\.com/);
  assert.match(decodeURIComponent(mailto), /u-alice/);

  const urls = buildTierReviewUrls(reqId, "https://vivianlabs.vercel.app", "/api/tier-requests/review", {
    secret: "unit-secret",
  });
  assert.ok(urls.approveUrl?.startsWith("https://vivianlabs.vercel.app/api/tier-requests/review?token="));
  assert.ok(urls.rejectUrl?.startsWith("https://vivianlabs.vercel.app/api/tier-requests/review?token="));
});

test("createSelectedTierRequest prevents duplicates, sends Resend when configured, and provides mailto fallback", async () => {
  const db = createRequestDb();
  const prevKey = process.env.RESEND_API_KEY;
  const prevFrom = process.env.RESEND_FROM;
  const prevSecret = process.env.TIER_ACTION_SECRET;
  const sentEmails = [];

  try {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_FROM = "Vivian <noreply@vivianlabs.example>";
    process.env.TIER_ACTION_SECRET = "tier-hmac-secret";

    const first = await createSelectedTierRequest(
      db,
      { id: "u-free", email: "free@example.com" },
      { displayName: "Free User", reason: "Testing custom models" },
      {
        baseUrl: "https://vivianlabs.vercel.app",
        fetchImpl: async (url, init) => {
          sentEmails.push({ url, body: JSON.parse(init.body) });
          return Response.json({ id: "email-1" }, { status: 200 });
        },
      },
    );

    assert.equal(first.alreadyPending, false);
    assert.equal(first.emailSent, true);
    assert.ok(first.approveUrl);
    assert.ok(first.rejectUrl);
    assert.ok(first.mailtoUrl.startsWith("mailto:viviannextlabs@gmail.com?"));
    assert.equal(sentEmails.length, 1);
    assert.deepEqual(sentEmails[0].body.to, ["viviannextlabs@gmail.com"]);

    // Second request while pending returns existing request without creating duplicate or resending email
    const dup = await createSelectedTierRequest(
      db,
      { id: "u-free", email: "free@example.com" },
      { displayName: "Free User", reason: "Second attempt" },
      {
        baseUrl: "https://vivianlabs.vercel.app",
        fetchImpl: async () => assert.fail("Must not send duplicate email"),
      },
    );
    assert.equal(dup.alreadyPending, true);
    assert.equal(dup.request.id, first.request.id);
    assert.equal(db.requests.length, 1);

    // Resend outage still saves request and provides mailto fallback
    const outage = await createSelectedTierRequest(
      db,
      { id: "u-free-2", email: "free2@example.com" },
      { reason: "Need scenes" },
      {
        baseUrl: "https://vivianlabs.vercel.app",
        fetchImpl: async () => new Response("upstream error", { status: 502 }),
      },
    );
    assert.equal(outage.alreadyPending, false);
    assert.equal(outage.emailSent, false);
    assert.ok(outage.mailtoUrl.startsWith("mailto:viviannextlabs@gmail.com?"));
  } finally {
    if (prevKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = prevKey;
    if (prevFrom === undefined) delete process.env.RESEND_FROM;
    else process.env.RESEND_FROM = prevFrom;
    if (prevSecret === undefined) delete process.env.TIER_ACTION_SECRET;
    else process.env.TIER_ACTION_SECRET = prevSecret;
  }
});

test("admin and one-click token reviews enforce permissions and promote user to selected on approval", async () => {
  const db = createRequestDb();
  const created = await createSelectedTierRequest(
    db,
    { id: "u-free", email: "free@example.com" },
    { reason: "Please upgrade" },
    { secret: "token-secret", baseUrl: "https://vivianlabs.vercel.app" },
  );

  await assert.rejects(
    () => listAllTierRequests(db, { id: "u-free", email: "free@example.com" }),
    (err) => err instanceof TierError && err.status === 403 && err.code === "ADMIN_REQUIRED",
  );
  await assert.rejects(
    () => reviewTierRequest(db, { id: "u-free", email: "free@example.com" }, { requestId: created.request.id, action: "approve" }),
    (err) => err instanceof TierError && err.status === 403 && err.code === "ADMIN_REQUIRED",
  );

  const list = await listAllTierRequests(db, { id: "u-admin", email: "duckchan690@gmail.com" });
  assert.equal(list.length, 1);

  const approveToken = new URL(created.approveUrl).searchParams.get("token");
  const rejectToken = new URL(created.rejectUrl).searchParams.get("token");

  const reviewed = await reviewTierRequestByToken(db, approveToken, { secret: "token-secret" });
  assert.equal(reviewed.action, "approve");
  assert.equal(reviewed.alreadyReviewed, false);
  assert.equal(reviewed.request.status, "approved");

  // User account is now selected
  const promoted = await ensureUserAccount(db, { id: "u-free", email: "free@example.com" });
  assert.equal(promoted.tier, "selected");

  // Already-selected user cannot create a new request
  await assert.rejects(
    () => createSelectedTierRequest(db, { id: "u-free", email: "free@example.com" }),
    (err) => err instanceof TierRequestError && err.status === 400 && err.code === "ALREADY_SELECTED",
  );

  // Re-clicking same approve link is idempotent; clicking conflicting reject link returns 409
  const idempotent = await reviewTierRequestByToken(db, approveToken, { secret: "token-secret" });
  assert.equal(idempotent.alreadyReviewed, true);
  await assert.rejects(
    () => reviewTierRequestByToken(db, rejectToken, { secret: "token-secret" }),
    (err) => err instanceof TierRequestError && err.status === 409 && err.code === "ALREADY_REVIEWED",
  );

  // User can view own request history
  const ownList = await listUserTierRequests(db, "u-free");
  assert.equal(ownList.length, 1);
  assert.equal(ownList[0].status, "approved");
});
