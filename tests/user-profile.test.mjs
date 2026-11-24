import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { loadSceneModule as load } from "./scene-module-loader.mjs";

function loadTsxWithMocks(relPath, imports = {}, globals = {}) {
  const raw = readFileSync(new URL(relPath, import.meta.url), "utf8");
  const transpiled = ts.transpileModule(raw, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  const cjsModule = { exports };
  const fn = new Function(
    "exports",
    "module",
    "require",
    ...Object.keys(globals),
    transpiled,
  );
  fn(
    exports,
    cjsModule,
    (name) => {
      if (name in imports) return imports[name];
      if (name === "react/jsx-runtime") {
        return {
          jsx: (type, props, key) => ({ type, props, key: key ?? null }),
          jsxs: (type, props, key) => ({ type, props, key: key ?? null }),
          Fragment: Symbol.for("react.fragment"),
        };
      }
      throw new Error(`Unexpected import in ${relPath}: ${name}`);
    },
    ...Object.values(globals),
  );
  return cjsModule.exports;
}

function collectText(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (typeof node === "object" && "type" in node) {
    if (typeof node.type === "function") {
      return collectText(node.type(node.props ?? {}));
    }
    return collectText(node.props?.children);
  }
  return "";
}

const userProfileMod = load("../lib/user-profile.ts");
const storyMod = load("../lib/vivian-story.ts");
const personaMod = load("../lib/vivian-persona.ts", {
  "@/lib/custom-instructions": load("../lib/custom-instructions.ts"),
});
const policyMod = load("../lib/auth/policy.ts");

test("validateUserProfileInput enforces length limits, relationship presets, and onboarded flag", () => {
  const valid = userProfileMod.validateUserProfileInput({
    displayName: "  พี่มิน  ",
    relationship: "senior_junior",
    pronouns: "  เรียกพี่มิน แทนตัวเองว่าวิเวียน  ",
    styleNotes: "  ชอบคุยเรื่องเกมและอนิเมะ  ",
    onboarded: true,
  });
  assert.equal(valid.ok, true);
  assert.deepEqual({ ...valid.value }, {
    displayName: "พี่มิน",
    relationship: "senior_junior",
    pronouns: "เรียกพี่มิน แทนตัวเองว่าวิเวียน",
    styleNotes: "ชอบคุยเรื่องเกมและอนิเมะ",
    onboarded: true,
  });

  // Rejects oversize inputs
  assert.equal(
    userProfileMod.validateUserProfileInput({ displayName: "ก".repeat(61) }).ok,
    false,
  );
  assert.equal(
    userProfileMod.validateUserProfileInput({ relationship: "unknown_preset" }).ok,
    false,
  );
  assert.equal(
    userProfileMod.validateUserProfileInput({ pronouns: "ก".repeat(81) }).ok,
    false,
  );
  assert.equal(
    userProfileMod.validateUserProfileInput({ styleNotes: "ก".repeat(501) }).ok,
    false,
  );
});

test("Sorachan account keeps Sora/โซระจัง canon while non-Sorachan accounts use their own profile and exclude Sora/Ryuka", () => {
  // 1. Sorachan default keeps full VIVIAN_STORY and vivianPersonaPrompt
  assert.equal(
    storyMod.vivianStoryForUser({ isSorachan: true }),
    storyMod.VIVIAN_STORY,
  );
  assert.equal(
    personaMod.vivianPersonaForUser({ isSorachan: true }),
    personaMod.vivianPersonaPrompt,
  );

  // 2. Non-Sorachan account replaces Sora with their own name and strips secret Sorachan/Ryuka fantasy
  const otherStory = storyMod.vivianStoryForUser({
    isSorachan: false,
    displayName: "คุณภัทร",
  });
  assert.match(otherStory, /คุณภัทร/);
  assert.doesNotMatch(otherStory, /แอบชอบโซระจังเงียบ ๆ/);
  assert.doesNotMatch(otherStory, /จินตนาการภาพโซระกับริวกะ/);

  const otherPersona = personaMod.vivianPersonaForUser({
    isSorachan: false,
    displayName: "คุณภัทร",
  });
  assert.match(otherPersona, /talking with คุณภัทร/);
  assert.doesNotMatch(otherPersona, /Sora \(โซระจัง\)/);

  const block = userProfileMod.buildUserProfilePromptBlock(
    {
      displayName: "คุณภัทร",
      relationship: "crush_partner",
      pronouns: "เรียกคุณภัทร ลงท้ายค่ะ",
      styleNotes: "ชอบคุยเรื่องเขียนโค้ดและกาแฟ",
    },
    { isSorachan: false },
  );
  assert.match(block, /คู่สนทนาปัจจุบันชื่อ: "คุณภัทร"/);
  assert.match(block, /ห้ามเรียกคู่สนทนาคนนี้ว่า "โซระจัง"/);
  assert.match(block, /คนพิเศษที่ Vivian แอบมีใจให้/);
  assert.match(block, /เรียกคุณภัทร ลงท้ายค่ะ/);
  assert.match(block, /ชอบคุยเรื่องเขียนโค้ดและกาแฟ/);
});

const userProfileStoreMod = load("../lib/user-profile-store.ts", {
  "./user-profile": userProfileMod,
});

test("/api/user-profile isolates profiles per account ID, falls back cleanly when table is missing, and marks Sorachan onboarded by default", async () => {
  const rows = new Map();
  const ciFallbackRows = new Map();
  let simulateMissingTable = false;
  let activeUser = { id: "user-1", email: "newuser@example.com" };

  const route = load("../app/api/user-profile/route.ts", {
    "@/lib/auth/policy": policyMod,
    "@/lib/user-profile": userProfileMod,
    "@/lib/user-profile-store": userProfileStoreMod,
    "@/lib/auth/server": {
      requireApiAccess: async (_req, cb) => {
        cb(activeUser);
        return null;
      },
    },
    "@/lib/supabase-admin": {
      getSupabaseAdmin: () => ({
        from(table) {
          let filterUserId = "";
          let upserted = null;
          const q = {
            select() { return q; },
            eq(_col, val) { filterUserId = val; return q; },
            upsert(payload) {
              if (table === "vivian_user_profiles") {
                if (simulateMissingTable) {
                  return Object.assign(Promise.resolve({ data: null, error: { code: "PGRST205", message: "missing table" } }), {
                    select() { return q; },
                    single() { return Promise.resolve({ data: null, error: { code: "PGRST205", message: "missing table" } }); },
                  });
                }
                upserted = payload;
                rows.set(payload.user_id, { ...payload });
                return q;
              }
              assert.equal(table, "vivian_user_custom_instructions");
              ciFallbackRows.set(payload.user_id, { ...payload });
              return Promise.resolve({ data: payload, error: null });
            },
            async maybeSingle() {
              if (table === "vivian_user_profiles") {
                if (simulateMissingTable) return { data: null, error: { code: "PGRST205", message: "missing table" } };
                return { data: rows.get(filterUserId) ?? null, error: null };
              }
              assert.equal(table, "vivian_user_custom_instructions");
              return { data: ciFallbackRows.get(filterUserId) ?? null, error: null };
            },
            async single() {
              return { data: upserted, error: null };
            },
          };
          return q;
        },
      }),
    },
  });

  // 1. New non-Sorachan user starts with onboarded: false and empty displayName
  const getNew = await (await route.GET(new Request("https://vivian.example/api/user-profile"))).json();
  assert.equal(getNew.userId, "user-1");
  assert.equal(getNew.isSorachan, false);
  assert.equal(getNew.profile.onboarded, false);
  assert.equal(getNew.profile.displayName, "");

  // 2. Saving profile via PATCH stores under user-1
  const patchRes = await route.PATCH(
    new Request("https://vivian.example/api/user-profile", {
      method: "PATCH",
      body: JSON.stringify({
        displayName: "มินจัง",
        relationship: "close_friend",
        pronouns: "เรียกมินจัง",
        styleNotes: "ชอบฟังเพลง",
        onboarded: true,
      }),
    }),
  );
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.profile.displayName, "มินจัง");
  assert.equal(patched.profile.onboarded, true);

  // 3. Another non-Sorachan account (user-2) does NOT see user-1's profile
  activeUser = { id: "user-2", email: "second@example.com" };
  const getSecond = await (await route.GET(new Request("https://vivian.example/api/user-profile"))).json();
  assert.equal(getSecond.userId, "user-2");
  assert.equal(getSecond.profile.displayName, "");
  assert.equal(getSecond.profile.onboarded, false);

  // 4. Even when vivian_user_profiles migration is missing, fallback saves & reads cleanly under profile:${userId}
  simulateMissingTable = true;
  const fallbackPatch = await route.PATCH(
    new Request("https://vivian.example/api/user-profile", {
      method: "PATCH",
      body: JSON.stringify({
        displayName: "คุณฮูเต๋า",
        relationship: "senior_junior",
        pronouns: "เรียกคุณฮูเต๋า",
        styleNotes: "ชอบเกม",
        onboarded: true,
      }),
    }),
  );
  assert.equal(fallbackPatch.status, 200);
  assert.ok(ciFallbackRows.has("profile:user-2"));
  const fallbackGet = await (await route.GET(new Request("https://vivian.example/api/user-profile"))).json();
  assert.equal(fallbackGet.profile.displayName, "คุณฮูเต๋า");
  assert.equal(fallbackGet.profile.onboarded, true);

  // 5. Sorachan account defaults to onboarded: true and "โซระจัง"
  simulateMissingTable = false;
  activeUser = { id: "user-sora", email: "suphloeksangko@gmail.com" };
  const getSora = await (await route.GET(new Request("https://vivian.example/api/user-profile"))).json();
  assert.equal(getSora.isSorachan, true);
  assert.equal(getSora.profile.onboarded, true);
  assert.equal(getSora.profile.displayName, "โซระจัง");
});

