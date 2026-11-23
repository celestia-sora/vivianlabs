import assert from "node:assert/strict";
import test from "node:test";
import { loadSceneModule as load } from "./scene-module-loader.mjs";
import {
  FREE_DAILY_CHAT_LIMIT,
  SELECTED_DAILY_CHAT_LIMIT,
  SELECTED_R2_STORAGE_LIMIT_BYTES,
  TierError,
  assertAndConsumeChatQuota,
  bangkokDateKey,
  consumeChatQuota,
  dailyChatLimitForTier,
  ensureUserAccount,
  getTierCapabilities,
  getUserTierSummary,
  nextBangkokMidnightIso,
  refundChatQuota,
  requireAdmin,
  requireTier,
  resolveEffectiveTier,
  setUserTier,
} from "../lib/user-tiers.ts";

function createTierDb() {
  const accounts = new Map();
  const usage = new Map();
  const storageObjects = [];
  const legacyClaims = [];

  const db = {
    accounts,
    usage,
    storageObjects,
    legacyClaims,
    async rpc(name, args) {
      if (name === "vivian_claim_legacy_data") {
        legacyClaims.push(args.p_user_id);
        const row = accounts.get(args.p_user_id);
        if (!row || row.email.toLowerCase() !== "suphloeksangko@gmail.com") {
          return { data: { claimed: false, reason: "not_primary_legacy_owner" }, error: null };
        }
        const claimedAt = row.legacy_claimed_at ?? "2026-11-23T06:00:00.000Z";
        row.legacy_claimed_at = claimedAt;
        return { data: { claimed: true, claimed_at: claimedAt }, error: null };
      }
      if (name === "vivian_consume_chat_quota") {
        const key = `${args.p_user_id}:${args.p_usage_date}`;
        const current = usage.get(key) ?? 0;
        if (current < args.p_limit) {
          const next = current + 1;
          usage.set(key, next);
          return {
            data: { allowed: true, used: next, limit: args.p_limit, remaining: args.p_limit - next, usage_date: args.p_usage_date },
            error: null,
          };
        }
        return {
          data: { allowed: false, used: current, limit: args.p_limit, remaining: 0, usage_date: args.p_usage_date },
          error: null,
        };
      }
      if (name === "vivian_refund_chat_quota") {
        const key = `${args.p_user_id}:${args.p_usage_date}`;
        const current = usage.get(key) ?? 0;
        if (current > 0) {
          usage.set(key, current - 1);
          return { data: { refunded: true, used: current - 1, usage_date: args.p_usage_date }, error: null };
        }
        return { data: { refunded: false, used: 0, usage_date: args.p_usage_date }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
    from(table) {
      let action = "select";
      let payload = null;
      let options = {};
      const filters = [];
      let isSingle = false;
      const q = {
        select() { return q; },
        upsert(val, opts = {}) { action = "upsert"; payload = val; options = opts; return q; },
        update(val) { action = "update"; payload = val; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        order() { return q; },
        range(from, to) { q._range = [from, to]; return q; },
        maybeSingle() { isSingle = true; q._allowEmpty = true; return q; },
        single() { isSingle = true; q._allowEmpty = false; return q; },
        then(resolve, reject) {
          let result;
          if (table === "vivian_user_accounts") {
            if (action === "upsert") {
              const existing = accounts.get(payload.user_id);
              if (!existing) {
                accounts.set(payload.user_id, {
                  legacy_claimed_at: null,
                  created_at: "2026-11-23T00:00:00.000Z",
                  updated_at: "2026-11-23T00:00:00.000Z",
                  ...payload,
                });
              } else if (!options.ignoreDuplicates) {
                Object.assign(existing, payload);
              }
              const row = accounts.get(payload.user_id);
              result = { data: isSingle ? row : [row], error: null };
            } else if (action === "update") {
              const matched = [...accounts.values()].filter((r) => filters.every((f) => f(r)));
              for (const row of matched) Object.assign(row, payload);
              result = { data: isSingle ? matched[0] ?? null : matched, error: null };
            } else {
              const matched = [...accounts.values()].filter((r) => filters.every((f) => f(r)));
              result = { data: isSingle ? matched[0] ?? null : matched, error: null };
            }
          } else if (table === "vivian_daily_chat_usage") {
            const rows = [...usage.entries()].map(([k, used_count]) => {
              const [user_id, usage_date] = k.split(":");
              return { user_id, usage_date, used_count };
            });
            const matched = rows.filter((r) => filters.every((f) => f(r)));
            result = { data: isSingle ? matched[0] ?? null : matched, error: null };
          } else if (table === "vivian_storage_objects") {
            let matched = storageObjects.filter((r) => filters.every((f) => f(r)));
            if (q._range) matched = matched.slice(q._range[0], q._range[1] + 1);
            result = { data: matched, error: null };
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

test("Asia/Bangkok UTC+7 date key and midnight reset boundaries", () => {
  const beforeMidnightBkk = Date.parse("2026-11-23T16:59:59.000Z"); // 23:59:59 +07:00
  const atMidnightBkk = Date.parse("2026-11-23T17:00:00.000Z"); // 00:00:00 +07:00 on Nov 24

  assert.equal(bangkokDateKey(beforeMidnightBkk), "2026-11-23");
  assert.equal(nextBangkokMidnightIso(beforeMidnightBkk), "2026-11-23T17:00:00.000Z");

  assert.equal(bangkokDateKey(atMidnightBkk), "2026-11-24");
  assert.equal(nextBangkokMidnightIso(atMidnightBkk), "2026-11-24T17:00:00.000Z");
});

test("tier limits and capabilities match free / selected / sorachan spec", () => {
  assert.equal(FREE_DAILY_CHAT_LIMIT, 5);
  assert.equal(SELECTED_DAILY_CHAT_LIMIT, 20);
  assert.equal(SELECTED_R2_STORAGE_LIMIT_BYTES, 536870912);
  assert.equal(dailyChatLimitForTier("free"), 5);
  assert.equal(dailyChatLimitForTier("selected"), 20);
  assert.equal(dailyChatLimitForTier("sorachan"), null);

  assert.deepEqual(getTierCapabilities("free"), {
    tier: "free",
    dailyChatLimit: 5,
    canUseCloudModels: false,
    canUseCloudScenes: false,
    canViewSharedModels: false,
    personalStorageLimitBytes: 0,
    isAdmin: false,
  });

  assert.deepEqual(getTierCapabilities("selected"), {
    tier: "selected",
    dailyChatLimit: 20,
    canUseCloudModels: true,
    canUseCloudScenes: true,
    canViewSharedModels: false,
    personalStorageLimitBytes: 536870912,
    isAdmin: false,
  });

  assert.deepEqual(getTierCapabilities("sorachan"), {
    tier: "sorachan",
    dailyChatLimit: null,
    canUseCloudModels: true,
    canUseCloudScenes: true,
    canViewSharedModels: true,
    personalStorageLimitBytes: null,
    isAdmin: true,
  });

  assert.equal(resolveEffectiveTier("SUPHLOEKSANGKO@GMAIL.COM", "free"), "sorachan");
  assert.equal(resolveEffectiveTier("duckchan690@gmail.com", "selected"), "sorachan");
  assert.equal(resolveEffectiveTier("stranger@example.com", "sorachan"), "free");
  assert.equal(resolveEffectiveTier("stranger@example.com", "selected"), "selected");
});

test("legacy data claim runs once and ONLY for suphloeksangko@gmail.com; duckchan690 starts isolated", async () => {
  const db = createTierDb();

  const sora1 = await ensureUserAccount(db, { id: "u-sora-1", email: "SUPHLOEKSANGKO@GMAIL.COM" });
  assert.equal(sora1.tier, "sorachan");
  assert.ok(sora1.legacyClaimedAt);
  assert.deepEqual(db.legacyClaims, ["u-sora-1"]);

  // Idempotent on subsequent logins
  const sora1Again = await ensureUserAccount(db, { id: "u-sora-1", email: "suphloeksangko@gmail.com" });
  assert.equal(sora1Again.tier, "sorachan");
  assert.deepEqual(db.legacyClaims, ["u-sora-1"]);

  // duckchan690 must NEVER claim default/global legacy rows
  const sora2 = await ensureUserAccount(db, { id: "u-sora-2", email: "duckchan690@gmail.com" });
  assert.equal(sora2.tier, "sorachan");
  assert.equal(sora2.legacyClaimedAt, null);
  assert.deepEqual(db.legacyClaims, ["u-sora-1"]);

  // free user stays free and never claims legacy rows
  const freeUser = await ensureUserAccount(db, { id: "u-free", email: "free@example.com" });
  assert.equal(freeUser.tier, "free");
  assert.deepEqual(db.legacyClaims, ["u-sora-1"]);
});

test("daily chat quota enforces 5/day for free, 20/day for selected, unlimited for sorachan, and excludes greetings/idle", async () => {
  const db = createTierDb();
  const nowDay1 = Date.parse("2026-11-23T16:30:00.000Z"); // 23:30 Bangkok on Nov 23
  const nowDay2 = Date.parse("2026-11-23T17:00:01.000Z"); // 00:00:01 Bangkok on Nov 24

  // Greetings & idle do not consume quota
  const greet = await assertAndConsumeChatQuota(db, { id: "u-free", email: "free@example.com" }, { mode: "greeting", now: nowDay1 });
  assert.equal(greet.used, 0);
  assert.equal(greet.allowed, true);

  for (let i = 1; i <= 5; i++) {
    const q = await assertAndConsumeChatQuota(db, { id: "u-free", email: "free@example.com" }, { mode: "chat", now: nowDay1 });
    assert.equal(q.used, i);
    assert.equal(q.remaining, 5 - i);
  }

  // 6th real chat throws QUOTA_EXCEEDED
  await assert.rejects(
    () => assertAndConsumeChatQuota(db, { id: "u-free", email: "free@example.com" }, { mode: "chat", now: nowDay1 }),
    (err) => err instanceof TierError && err.status === 403 && err.code === "QUOTA_EXCEEDED",
  );

  // Greeting/idle still allowed even when chat quota exhausted
  const idle = await consumeChatQuota(db, { id: "u-free", email: "free@example.com" }, { mode: "idle", now: nowDay1 });
  assert.equal(idle.allowed, true);

  // Refund restores one slot
  assert.equal(await refundChatQuota(db, "u-free", bangkokDateKey(nowDay1)), true);
  const afterRefund = await assertAndConsumeChatQuota(db, { id: "u-free", email: "free@example.com" }, { mode: "chat", now: nowDay1 });
  assert.equal(afterRefund.used, 5);

  // Midnight Asia/Bangkok resets quota for next day
  const nextDay = await assertAndConsumeChatQuota(db, { id: "u-free", email: "free@example.com" }, { mode: "chat", now: nowDay2 });
  assert.equal(nextDay.usageDate, "2026-11-24");
  assert.equal(nextDay.used, 1);

  // Selected user gets 20/day
  db.accounts.set("u-sel", { user_id: "u-sel", email: "sel@example.com", tier: "selected", legacy_claimed_at: null, created_at: "2026-11-23T00:00:00Z", updated_at: "2026-11-23T00:00:00Z" });
  for (let i = 1; i <= 20; i++) {
    const q = await assertAndConsumeChatQuota(db, { id: "u-sel", email: "sel@example.com" }, { mode: "chat", now: nowDay1 });
    assert.equal(q.used, i);
  }
  await assert.rejects(
    () => assertAndConsumeChatQuota(db, { id: "u-sel", email: "sel@example.com" }, { mode: "chat", now: nowDay1 }),
    (err) => err instanceof TierError && err.status === 403 && err.code === "QUOTA_EXCEEDED",
  );

  // Sorachan is unlimited
  for (let i = 0; i < 25; i++) {
    const q = await assertAndConsumeChatQuota(db, { id: "u-sora", email: "duckchan690@gmail.com" }, { mode: "chat", now: nowDay1 });
    assert.equal(q.limit, null);
    assert.equal(q.allowed, true);
  }
});

test("requireTier, requireAdmin, setUserTier, and getUserTierSummary enforce permissions", async () => {
  const db = createTierDb();
  await ensureUserAccount(db, { id: "u-free", email: "free@example.com" });
  await ensureUserAccount(db, { id: "u-sora", email: "suphloeksangko@gmail.com" });

  await assert.rejects(
    () => requireTier(db, { id: "u-free", email: "free@example.com" }, "selected"),
    (err) => err instanceof TierError && err.status === 403 && err.code === "TIER_REQUIRED",
  );
  await assert.rejects(
    () => requireAdmin(db, { id: "u-free", email: "free@example.com" }),
    (err) => err instanceof TierError && err.status === 403 && err.code === "ADMIN_REQUIRED",
  );

  const promoted = await setUserTier(db, "u-free", "selected");
  assert.equal(promoted.tier, "selected");
  await requireTier(db, { id: "u-free", email: "free@example.com" }, "selected");
  await requireAdmin(db, { id: "u-sora", email: "suphloeksangko@gmail.com" });

  await assert.rejects(
    () => setUserTier(db, "u-sora", "free"),
    (err) => err instanceof TierError && err.status === 400,
  );

  db.storageObjects.push({ user_id: "u-free", byte_size: 1024 });
  const summary = await getUserTierSummary(db, { id: "u-free", email: "free@example.com" });
  assert.equal(summary.tier, "selected");
  assert.equal(summary.storage.usedBytes, 1024);
  assert.equal(summary.storage.limitBytes, SELECTED_R2_STORAGE_LIMIT_BYTES);
});

test("per-user isolation across companion-store, memory-consolidation, elevenlabs-voice, and scene-store tiers", async () => {
  // 1. companion-store isolates state per userKey
  const companionRows = new Map();
  const companionDb = {
    from(table) {
      assert.equal(table, "companion_state");
      let filterVal = null;
      let payload = null;
      let action = "select";
      const q = {
        select() { return q; },
        eq(_k, v) { filterVal = v; return q; },
        upsert(v) { action = "upsert"; payload = v; return q; },
        async maybeSingle() { return { data: companionRows.get(filterVal) ?? null, error: null }; },
        then(resolve, reject) {
          if (action === "upsert") {
            companionRows.set(payload.user_key, { ...(companionRows.get(payload.user_key) ?? {}), ...payload });
          }
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const companion = load("../lib/companion.ts");
  const companionStore = load("../lib/companion-store.ts", {
    "@/lib/supabase-admin": { getSupabaseAdmin: () => companionDb },
    "@/lib/companion": companion,
  });
  const baseState = companion.defaultCompanionState();
  await companionStore.saveCompanionState("user-a", { ...baseState, affinity: 80 });
  const aLoaded = await companionStore.loadCompanionState("user-a");
  const bLoaded = await companionStore.loadCompanionState("user-b");
  assert.equal(aLoaded.affinity, 80);
  assert.equal(bLoaded.affinity, baseState.affinity);

  // 2. memory-consolidation isolates leases and memories by userKey
  const memDbRows = {
    memories: [{ id: 1, user_key: "user-a", memory: "User A likes tea", category: "preference", type: "preference", importance: 3, importance_01: 0.5, superseded_by: null }],
    memory_consolidation_runs: [{ id: "run-a", user_key: "user-a", status: "running", started_at: new Date().toISOString() }],
  };
  const memDb = {
    from(table) {
      const filters = [];
      let action = "select";
      let payload = null;
      let single = false;
      const q = {
        select() { return q; },
        insert(v) { action = "insert"; payload = v; return q; },
        update(v) { action = "update"; payload = v; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        is(k, v) { filters.push((r) => (r[k] ?? null) === v); return q; },
        order() { return q; },
        limit() { return q; },
        single() { single = true; return q; },
        maybeSingle() { single = true; return q; },
        then(resolve, reject) {
          if (action === "insert") {
            const row = { id: `${table}-${memDbRows[table].length + 1}`, ...payload };
            memDbRows[table].push(row);
            return Promise.resolve({ data: single ? row : [row], error: null }).then(resolve, reject);
          }
          const matched = memDbRows[table].filter((r) => filters.every((f) => f(r)));
          if (action === "update") for (const row of matched) Object.assign(row, payload);
          return Promise.resolve({ data: single ? matched[0] ?? null : matched, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const memoryV2 = load("../lib/memory-v2.ts");
  const consolidation = load("../lib/memory-consolidation.ts", { "@/lib/memory-v2": memoryV2 });
  // user-a has active running lease, user-b is NOT blocked by user-a's lease!
  const resA = await consolidation.runConsolidation(memDb, "user-a");
  assert.equal(resA.ok, false);
  assert.equal(resA.reason, "lease-held");
  const resB = await consolidation.runConsolidation(memDb, "user-b");
  assert.equal(resB.ok, true);

  // 3. elevenlabs-voice scopes preferences by userId
  const voiceRows = new Map([["user-a", { id: "user-a", voice_id: "voice-A", speech_language: "en" }]]);
  const voiceDb = {
    from(table) {
      assert.equal(table, "vivian_voice_preferences");
      let idVal = null;
      const q = {
        select() { return q; },
        eq(_k, v) { idVal = v; return q; },
        async maybeSingle() { return { data: voiceRows.get(idVal) ?? null, error: null }; },
      };
      return q;
    },
  };
  const voice = load("../lib/elevenlabs-voice.ts", { "./supabase-admin.ts": { getSupabaseAdmin: () => voiceDb } }, { process: { env: { ELEVENLABS_VOICE_ID: "env-default" } } });
  assert.equal(await voice.resolveElevenLabsVoiceId(undefined, "user-a", voiceDb), "voice-A");
  assert.equal(await voice.resolveElevenLabsVoiceId(undefined, "user-b", voiceDb), "env-default");

  // 4. scene-store blocks custom cloud scenes on free tier while allowing preset scenes
  const scenes = load("../lib/scenes.ts");
  const scenePrefRows = [];
  const sceneDb = {
    from(table) {
      let action = "select";
      let payload = null;
      const filters = [];
      const q = {
        select() { return q; },
        upsert(v) { action = "upsert"; payload = v; return q; },
        update(v) { action = "update"; payload = v; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        async maybeSingle() { return { data: scenePrefRows.find((r) => filters.every((f) => f(r))) ?? null, error: null }; },
        async single() {
          const matched = scenePrefRows.find((r) => filters.every((f) => f(r)));
          if (action === "update" && matched) Object.assign(matched, payload);
          return { data: matched ?? null, error: null };
        },
        then(resolve, reject) {
          if (action === "upsert" && table === "vivian_scene_preferences") {
            if (!scenePrefRows.some((r) => r.user_id === payload.user_id)) {
              scenePrefRows.push({ auto_scene: false, active_scene_id: null, preset: null, revision: "rev-1", ...payload });
            }
          }
          return Promise.resolve({ data: scenePrefRows, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const sceneStore = load("../lib/scene-store.ts", {
    "@/lib/scenes": scenes,
    "@/lib/cloud-store": {},
    "@/lib/r2": {},
    "@supabase/supabase-js": { createClient: () => sceneDb },
  });
  await assert.rejects(
    () => sceneStore.saveScene(sceneDb, "u-free", { label: "My Room", sourceType: "upload" }, undefined, { tier: "free" }),
    (err) => err.status === 403 && err.code === "TIER_REQUIRED",
  );
  const presetResult = await sceneStore.setScenePreferences(sceneDb, "u-free", { preset: "night" }, { tier: "free" });
  assert.equal(presetResult.preset, "night");
  await assert.rejects(
    () => sceneStore.setScenePreferences(sceneDb, "u-free", { activeSceneId: "00000000-0000-4000-8000-000000000001" }, { tier: "free" }),
    (err) => err.status === 403 && err.code === "TIER_REQUIRED",
  );
});
