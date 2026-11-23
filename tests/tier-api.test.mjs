import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { loadSceneModule as load } from "./scene-module-loader.mjs";

const require = createRequire(import.meta.url);
const nextServer = require("next/server");

function createMockSupabase() {
  const tables = {
    vivian_user_accounts: [],
    vivian_daily_chat_usage: [],
    vivian_tier_requests: [],
    vivian_storage_objects: [],
    vivian_storage_quotas: [
      { category: "live2d", used_bytes: 0, external_bytes: 0, limit_bytes: 8_000_000_000 },
      { category: "other", used_bytes: 0, external_bytes: 0, limit_bytes: 8_000_000_000 },
    ],
    vivian_model_expression_preferences: [],
    vivian_model_preferences: [],
    vivian_model_deletions: [],
    vivian_scenes: [],
    vivian_scene_preferences: [],
    vivian_scene_image_gc: [],
    vivian_voice_preferences: [],
    vivian_user_custom_instructions: [],
    memories: [],
    conversations: [],
    messages: [],
    companion_state: [],
    memory_consolidation_runs: [],
  };
  const legacyClaims = [];
  const bucketObjects = new Map();
  let nextSeqId = 1;

  const db = {
    tables,
    legacyClaims,
    bucketObjects,
    storage: {
      from() {
        return {
          async upload(key, bytes) {
            bucketObjects.set(key, bytes);
            return { error: null };
          },
          async remove(keys) {
            for (const key of keys) bucketObjects.delete(key);
            return { error: null };
          },
          async download(key) {
            const bytes = bucketObjects.get(key);
            return bytes
              ? { data: new Blob([bytes], { type: "image/webp" }), error: null }
              : { data: null, error: { message: "not found" } };
          },
          async info(key) {
            return { error: bucketObjects.has(key) ? null : { message: "missing" } };
          },
        };
      },
    },
    async rpc(name, args = {}) {
      if (name === "vivian_claim_legacy_data") {
        legacyClaims.push(args.p_user_id);
        const acc = tables.vivian_user_accounts.find((r) => r.user_id === args.p_user_id);
        if (!acc || acc.email.toLowerCase() !== "suphloeksangko@gmail.com") {
          return { data: { claimed: false, reason: "not_primary_legacy_owner" }, error: null };
        }
        if (acc.legacy_claimed_at) {
          return { data: { claimed: false, reason: "already_claimed", claimed_at: acc.legacy_claimed_at }, error: null };
        }
        acc.legacy_claimed_at = "2026-11-23T06:00:00.000Z";
        return { data: { claimed: true, claimed_at: acc.legacy_claimed_at }, error: null };
      }
      if (name === "vivian_consume_chat_quota") {
        let row = tables.vivian_daily_chat_usage.find(
          (r) => r.user_id === args.p_user_id && r.usage_date === args.p_usage_date,
        );
        if (!row) {
          row = { user_id: args.p_user_id, usage_date: args.p_usage_date, used_count: 0 };
          tables.vivian_daily_chat_usage.push(row);
        }
        if (row.used_count < args.p_limit) {
          row.used_count += 1;
          return {
            data: {
              allowed: true,
              used: row.used_count,
              limit: args.p_limit,
              remaining: Math.max(0, args.p_limit - row.used_count),
              usage_date: args.p_usage_date,
            },
            error: null,
          };
        }
        return {
          data: {
            allowed: false,
            used: row.used_count,
            limit: args.p_limit,
            remaining: 0,
            usage_date: args.p_usage_date,
          },
          error: null,
        };
      }
      if (name === "vivian_refund_chat_quota") {
        const row = tables.vivian_daily_chat_usage.find(
          (r) => r.user_id === args.p_user_id && r.usage_date === args.p_usage_date,
        );
        if (row && row.used_count > 0) {
          row.used_count -= 1;
          return { data: { refunded: true, used: row.used_count, usage_date: args.p_usage_date }, error: null };
        }
        return { data: { refunded: false, used: row?.used_count ?? 0, usage_date: args.p_usage_date }, error: null };
      }
      if (name === "vivian_review_tier_request") {
        const req = tables.vivian_tier_requests.find((r) => r.id === args.p_request_id);
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
          let acc = tables.vivian_user_accounts.find((a) => a.user_id === req.user_id);
          if (!acc) {
            acc = {
              user_id: req.user_id,
              email: req.email,
              tier: "selected",
              legacy_claimed_at: null,
              created_at: "2026-11-23T00:00:00.000Z",
              updated_at: "2026-11-23T07:00:00.000Z",
            };
            tables.vivian_user_accounts.push(acc);
          } else if (acc.tier !== "sorachan") {
            acc.tier = "selected";
            acc.updated_at = "2026-11-23T07:00:00.000Z";
          }
        }
        return { data: { already_reviewed: false, request: { ...req } }, error: null };
      }
      if (name === "vivian_storage_observe") {
        const live2dQuota = tables.vivian_storage_quotas.find((q) => q.category === "live2d");
        const otherQuota = tables.vivian_storage_quotas.find((q) => q.category === "other");
        live2dQuota.external_bytes = args.live2d_bytes ?? 0;
        otherQuota.external_bytes = args.other_bytes ?? 0;
        return { data: null, error: null };
      }
      if (name === "vivian_supabase_storage_bytes") {
        return { data: 123456, error: null };
      }
      if (name === "vivian_save_conversation") {
        let conv = tables.conversations.find((c) => c.id === args.p_id);
        if (!conv) {
          if (!args.p_create) return { error: { code: "P0002" } };
          conv = { id: args.p_id, user_key: args.p_user_key, title: args.p_title, updated_at: new Date().toISOString() };
          tables.conversations.push(conv);
        } else if (conv.user_key !== args.p_user_key) {
          return { error: { code: "42501" } };
        }
        for (const msg of args.p_messages) {
          tables.messages.push({
            id: nextSeqId++,
            conversation_id: args.p_id,
            client_message_id: msg.id,
            role: msg.role,
            content: msg.content,
            created_at: msg.created_at,
          });
        }
        return { error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
    from(table) {
      if (!(table in tables)) throw new Error(`Unknown table ${table}`);
      const list = tables[table];
      let action = "select";
      let payload = null;
      let options = {};
      let singleMode = null;
      let countMode = null;
      let headMode = false;
      let rangeSlice = null;
      let limitVal = null;
      let orderSpec = null;
      const filters = [];

      const q = {
        select(_cols, opts = {}) {
          countMode = opts.count ?? null;
          headMode = Boolean(opts.head);
          return q;
        },
        insert(val) { action = "insert"; payload = val; return q; },
        upsert(val, opts = {}) { action = "upsert"; payload = val; options = opts; return q; },
        update(val) { action = "update"; payload = val; return q; },
        delete() { action = "delete"; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        neq(k, v) { filters.push((r) => r[k] !== v); return q; },
        is(k, v) { filters.push((r) => (r[k] ?? null) === v); return q; },
        in(k, vals) { filters.push((r) => vals.includes(r[k])); return q; },
        lt(k, v) { filters.push((r) => String(r[k]) < String(v)); return q; },
        gt(k, v) { filters.push((r) => Number(r[k]) > Number(v)); return q; },
        order(col, opts = {}) { orderSpec = { col, ascending: opts.ascending !== false }; return q; },
        range(from, to) { rangeSlice = [from, to]; return q; },
        limit(n) { limitVal = n; return q; },
        maybeSingle() { singleMode = "maybe"; return q; },
        single() { singleMode = "single"; return q; },
        then(resolve, reject) {
          let result;
          const nowIso = "2026-11-23T06:00:00.000Z";
          if (action === "insert") {
            const rows = Array.isArray(payload) ? payload : [payload];
            const inserted = [];
            for (const raw of rows) {
              if (table === "vivian_tier_requests" && raw.status === "pending") {
                if (list.some((r) => r.user_id === raw.user_id && r.status === "pending")) {
                  result = { data: null, error: { code: "23505", message: "duplicate pending" } };
                  return Promise.resolve(result).then(resolve, reject);
                }
              }
              const row = {
                id: table === "memories" ? nextSeqId++ : raw.id ?? randomUUID(),
                created_at: nowIso,
                updated_at: nowIso,
                ...(table === "vivian_tier_requests"
                  ? { display_name: "", reason: "", reviewed_by: null, review_note: "", reviewed_at: null }
                  : {}),
                ...(table === "vivian_storage_objects" ? { state: "pending", upload_id: null } : {}),
                ...(table === "vivian_scene_preferences"
                  ? { auto_scene: false, active_scene_id: null, preset: null, revision: randomUUID() }
                  : {}),
                ...raw,
              };
              list.push(row);
              inserted.push(row);
              if (table === "vivian_storage_objects") {
                const quota = tables.vivian_storage_quotas.find((item) => item.category === row.category);
                if (quota) quota.used_bytes += Number(row.byte_size);
              }
            }
            result = {
              data: singleMode ? inserted[0] ?? null : inserted,
              error: null,
            };
          } else if (action === "upsert") {
            const conflictKey = options.onConflict ?? "id";
            const conflictCols = conflictKey.split(",").map((c) => c.trim());
            const rows = Array.isArray(payload) ? payload : [payload];
            const out = [];
            for (const raw of rows) {
              const existing = list.find((r) => conflictCols.every((c) => r[c] === raw[c]));
              if (existing) {
                if (!options.ignoreDuplicates) Object.assign(existing, raw);
                out.push(existing);
              } else {
                const row = {
                  id: table === "memories" ? nextSeqId++ : raw.id ?? randomUUID(),
                  created_at: nowIso,
                  updated_at: nowIso,
                  ...(table === "vivian_user_accounts" ? { legacy_claimed_at: null, tier: "free" } : {}),
                  ...(table === "vivian_scene_preferences"
                    ? { auto_scene: false, active_scene_id: null, preset: null, revision: randomUUID() }
                    : {}),
                  ...raw,
                };
                list.push(row);
                out.push(row);
              }
            }
            result = { data: singleMode ? out[0] ?? null : out, error: null };
          } else {
            let matched = list.filter((r) => filters.every((f) => f(r)));
            if (orderSpec) {
              matched = [...matched].sort((a, b) => {
                const av = a[orderSpec.col];
                const bv = b[orderSpec.col];
                if (av === bv) return 0;
                const cmp = av < bv ? -1 : 1;
                return orderSpec.ascending ? cmp : -cmp;
              });
            }
            if (action === "update") {
              for (const row of matched) Object.assign(row, payload);
            } else if (action === "delete") {
              for (const row of matched) {
                const idx = list.indexOf(row);
                if (idx >= 0) list.splice(idx, 1);
                if (table === "vivian_storage_objects") {
                  const quota = tables.vivian_storage_quotas.find((item) => item.category === row.category);
                  if (quota) quota.used_bytes -= Number(row.byte_size);
                }
              }
            }
            const totalCount = matched.length;
            if (rangeSlice) matched = matched.slice(rangeSlice[0], rangeSlice[1] + 1);
            if (typeof limitVal === "number") matched = matched.slice(0, limitVal);
            if (singleMode === "single" && !matched.length) {
              result = { data: null, error: { code: "PGRST116", message: "No rows" } };
            } else {
              result = {
                data: headMode ? null : singleMode ? matched[0] ?? null : matched,
                count: countMode ? totalCount : null,
                error: null,
              };
            }
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return db;
}

function createHarness(options = {}) {
  const db = createMockSupabase();
  const afterCallbacks = [];
  const rateLimitChecks = [];
  const sentEmails = [];
  let activeUser = options.initialUser ?? null;

  const env = {
    TIER_ACTION_SECRET: "test-tier-secret-key",
    VIVIAN_INTERNAL_TOKEN: "test-internal-token",
    NEXT_PUBLIC_APP_URL: "https://vivian.example",
    GROQ_API_KEY: "fixture-groq",
    GEMINI_API_KEY: "",
    ELEVENLABS_API_KEY: "fixture-elevenlabs",
    ELEVENLABS_VOICE_ID: "env-default-voice",
    SUPABASE_URL: "https://db.example",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role",
    ...options.env,
  };

  const globals = {
    crypto: webcrypto,
    performance,
    URLSearchParams,
    FormData,
    Headers,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    process: { env },
    fetch: options.fetch ?? (async (url) => {
      if (String(url).includes("resend.com")) {
        sentEmails.push(url);
        return Response.json({ id: "email-1" });
      }
      return Response.json({ choices: [{ message: { content: "บะ...ไม่ได้อยากคุยด้วยสักหน่อยค่ะ" } }] });
    }),
  };

  const policy = load("../lib/auth/policy.ts", {}, globals);
  const userTiers = load("../lib/user-tiers.ts", { "./auth/policy.ts": policy }, globals);
  const tierRequests = load(
    "../lib/tier-requests.ts",
    {
      "./auth/policy.ts": policy,
      "./user-tiers.ts": userTiers,
      "@supabase/supabase-js": {},
    },
    globals,
  );

  const authServer = {
    requireAuthorizedUser: async () => {
      if (!activeUser) {
        return {
          user: null,
          denied: Response.json({ error: "Please sign in", status: 401, code: "AUTH_REQUIRED" }, { status: 401 }),
        };
      }
      return { user: activeUser, denied: null };
    },
  };
  const rateLimitMod = {
    rateLimit: (_req, key) => {
      rateLimitChecks.push(key);
      return { allowed: true, remaining: 50 };
    },
    rateLimitedResponse: () => Response.json({ error: "Rate limited" }, { status: 429 }),
  };
  const supabaseAdminMod = { getSupabaseAdmin: () => db };
  const nextServerMod = {
    ...nextServer,
    after: (cb) => afterCallbacks.push(cb),
  };

  const cloudStorage = load("../lib/cloud-storage.ts", {}, globals);
  const scenes = load("../lib/scenes.ts", {}, globals);
  const r2Mock = {
    r2Configuration() {},
    r2Inventory: async () => new Map(),
    startModelUpload: async () => "upload-1",
    signModelParts: async () => [{ part: 1, size: 100, url: "https://r2.example/part1" }],
    completeModelUpload: async () => {},
    deleteR2Object: async () => {},
    signModelDownload: async () => "https://r2.example/download",
    putR2Image: async () => {},
    getR2Image: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
    modelObjectSize: async () => 100,
  };
  const cloudStore = load(
    "../lib/cloud-store.ts",
    {
      "@/lib/cloud-storage": cloudStorage,
      "@/lib/scenes": scenes,
      "@/lib/r2": r2Mock,
      "@/lib/user-tiers": userTiers,
    },
    globals,
  );
  const sceneStore = load(
    "../lib/scene-store.ts",
    {
      "@/lib/scenes": scenes,
      "@/lib/cloud-store": cloudStore,
      "@/lib/r2": r2Mock,
      "@/lib/user-tiers": userTiers,
      "@supabase/supabase-js": { createClient: () => db },
    },
    globals,
  );
  const cloudApiMod = load(
    "../lib/cloud-api.ts",
    {
      "@/lib/auth/server": authServer,
      "@/lib/rate-limit": rateLimitMod,
      "@/lib/scene-store": sceneStore,
      "@/lib/cloud-storage": cloudStorage,
      "@/lib/cloud-store": cloudStore,
      "@/lib/model-library-broadcast": { publishModelLibraryChange: async () => {} },
      "@/lib/user-tiers": userTiers,
      "next/server": nextServerMod,
    },
    globals,
  );
  const sceneApiMod = load(
    "../lib/scene-api.ts",
    {
      "@/lib/auth/server": authServer,
      "@/lib/rate-limit": rateLimitMod,
      "@/lib/scene-store": sceneStore,
      "@/lib/scenes": scenes,
      "@/lib/cloud-storage": cloudStorage,
      "@/lib/user-tiers": userTiers,
      "next/server": nextServerMod,
    },
    globals,
  );

  const companion = load("../lib/companion.ts", {}, globals);
  const companionStore = load(
    "../lib/companion-store.ts",
    {
      "@/lib/supabase-admin": supabaseAdminMod,
      "@/lib/companion": companion,
    },
    globals,
  );
  const memoryV2 = load("../lib/memory-v2.ts", {}, globals);
  const memoryConsolidation = load("../lib/memory-consolidation.ts", { "@/lib/memory-v2": memoryV2 }, globals);
  const resetCompanion = load("../lib/reset-companion.ts", {}, globals);
  const chatHistory = load("../lib/chat-history.ts", {}, globals);
  const chatHistoryStore = load("../lib/chat-history-store.ts", { "@/lib/chat-history": chatHistory }, globals);
  const elevenLabsVoice = load("../lib/elevenlabs-voice.ts", { "./supabase-admin.ts": supabaseAdminMod }, globals);
  const storageStatusStore = load(
    "../lib/storage-status-store.ts",
    {
      "@/lib/cloud-store": cloudStore,
      "@/lib/r2": r2Mock,
      "@/lib/cloud-storage": cloudStorage,
    },
    globals,
  );

  const routes = {
    account: load(
      "../app/api/account/route.ts",
      {
        "@/lib/auth/policy": policy,
        "@/lib/auth/server": authServer,
        "@/lib/rate-limit": rateLimitMod,
        "@/lib/supabase-admin": supabaseAdminMod,
        "@/lib/tier-requests": tierRequests,
        "@/lib/user-tiers": userTiers,
        "next/server": nextServerMod,
      },
      globals,
    ),
    tierRequests: load(
      "../app/api/tier-requests/route.ts",
      {
        "@/lib/auth/policy": policy,
        "@/lib/auth/server": authServer,
        "@/lib/rate-limit": rateLimitMod,
        "@/lib/supabase-admin": supabaseAdminMod,
        "@/lib/tier-requests": tierRequests,
        "@/lib/user-tiers": userTiers,
        "next/server": nextServerMod,
      },
      globals,
    ),
    review: load(
      "../app/api/tier-requests/review/route.ts",
      {
        "@/lib/auth/policy": policy,
        "@/lib/rate-limit": rateLimitMod,
        "@/lib/supabase-admin": supabaseAdminMod,
        "@/lib/tier-requests": tierRequests,
        "next/server": nextServerMod,
      },
      globals,
    ),
    admin: load(
      "../app/api/admin/tier-requests/route.ts",
      {
        "@/lib/auth/policy": policy,
        "@/lib/auth/server": authServer,
        "@/lib/rate-limit": rateLimitMod,
        "@/lib/supabase-admin": supabaseAdminMod,
        "@/lib/tier-requests": tierRequests,
        "@/lib/user-tiers": userTiers,
        "next/server": nextServerMod,
      },
      globals,
    ),
    models: load(
      "../app/api/models/route.ts",
      {
        "@/lib/cloud-api": cloudApiMod,
        "@/lib/cloud-store": cloudStore,
        "@/lib/cloud-storage": cloudStorage,
      },
      globals,
    ),
    modelItem: load(
      "../app/api/models/[id]/route.ts",
      {
        "@/lib/cloud-api": cloudApiMod,
        "@/lib/cloud-store": cloudStore,
        "@/lib/cloud-storage": cloudStorage,
      },
      globals,
    ),
    modelPref: load(
      "../app/api/models/preference/route.ts",
      {
        "@/lib/cloud-api": cloudApiMod,
        "@/lib/cloud-store": cloudStore,
      },
      globals,
    ),
    modelParts: load(
      "../app/api/models/[id]/parts/route.ts",
      {
        "@/lib/cloud-api": cloudApiMod,
        "@/lib/cloud-store": cloudStore,
      },
      globals,
    ),
    modelExpressions: load(
      "../app/api/models/[id]/expressions/route.ts",
      {
        "@/lib/cloud-api": cloudApiMod,
        "@/lib/cloud-store": cloudStore,
        "@/lib/cloud-storage": cloudStorage,
      },
      globals,
    ),
    scenes: load(
      "../app/api/scenes/route.ts",
      {
        "@/lib/scene-api": sceneApiMod,
        "@/lib/scene-store": sceneStore,
        "@/lib/scene-images": {
          readSceneInput: async () => ({ label: "Bedroom", sourceType: "upload", bytes: Buffer.from([1, 2, 3]), mime: "image/png" }),
          normalizeSceneImage: async (bytes) => ({ image: bytes, thumbnail: Buffer.from([4, 5]), mime: "image/webp" }),
        },
      },
      globals,
    ),
    scenePrefs: load(
      "../app/api/scenes/preferences/route.ts",
      {
        "@/lib/scene-api": sceneApiMod,
        "@/lib/scene-store": sceneStore,
        "@/lib/scene-images": { readBoundedSceneBody: async (req) => Buffer.from(await req.text()) },
      },
      globals,
    ),
    sceneImage: load(
      "../app/api/scenes/[id]/image/route.ts",
      {
        "@/lib/rate-limit": rateLimitMod,
        "@/lib/scene-api": sceneApiMod,
        "@/lib/scene-store": sceneStore,
        "@/lib/user-tiers": userTiers,
      },
      globals,
    ),
    storageStatus: load(
      "../app/api/storage/status/route.ts",
      {
        "@/lib/cloud-api": cloudApiMod,
        "@/lib/cloud-storage": cloudStorage,
        "@/lib/cloud-store": cloudStore,
        "@/lib/storage-status-store": storageStatusStore,
      },
      globals,
    ),
    memory: load(
      "../app/api/memory/route.ts",
      {
        "@/lib/auth/server": authServer,
        "@/lib/supabase-admin": supabaseAdminMod,
        "@/lib/companion": companion,
        "@/lib/reset-companion": resetCompanion,
        "next/server": nextServerMod,
      },
      globals,
    ),
    consolidate: load(
      "../app/api/memory/consolidate/route.ts",
      {
        "@/lib/auth/server": authServer,
        "@/lib/supabase-admin": supabaseAdminMod,
        "@/lib/companion-store": companionStore,
        "@/lib/memory-v2": memoryV2,
        "@/lib/memory-consolidation": memoryConsolidation,
        "next/server": nextServerMod,
      },
      globals,
    ),
    chat: load(
      "../app/api/chat/route.ts",
      {
        "@/lib/chat-stream": load("../lib/chat-stream.ts", {}, globals),
        "@/lib/chat-history": chatHistory,
        "@/lib/chat-history-store": chatHistoryStore,
        "@/lib/auth/server": authServer,
        "@/lib/auth/policy": policy,
        "@/lib/user-tiers": userTiers,
        "@/lib/companion": companion,
        "@/lib/vivian-persona": load("../lib/vivian-persona.ts", { "@/lib/custom-instructions": load("../lib/custom-instructions.ts", {}, globals) }, globals),
        "@/lib/vivian-story": load("../lib/vivian-story.ts", {}, globals),
        "@/lib/companion-store": companionStore,
        "@/lib/elevenlabs-voice": elevenLabsVoice,
        "@/lib/tts-stream-session": { StreamingTtsSession: class { pushDelta() {} async finish() {} abort() {} } },
        "@/lib/supabase-admin": supabaseAdminMod,
        "@/lib/tools": load("../lib/tools.ts", {}, globals),
        "@/lib/rate-limit": rateLimitMod,
        "@/lib/jev": load("../lib/jev.ts", { "@/lib/scenes": scenes }, globals),
        "@/lib/scene-store": sceneStore,
        "@/lib/scenes": scenes,
        "@/lib/chat-decision": load("../lib/chat-decision.ts", { "@/lib/tools": load("../lib/tools.ts", {}, globals), "@/lib/jev": load("../lib/jev.ts", { "@/lib/scenes": scenes }, globals), "@/lib/scenes": scenes }, globals),
        "@/lib/speech": load("../lib/speech.ts", {}, globals),
        "@/lib/memory-v2": memoryV2,
        "@/lib/memory-consolidation": memoryConsolidation,
        "@/lib/memory-recall": load("../lib/memory-recall.ts", {}, globals),
        "@/lib/memory-embeddings": load("../lib/memory-embeddings.ts", {}, globals),
        "next/server": nextServerMod,
      },
      globals,
    ),
  };

  return {
    db,
    routes,
    tierRequests,
    userTiers,
    afterCallbacks,
    sentEmails,
    setUser(user) { activeUser = user; },
    async flushAfter() {
      while (afterCallbacks.length) {
        const fn = afterCallbacks.shift();
        await fn();
      }
    },
  };
}

test("GET /api/account enforces auth, returns tier summary/quota/request, and claims legacy ONLY for primary email", async () => {
  const h = createHarness();
  const signedOut = await h.routes.account.GET(new Request("https://vivian.example/api/account"));
  assert.equal(signedOut.status, 401);

  h.setUser({ id: "u-free", email: "free@example.com" });
  const freeRes = await h.routes.account.GET(new Request("https://vivian.example/api/account"));
  assert.equal(freeRes.status, 200);
  const freeBody = await freeRes.json();
  assert.deepEqual(freeBody.user, { id: "u-free", email: "free@example.com" });
  assert.equal(freeBody.tier, "free");
  assert.equal(freeBody.capabilities.dailyChatLimit, 5);
  assert.equal(freeBody.capabilities.canUseCloudModels, false);
  assert.equal(freeBody.capabilities.isAdmin, false);
  assert.equal(freeBody.chatQuota.limit, 5);
  assert.equal(freeBody.chatQuota.remaining, 5);
  assert.deepEqual(freeBody.storage, { usedBytes: 0, limitBytes: 0 });
  assert.equal(freeBody.selectedRequest, null);
  assert.equal(freeBody.requestEmail, "viviannextlabs@gmail.com");
  assert.ok(freeBody.mailtoUrl.startsWith("mailto:viviannextlabs@gmail.com?"));
  assert.equal("approveUrl" in freeBody, false);
  assert.equal("rejectUrl" in freeBody, false);

  // duckchan690 is sorachan admin but NEVER claims legacy 'default'/'global' rows
  h.setUser({ id: "u-sora-2", email: "duckchan690@gmail.com" });
  const sora2Body = await (await h.routes.account.GET(new Request("https://vivian.example/api/account"))).json();
  assert.equal(sora2Body.tier, "sorachan");
  assert.equal(sora2Body.capabilities.isAdmin, true);
  assert.equal(sora2Body.chatQuota.limit, null);
  assert.equal(h.db.legacyClaims.includes("u-sora-2"), false);

  // suphloeksangko claims legacy rows once
  h.setUser({ id: "u-sora-1", email: "SUPHLOEKSANGKO@GMAIL.COM" });
  const sora1Body = await (await h.routes.account.GET(new Request("https://vivian.example/api/account"))).json();
  assert.equal(sora1Body.tier, "sorachan");
  assert.deepEqual(h.db.legacyClaims, ["u-sora-1"]);
});

test("tier-requests & review flow: POST strips secrets, GET review does not mutate, POST review promotes user", async () => {
  const h = createHarness({
    env: {
      RESEND_API_KEY: "re_test",
      RESEND_FROM: "Vivian <noreply@vivian.example>",
    },
  });

  h.setUser({ id: "u-free", email: "requester@example.com" });

  // Validation rejects bad types / oversize
  const badRes = await h.routes.tierRequests.POST(
    new Request("https://vivian.example/api/tier-requests", {
      method: "POST",
      body: JSON.stringify({ displayName: 123 }),
    }),
  );
  assert.equal(badRes.status, 400);

  const createRes = await h.routes.tierRequests.POST(
    new Request("https://vivian.example/api/tier-requests", {
      method: "POST",
      body: JSON.stringify({ displayName: "<script>Alice</script>", reason: "Want <b>cloud</b> models" }),
    }),
  );
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.alreadyPending, false);
  assert.equal(created.emailSent, true);
  assert.equal(created.request.status, "pending");
  assert.equal(created.requestEmail, "viviannextlabs@gmail.com");
  assert.equal("approveUrl" in created, false);
  assert.equal("rejectUrl" in created, false);
  assert.equal("approveUrl" in created.request, false);
  assert.equal("rejectUrl" in created.request, false);

  // Duplicate pending request returns 200 alreadyPending without exposing URLs
  const dupRes = await h.routes.tierRequests.POST(
    new Request("https://vivian.example/api/tier-requests", { method: "POST", body: "{}" }),
  );
  assert.equal(dupRes.status, 200);
  const dup = await dupRes.json();
  assert.equal(dup.alreadyPending, true);
  assert.equal(dup.request.id, created.request.id);

  // GET /api/tier-requests returns only caller's requests
  const listRes = await h.routes.tierRequests.GET(new Request("https://vivian.example/api/tier-requests"));
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.equal(list.requests.length, 1);

  // GET /api/tier-requests/review?token=... renders confirmation form with escaped HTML and NEVER mutates DB
  const approveToken = h.tierRequests.createTierActionToken(created.request.id, "approve", { secret: "test-tier-secret-key" });
  const getReview = await h.routes.review.GET(
    new Request(`https://vivian.example/api/tier-requests/review?token=${encodeURIComponent(approveToken)}`),
  );
  assert.equal(getReview.status, 200);
  const html = await getReview.text();
  assert.match(html, /<form method="POST" action="\/api\/tier-requests\/review">/);
  assert.match(html, /&lt;script&gt;Alice&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>Alice<\/script>/);
  assert.equal(h.db.tables.vivian_tier_requests[0].status, "pending");

  // Cross-site POST to review is rejected
  const crossSite = await h.routes.review.POST(
    new Request("https://vivian.example/api/tier-requests/review", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: `token=${encodeURIComponent(approveToken)}`,
    }),
  );
  assert.equal(crossSite.status, 403);

  // Form POST approves and promotes user to selected
  const postReview = await h.routes.review.POST(
    new Request("https://vivian.example/api/tier-requests/review", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(approveToken)}`,
    }),
  );
  assert.equal(postReview.status, 200);
  assert.match(await postReview.text(), /Selected tier approved/);
  assert.equal(h.db.tables.vivian_tier_requests[0].status, "approved");

  // Account now reflects selected tier
  const afterAccount = await (await h.routes.account.GET(new Request("https://vivian.example/api/account"))).json();
  assert.equal(afterAccount.tier, "selected");
  assert.equal(afterAccount.capabilities.dailyChatLimit, 20);
  assert.equal(afterAccount.capabilities.canUseCloudModels, true);

  // Conflicting reject token via Accept: application/json returns 409 ALREADY_REVIEWED
  const rejectToken = h.tierRequests.createTierActionToken(created.request.id, "reject", { secret: "test-tier-secret-key" });
  const conflictRes = await h.routes.review.POST(
    new Request("https://vivian.example/api/tier-requests/review", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ token: rejectToken }),
    }),
  );
  assert.equal(conflictRes.status, 409);
  assert.equal((await conflictRes.json()).code, "ALREADY_REVIEWED");
});

test("admin tier-requests endpoints enforce Sorachan-only access, list non-Sorachan accounts, and support approve/reject/set_tier", async () => {
  const h = createHarness();

  // Seed non-Sorachan users and one pending request
  h.setUser({ id: "u-free-1", email: "user1@example.com" });
  const reqRes = await (
    await h.routes.tierRequests.POST(
      new Request("https://vivian.example/api/tier-requests", {
        method: "POST",
        body: JSON.stringify({ displayName: "User One", reason: "Testing" }),
      }),
    )
  ).json();

  // Non-admin receives 403 ADMIN_REQUIRED
  const deniedGet = await h.routes.admin.GET(new Request("https://vivian.example/api/admin/tier-requests"));
  assert.equal(deniedGet.status, 403);
  assert.equal((await deniedGet.json()).code, "ADMIN_REQUIRED");

  const deniedPost = await h.routes.admin.POST(
    new Request("https://vivian.example/api/admin/tier-requests", {
      method: "POST",
      body: JSON.stringify({ action: "approve", requestId: reqRes.request.id }),
    }),
  );
  assert.equal(deniedPost.status, 403);
  assert.equal((await deniedPost.json()).code, "ADMIN_REQUIRED");

  // Sorachan admin lists requests and non-Sorachan accounts only
  h.setUser({ id: "u-sora-admin", email: "duckchan690@gmail.com" });
  await h.routes.account.GET(new Request("https://vivian.example/api/account"));

  const adminGet = await h.routes.admin.GET(new Request("https://vivian.example/api/admin/tier-requests"));
  assert.equal(adminGet.status, 200);
  const adminData = await adminGet.json();
  assert.equal(adminData.requests.length, 1);
  assert.equal(adminData.accounts.length, 1);
  assert.equal(adminData.accounts[0].email, "user1@example.com");

  // Approve request via admin API
  const approveRes = await h.routes.admin.POST(
    new Request("https://vivian.example/api/admin/tier-requests", {
      method: "POST",
      body: JSON.stringify({ action: "approve", requestId: reqRes.request.id, reviewNote: "Welcome" }),
    }),
  );
  assert.equal(approveRes.status, 200);
  const approved = await approveRes.json();
  assert.equal(approved.request.status, "approved");

  // Downgrade back to free by email via set_tier
  const downgradeRes = await h.routes.admin.POST(
    new Request("https://vivian.example/api/admin/tier-requests", {
      method: "POST",
      body: JSON.stringify({ action: "set_tier", emailOrUserId: "USER1@EXAMPLE.COM", tier: "free" }),
    }),
  );
  assert.equal(downgradeRes.status, 200);
  assert.equal((await downgradeRes.json()).account.tier, "free");

  // Cannot downgrade a Sorachan account
  const soraGuard = await h.routes.admin.POST(
    new Request("https://vivian.example/api/admin/tier-requests", {
      method: "POST",
      body: JSON.stringify({ action: "set_tier", emailOrUserId: "suphloeksangko@gmail.com", tier: "free" }),
    }),
  );
  assert.equal(soraGuard.status, 400);
  assert.equal((await soraGuard.json()).code, "ADMIN_REQUIRED");
});

test("/api/chat enforces daily quota regardless of client body.mode, includes chatQuota in JSON & NDJSON, refunds on error, and isolates user data", async () => {
  let groqMode = "ok";
  let groqCalls = 0;
  const h = createHarness({
    fetch: async (url) => {
      if (String(url).includes("groq.com")) {
        groqCalls += 1;
        if (groqMode === "fail") return new Response("upstream down", { status: 503 });
        if (groqMode === "empty") return Response.json({ choices: [{ message: { content: "   " } }] });
        return Response.json({ choices: [{ message: { content: "[playful] หือ ว่าไงคะ" } }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  h.setUser({ id: "u-chat-free", email: "chatfree@example.com" });

  // Attempt to bypass quota by sending mode: "greeting" — MUST still consume!
  for (let i = 1; i <= 4; i++) {
    const res = await h.routes.chat.POST(
      new Request("https://vivian.example/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "greeting", messages: [{ role: "user", content: `turn ${i}` }] }),
      }),
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.chatQuota.used, i);
    assert.equal(json.chatQuota.remaining, 5 - i);
    await h.flushAfter();
  }

  // 5th turn via NDJSON stream includes chatQuota in reply event
  const ndjsonRes = await h.routes.chat.POST(
    new Request("https://vivian.example/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ messages: [{ role: "user", content: "turn 5" }] }),
    }),
  );
  assert.equal(ndjsonRes.status, 200);
  const ndjsonLines = (await ndjsonRes.text()).trim().split("\n").map((line) => JSON.parse(line));
  const replyEvent = ndjsonLines.find((e) => e.event === "reply");
  assert.equal(replyEvent.status, 200);
  assert.equal(replyEvent.data.chatQuota.used, 5);
  assert.equal(replyEvent.data.chatQuota.remaining, 0);
  await h.flushAfter();

  // Verify user data written under u-chat-free, NEVER 'default'
  assert.ok(h.db.tables.conversations.every((c) => c.user_key === "u-chat-free"));
  assert.ok(h.db.tables.companion_state.every((c) => c.user_key === "u-chat-free"));

  // 6th turn is rejected with 403 QUOTA_EXCEEDED BEFORE calling LLM
  const callsBeforeBlocked = groqCalls;
  const blockedRes = await h.routes.chat.POST(
    new Request("https://vivian.example/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ mode: "greeting", messages: [{ role: "user", content: "turn 6" }] }),
    }),
  );
  assert.equal(blockedRes.status, 403);
  const blockedBody = await blockedRes.json();
  assert.equal(blockedBody.code, "QUOTA_EXCEEDED");
  assert.equal(blockedBody.requiredTier, "selected");
  assert.equal(blockedBody.quota.remaining, 0);
  assert.equal(groqCalls, callsBeforeBlocked);

  // Refund check: use another user, fail LLM (504) then empty reply (502), verify slots are refunded
  h.setUser({ id: "u-refund", email: "refund@example.com" });
  groqMode = "fail";
  const failRes = await h.routes.chat.POST(
    new Request("https://vivian.example/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    }),
  );
  assert.equal(failRes.status, 504);

  groqMode = "empty";
  const emptyRes = await h.routes.chat.POST(
    new Request("https://vivian.example/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    }),
  );
  assert.equal(emptyRes.status, 502);

  // Account quota must still have 0 used after both failed turns
  const accAfterRefund = await (await h.routes.account.GET(new Request("https://vivian.example/api/account"))).json();
  assert.equal(accAfterRefund.chatQuota.used, 0);
  assert.equal(accAfterRefund.chatQuota.remaining, 5);
});

test("memory and memory/consolidate strictly isolate rows per user.id", async () => {
  const h = createHarness();
  h.setUser({ id: "u-mem-a", email: "mema@example.com" });
  await h.routes.memory.POST(
    new Request("https://vivian.example/api/memory", {
      method: "POST",
      body: JSON.stringify({ memory: "User A likes matcha", category: "preference", importance: 4 }),
    }),
  );
  await h.routes.consolidate.PATCH(
    new Request("https://vivian.example/api/memory/consolidate", {
      method: "PATCH",
      body: JSON.stringify({ summary: "User A summary" }),
    }),
  );

  h.setUser({ id: "u-mem-b", email: "memb@example.com" });
  const memB = await (await h.routes.memory.GET(new Request("https://vivian.example/api/memory"))).json();
  assert.equal(memB.memories.length, 0);
  const sumB = await (await h.routes.consolidate.GET(new Request("https://vivian.example/api/memory/consolidate"))).json();
  assert.equal(sumB.summary, "");

  h.setUser({ id: "u-mem-a", email: "mema@example.com" });
  const memA = await (await h.routes.memory.GET(new Request("https://vivian.example/api/memory"))).json();
  assert.equal(memA.memories.length, 1);
  assert.equal(memA.memories[0].memory, "User A likes matcha");
  const sumA = await (await h.routes.consolidate.GET(new Request("https://vivian.example/api/memory/consolidate"))).json();
  assert.equal(sumA.summary, "User A summary");

  await h.routes.memory.DELETE(
    new Request("https://vivian.example/api/memory", {
      method: "DELETE",
      body: JSON.stringify({ scope: "all" }),
    }),
  );
  assert.equal(h.db.tables.memories.filter((m) => m.user_key === "u-mem-a").length, 0);
});

test("models, scenes, and storage/status enforce free, selected (512 MiB private), and sorachan (shared + full) tiers", async () => {
  const h = createHarness();

  // 1. Sorachan uploads a shared model
  h.setUser({ id: "u-sora", email: "suphloeksangko@gmail.com" });
  const soraBegin = await h.routes.models.POST(
    new Request("https://vivian.example/api/models", {
      method: "POST",
      body: JSON.stringify({ byteSize: 1000, manifests: [{ path: "witch.model3.json", name: "Witch" }] }),
    }),
  );
  assert.equal(soraBegin.status, 201);
  const soraModel = await soraBegin.json();
  assert.equal(soraModel.scope, "shared");
  await h.routes.modelItem.POST(
    new Request(`https://vivian.example/api/models/${soraModel.id}`, { method: "POST" }),
    { params: Promise.resolve({ id: soraModel.id }) },
  );

  // 2. Free user: GET /api/models & /api/storage/status & /api/scenes return free shapes; mutations return 403 TIER_REQUIRED
  h.setUser({ id: "u-free", email: "free@example.com" });
  const freeModels = await (await h.routes.models.GET(new Request("https://vivian.example/api/models"))).json();
  assert.deepEqual(freeModels, {
    userId: "u-free",
    tier: "free",
    cloudAllowed: false,
    sharedAllowed: false,
    models: [],
    usage: null,
    preference: null,
  });

  const freeStorage = await (await h.routes.storageStatus.GET(new Request("https://vivian.example/api/storage/status"))).json();
  assert.equal(freeStorage.cloudAllowed, false);
  assert.equal(freeStorage.tier, "free");
  assert.equal(freeStorage.r2, null);
  assert.equal(freeStorage.supabase, null);

  const freeModelUpload = await h.routes.models.POST(
    new Request("https://vivian.example/api/models", {
      method: "POST",
      body: JSON.stringify({ byteSize: 100, manifests: [{ path: "m.model3.json", name: "M" }] }),
    }),
  );
  assert.equal(freeModelUpload.status, 403);
  assert.equal((await freeModelUpload.json()).code, "TIER_REQUIRED");

  const freeSceneGet = await h.routes.scenes.GET(new Request("https://vivian.example/api/scenes"));
  assert.equal(freeSceneGet.status, 200);
  const freeSceneData = await freeSceneGet.json();
  assert.deepEqual(freeSceneData.scenes, []);
  assert.equal(freeSceneData.tier, "free");
  assert.equal(freeSceneData.cloudAllowed, false);

  const freePreset = await h.routes.scenePrefs.PATCH(
    new Request("https://vivian.example/api/scenes/preferences", {
      method: "PATCH",
      body: JSON.stringify({ preset: "night" }),
    }),
  );
  assert.equal(freePreset.status, 200);
  assert.equal((await freePreset.json()).preferences.preset, "night");

  const freeScenePost = await h.routes.scenes.POST(
    new Request("https://vivian.example/api/scenes", { method: "POST", body: "{}" }),
  );
  assert.equal(freeScenePost.status, 403);
  assert.equal((await freeScenePost.json()).code, "TIER_REQUIRED");

  const freePref = await h.routes.modelPref.PATCH(
    new Request("https://vivian.example/api/models/preference", {
      method: "PATCH",
      body: JSON.stringify({ modelId: `${soraModel.id}:witch.model3.json` }),
    }),
  );
  assert.equal(freePref.status, 403);
  assert.equal((await freePref.json()).code, "TIER_REQUIRED");

  const freeExpr = await h.routes.modelExpressions.PATCH(
    new Request(`https://vivian.example/api/models/${soraModel.id}/expressions`, {
      method: "PATCH",
      body: JSON.stringify({ manifestPath: "witch.model3.json", expressions: ["happy"] }),
    }),
    { params: Promise.resolve({ id: soraModel.id }) },
  );
  assert.equal(freeExpr.status, 403);
  assert.equal((await freeExpr.json()).code, "TIER_REQUIRED");

  const freeDeleteModel = await h.routes.modelItem.DELETE(
    new Request(`https://vivian.example/api/models/${soraModel.id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: soraModel.id }) },
  );
  assert.equal(freeDeleteModel.status, 403);
  assert.equal((await freeDeleteModel.json()).code, "TIER_REQUIRED");

  // 3. Selected user: sees own private models only (never Sorachan's shared model), 512 MiB cap, and personal storage status without global bucket totals
  h.db.tables.vivian_user_accounts.push({
    user_id: "u-sel",
    email: "selected@example.com",
    tier: "selected",
    legacy_claimed_at: null,
    created_at: "2026-11-23T00:00:00.000Z",
    updated_at: "2026-11-23T00:00:00.000Z",
  });
  h.setUser({ id: "u-sel", email: "selected@example.com" });

  const nearCap = 536870912 - 500;
  const selBegin = await h.routes.models.POST(
    new Request("https://vivian.example/api/models", {
      method: "POST",
      body: JSON.stringify({ byteSize: nearCap, manifests: [{ path: "mine.model3.json", name: "Mine" }] }),
    }),
  );
  assert.equal(selBegin.status, 201);
  const selModel = await selBegin.json();
  assert.equal(selModel.scope, "private");
  assert.equal(selModel.usage, null);
  await h.routes.modelItem.POST(
    new Request(`https://vivian.example/api/models/${selModel.id}`, { method: "POST" }),
    { params: Promise.resolve({ id: selModel.id }) },
  );

  // Exceeding 512 MiB personal cap fails with 403 STORAGE_QUOTA_EXCEEDED
  const overCap = await h.routes.models.POST(
    new Request("https://vivian.example/api/models", {
      method: "POST",
      body: JSON.stringify({ byteSize: 501, manifests: [{ path: "extra.model3.json", name: "Extra" }] }),
    }),
  );
  assert.equal(overCap.status, 403);
  assert.equal((await overCap.json()).code, "STORAGE_QUOTA_EXCEEDED");

  const selModels = await (await h.routes.models.GET(new Request("https://vivian.example/api/models"))).json();
  assert.equal(selModels.tier, "selected");
  assert.equal(selModels.cloudAllowed, true);
  assert.equal(selModels.sharedAllowed, false);
  assert.equal(selModels.usage, null);
  assert.equal(selModels.personalUsage.used, nearCap);
  assert.equal(selModels.personalUsage.limit, 536870912);
  assert.deepEqual(selModels.models.map((m) => m.id), [selModel.id]);

  const selStorage = await (await h.routes.storageStatus.GET(new Request("https://vivian.example/api/storage/status"))).json();
  assert.equal(selStorage.tier, "selected");
  assert.equal(selStorage.cloudAllowed, true);
  assert.equal(selStorage.usedBytes, nearCap);
  assert.equal(selStorage.personalLimitBytes, 536870912);
  assert.equal(selStorage.supabase, null);
  assert.equal(selStorage.r2.limitBytes, 536870912);

  // Selected user can create a private scene and receives signed image/thumbnail URLs
  const selSceneCreate = await h.routes.scenes.POST(
    new Request("https://vivian.example/api/scenes", { method: "POST" }),
  );
  assert.equal(selSceneCreate.status, 201);
  const createdScene = (await selSceneCreate.json()).scene;
  assert.match(createdScene.imageUrl, /[?&]token=/);
  assert.match(createdScene.thumbnailUrl, /[?&]token=/);

  // Unauthenticated GET /api/scenes/[id]/image without Authorization or valid token is rejected (401 AUTH_REQUIRED)
  const unauthNoToken = await h.routes.sceneImage.GET(
    new Request(`https://vivian.example/api/scenes/${createdScene.id}/image`),
    { params: Promise.resolve({ id: createdScene.id }) },
  );
  assert.equal(unauthNoToken.status, 401);
  assert.equal((await unauthNoToken.json()).code, "AUTH_REQUIRED");

  // Tampered or wrong-scene token is rejected (401 AUTH_REQUIRED)
  const badTokenImg = await h.routes.sceneImage.GET(
    new Request(`https://vivian.example/api/scenes/${createdScene.id}/image?token=tampered.token`),
    { params: Promise.resolve({ id: createdScene.id }) },
  );
  assert.equal(badTokenImg.status, 401);
  assert.equal((await badTokenImg.json()).code, "AUTH_REQUIRED");

  const otherSceneId = "00000000-0000-4000-8000-000000000099";
  const signedToken = new URL(createdScene.imageUrl, "https://vivian.example").searchParams.get("token");
  const wrongSceneTokenRes = await h.routes.sceneImage.GET(
    new Request(`https://vivian.example/api/scenes/${otherSceneId}/image?token=${encodeURIComponent(signedToken)}`),
    { params: Promise.resolve({ id: otherSceneId }) },
  );
  assert.equal(wrongSceneTokenRes.status, 401);

  // Signed imageUrl & thumbnailUrl work for <img> without Authorization header and stay private
  const signedImgRes = await h.routes.sceneImage.GET(
    new Request(`https://vivian.example${createdScene.imageUrl}`),
    { params: Promise.resolve({ id: createdScene.id }) },
  );
  assert.equal(signedImgRes.status, 200);
  assert.match(signedImgRes.headers.get("cache-control") ?? "", /^private/);

  const signedThumbRes = await h.routes.sceneImage.GET(
    new Request(`https://vivian.example${createdScene.thumbnailUrl}`),
    { params: Promise.resolve({ id: createdScene.id }) },
  );
  assert.equal(signedThumbRes.status, 200);

  // Authenticated GET /api/scenes/[id]/image as free returns 403 TIER_REQUIRED
  h.setUser({ id: "u-free", email: "free@example.com" });
  const authFreeImg = await h.routes.sceneImage.GET(
    new Request(`https://vivian.example/api/scenes/${createdScene.id}/image`, {
      headers: { authorization: "Bearer tok" },
    }),
    { params: Promise.resolve({ id: createdScene.id }) },
  );
  assert.equal(authFreeImg.status, 403);
  assert.equal((await authFreeImg.json()).code, "TIER_REQUIRED");

  // Another Selected user cannot fetch u-sel's scene via Bearer auth (404)
  h.db.tables.vivian_user_accounts.push({
    user_id: "u-sel-other",
    email: "selected-other@example.com",
    tier: "selected",
    legacy_claimed_at: null,
    created_at: "2026-11-23T00:00:00.000Z",
    updated_at: "2026-11-23T00:00:00.000Z",
  });
  h.setUser({ id: "u-sel-other", email: "selected-other@example.com" });
  const otherSelImg = await h.routes.sceneImage.GET(
    new Request(`https://vivian.example/api/scenes/${createdScene.id}/image`, {
      headers: { authorization: "Bearer tok" },
    }),
    { params: Promise.resolve({ id: createdScene.id }) },
  );
  assert.equal(otherSelImg.status, 404);

  // Downgrading u-sel to free immediately invalidates previously signed image tokens (403 TIER_REQUIRED)
  h.db.tables.vivian_user_accounts.find((a) => a.user_id === "u-sel").tier = "free";
  const downgradedImgRes = await h.routes.sceneImage.GET(
    new Request(`https://vivian.example${createdScene.imageUrl}`),
    { params: Promise.resolve({ id: createdScene.id }) },
  );
  assert.equal(downgradedImgRes.status, 403);
  assert.equal((await downgradedImgRes.json()).code, "TIER_REQUIRED");

  // 4. Sorachan sees both full global storage status and shared models
  h.setUser({ id: "u-sora", email: "suphloeksangko@gmail.com" });
  const soraModels = await (await h.routes.models.GET(new Request("https://vivian.example/api/models"))).json();
  assert.equal(soraModels.tier, "sorachan");
  assert.equal(soraModels.cloudAllowed, true);
  assert.equal(soraModels.sharedAllowed, true);
  assert.ok(soraModels.usage && soraModels.usage.live2d.limit === 8_000_000_000);
  assert.deepEqual(soraModels.models.map((m) => m.id), [soraModel.id]);

  const soraStorage = await (await h.routes.storageStatus.GET(new Request("https://vivian.example/api/storage/status"))).json();
  assert.equal(soraStorage.tier, "sorachan");
  assert.equal(soraStorage.cloudAllowed, true);
  assert.equal(soraStorage.r2.limitBytes, 8_000_000_000);
  assert.equal(soraStorage.supabase.usedBytes, 123456);
});