test("UserOnboardingModal and UserProfileSettingsCard render onboarding fields and relationship presets", () => {
  const modalMod = loadTsxWithMocks("../app/components/user-onboarding-modal.tsx", {
    react: {
      useEffect: () => {},
      useState: (init) => [init, () => {}],
    },
    "@/lib/user-profile": userProfileMod,
  });

  const tree = modalMod.UserOnboardingModal({
    open: true,
    profile: userProfileMod.defaultUserProfile("u1", false),
    saving: false,
    onSave: async () => true,
    onSkip: () => {},
  });
  const text = collectText(tree);
  assert.match(text, /ทักทายกันก่อนสักนิดป่ะ~/);
  assert.match(text, /อยากให้ Vivian เรียกเธอว่าอะไรดี/);
  assert.match(text, /เพื่อนซี้ \(Close Friend\)/);
  assert.match(text, /รุ่นพี่ \/ รุ่นน้อง \(Senior \/ Junior\)/);
  assert.match(text, /คนคุย \/ คนพิเศษ \(Special Person\)/);
  assert.match(text, /เซฟแล้วไปคุยกับ Vivian เลย!/);

  const cardTree = modalMod.UserProfileSettingsCard({
    profile: {
      userId: "u1",
      displayName: "พี่ภัทร",
      relationship: "senior_junior",
      pronouns: "เรียกพี่ภัทร",
      styleNotes: "ชอบอนิเมะ",
      onboarded: true,
      updatedAt: null,
    },
    saving: false,
    notice: "",
    onOpenModal: () => {},
  });
  const cardText = collectText(cardTree);
  assert.match(cardText, /พี่ภัทร/);
  assert.match(cardText, /รุ่นพี่ \/ รุ่นน้อง/);
  assert.match(cardText, /โปรไฟล์คู่คุยของเธอ/);
});

test("/api/chat strictly isolates non-Sorachan accounts (even before onboarding) and sanitizes legacy assistant turns", async () => {
  const { createRequire } = await import("node:module");
  const { webcrypto } = await import("node:crypto");
  const req = createRequire(import.meta.url);
  const nextServer = req("next/server");

  const profiles = new Map([
    [
      "u-new",
      {
        user_id: "u-new",
        display_name: "คุณมิน",
        relationship: "senior_junior",
        pronouns: "เรียกคุณมิน ลงท้ายค่ะ",
        style_notes: "ชอบคุยเรื่องเกม RPG",
        onboarded: true,
        updated_at: "2026-11-23T06:00:00.000Z",
      },
    ],
  ]);

  let currentUser = { id: "u-unonboarded", email: "hutao84612@gmail.com" };
  const groqPayloads = [];

  const globals = {
    crypto: webcrypto,
    performance,
    URLSearchParams,
    FormData,
    Headers,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    process: {
      env: {
        GROQ_API_KEY: "fixture-groq",
        SUPABASE_URL: "https://db.example",
        SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role",
      },
    },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      groqPayloads.push(body);
      return Response.json({ choices: [{ message: { content: "[playful] สวัสดีค่ะ" } }] });
    },
  };

  const companion = load("../lib/companion.ts", {}, globals);
  const scenes = load("../lib/scenes.ts", {}, globals);
  const tools = load("../lib/tools.ts", {}, globals);
  const jev = load("../lib/jev.ts", { "@/lib/scenes": scenes }, globals);

  const chatRoute = load(
    "../app/api/chat/route.ts",
    {
      "@/lib/chat-stream": load("../lib/chat-stream.ts", {}, globals),
      "@/lib/chat-history": load("../lib/chat-history.ts", {}, globals),
      "@/lib/chat-history-store": { saveHistory: async () => {} },
      "@/lib/auth/server": {
        requireAuthorizedUser: async () => ({ user: currentUser, denied: null }),
      },
      "@/lib/auth/policy": policyMod,
      "@/lib/user-tiers": {
        ...load("../lib/user-tiers.ts", { "./auth/policy.ts": policyMod }, globals),
        assertAndConsumeChatQuota: async () => ({
          allowed: true,
          tier: "free",
          used: 1,
          limit: 5,
          remaining: 4,
          usageDate: "2026-11-23",
          resetAt: "2026-11-23T17:00:00.000Z",
        }),
        refundChatQuota: async () => true,
      },
      "@/lib/companion": companion,
      "@/lib/vivian-persona": personaMod,
      "@/lib/vivian-story": storyMod,
      "@/lib/user-profile": userProfileMod,
      "@/lib/user-profile-store": userProfileStoreMod,
      "@/lib/companion-store": {
        loadCompanionState: async () => companion.defaultCompanionState(),
        saveCompanionState: async () => {},
      },
      "@/lib/elevenlabs-voice": { resolveElevenLabsVoiceId: async () => "v1" },
      "@/lib/tts-session-factory": { createTtsSession: () => ({ pushDelta() {}, async finish() {}, abort() {} }) },
      "@/lib/tts-stream-session": {
        StreamingTtsSession: class {
          pushDelta() {}
          async finish() {}
          abort() {}
        },
      },
      "@/lib/supabase-admin": {
        getSupabaseAdmin: () => ({
          from(table) {
            let userId = "";
            const q = {
              select() { return q; },
              eq(_col, val) { userId = val; return q; },
              order() { return q; },
              limit() { return Promise.resolve({ data: [], error: null }); },
              maybeSingle() {
                if (table === "vivian_user_profiles") {
                  return Promise.resolve({ data: profiles.get(userId) ?? null, error: null });
                }
                return Promise.resolve({ data: null, error: null });
              },
            };
            return q;
          },
        }),
      },
      "@/lib/tools": tools,
      "@/lib/rate-limit": { rateLimit: () => ({ allowed: true }) },
      "@/lib/jev": jev,
      "@/lib/scene-store": {
        loadSceneContext: async () => null,
        executeSceneDecision: async () => ({ change: false }),
      },
      "@/lib/scenes": scenes,
      "@/lib/chat-decision": load(
        "../lib/chat-decision.ts",
        { "@/lib/tools": tools, "@/lib/jev": jev, "@/lib/scenes": scenes },
        globals,
      ),
      "@/lib/speech": load("../lib/speech.ts", {}, globals),
      "@/lib/memory-v2": load("../lib/memory-v2.ts", {}, globals),
      "@/lib/memory-consolidation": {
        runConsolidation: async () => ({ ok: true }),
        writeMemoryItem: async () => "inserted",
      },
      "@/lib/memory-recall": load("../lib/memory-recall.ts", {}, globals),
      "@/lib/memory-embeddings": load("../lib/memory-embeddings.ts", {}, globals),
      "next/server": { ...nextServer, after: () => {} },
    },
    globals,
  );

  // 1. Non-Sorachan user who has NOT onboarded yet still NEVER gets Sorachan/Ryuka in system prompt or old assistant turns
  const resUnonboarded = await chatRoute.POST(
    new Request("https://vivian.example/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Huss, Huss Huss" },
          { role: "assistant", content: '"ฮัส ฮัส ฮัส" อะไรของแกเนี่ย โซระจัง?' },
          { role: "user", content: "สบายดีไหม" },
        ],
      }),
    }),
  );
  assert.equal(resUnonboarded.status, 200);
  const unonboardedPayload = groqPayloads.at(-1);
  const unonboardedPrompt = unonboardedPayload.messages[0].content;
  assert.doesNotMatch(unonboardedPrompt, /Sora \(โซระจัง\)/);
  assert.doesNotMatch(unonboardedPrompt, /แอบชอบโซระจังเงียบ ๆ/);
  assert.doesNotMatch(unonboardedPrompt, /จินตนาการภาพโซระกับริวกะ/);
  assert.doesNotMatch(unonboardedPrompt, /ส่วน sorachan \(โซระจัง\)/);
  // Prior assistant reply saying โซระจัง is sanitized so the LLM won't mimic it
  assert.doesNotMatch(unonboardedPayload.messages[2].content, /โซระจัง/);

  // 2. Non-Sorachan user with profile ("คุณมิน") gets personalized prompt without Sorachan/Ryuka
  currentUser = { id: "u-new", email: "min@example.com" };
  const resNew = await chatRoute.POST(
    new Request("https://vivian.example/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "สวัสดี" }] }),
    }),
  );
  assert.equal(resNew.status, 200);
  const newPrompt = groqPayloads.at(-1).messages[0].content;
  assert.match(newPrompt, /คุณมิน/);
  assert.match(newPrompt, /ชอบคุยเรื่องเกม RPG/);
  assert.match(newPrompt, /มีความสัมพันธ์แบบรุ่นพี่-รุ่นน้อง/);
  assert.doesNotMatch(newPrompt, /แอบชอบโซระจังเงียบ ๆ/);
  assert.doesNotMatch(newPrompt, /จินตนาการภาพโซระกับริวกะ/);

  // 3. Sorachan account keeps full Sorachan canon
  currentUser = { id: "u-sora", email: "suphloeksangko@gmail.com" };
  const resSora = await chatRoute.POST(
    new Request("https://vivian.example/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "สวัสดี" }] }),
    }),
  );
  assert.equal(resSora.status, 200);
  const soraPrompt = groqPayloads.at(-1).messages[0].content;
  assert.match(soraPrompt, /Sora \(โซระจัง\)/);
  assert.match(soraPrompt, /แอบชอบโซระจังเงียบ ๆ/);
  assert.match(soraPrompt, /จินตนาการภาพโซระกับริวกะ/);
});
