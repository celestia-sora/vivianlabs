import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { loadSceneModule as load } from "./scene-module-loader.mjs";
import { readChatResponse } from "../lib/chat-stream.ts";

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
  const module = { exports };
  const fn = new Function(
    "exports",
    "module",
    "require",
    ...Object.keys(globals),
    transpiled,
  );
  fn(
    exports,
    module,
    (name) => {
      if (name in imports) return imports[name];
      if (name === "react/jsx-runtime") {
        return {
          jsx: (type, props) => ({ type, props }),
          jsxs: (type, props) => ({ type, props }),
          Fragment: Symbol.for("react.fragment"),
        };
      }
      throw new Error(`Unexpected import in ${relPath}: ${name}`);
    },
    ...Object.values(globals),
  );
  return module.exports;
}

const tierPanel = loadTsxWithMocks("../app/components/tier-panel.tsx", {
  react: {
    useCallback: (fn) => fn,
    useEffect: () => {},
    useState: (init) => [init, () => {}],
  },
  "@/lib/auth/fetch": { authFetch: async () => Response.json({}) },
});

test("tier badge & chat quota formatters match Free, Selected, Sorachan specs", () => {
  assert.equal(
    tierPanel.formatTierChatBadge("free", {
      allowed: true,
      tier: "free",
      used: 2,
      limit: 5,
      remaining: 3,
      usageDate: "2026-11-23",
      resetAt: "2026-11-23T17:00:00.000Z",
    }),
    "Free · 3/5 chats today",
  );
  assert.equal(
    tierPanel.formatTierChatBadge("selected", {
      allowed: true,
      tier: "selected",
      used: 2,
      limit: 20,
      remaining: 18,
      usageDate: "2026-11-23",
      resetAt: "2026-11-23T17:00:00.000Z",
    }),
    "Selected · 18/20 chats today",
  );
  assert.equal(
    tierPanel.formatTierChatBadge("free", {
      allowed: false,
      tier: "free",
      used: 5,
      limit: 5,
      remaining: 0,
      usageDate: "2026-11-23",
      resetAt: "2026-11-23T17:00:00.000Z",
    }),
    "Free · 0/5 chats today",
  );
  assert.equal(tierPanel.formatTierChatBadge("sorachan", null), "Sorachan · Unlimited");
  assert.equal(tierPanel.formatPersonalMb(512 * 1024 * 1024), "512.0 MB");
  assert.equal(tierPanel.formatPersonalMb(0), "0.0 MB");
});

test("isQuotaDepleted respects remaining count, Sorachan unlimited, and Bangkok reset time", () => {
  const resetAt = "2026-11-23T17:00:00.000Z";
  const beforeReset = Date.parse("2026-11-23T16:59:00.000Z");
  const afterReset = Date.parse("2026-11-23T17:00:01.000Z");

  assert.equal(
    tierPanel.isQuotaDepleted({ allowed: false, tier: "free", used: 5, limit: 5, remaining: 0, usageDate: "2026-11-23", resetAt }, beforeReset),
    true,
  );
  assert.equal(
    tierPanel.isQuotaDepleted({ allowed: false, tier: "free", used: 5, limit: 5, remaining: 0, usageDate: "2026-11-23", resetAt }, afterReset),
    false,
  );
  assert.equal(
    tierPanel.isQuotaDepleted({ allowed: true, tier: "free", used: 2, limit: 5, remaining: 3, usageDate: "2026-11-23", resetAt }, beforeReset),
    false,
  );
  assert.equal(
    tierPanel.isQuotaDepleted({ allowed: true, tier: "sorachan", used: 0, limit: null, remaining: null, usageDate: "2026-11-23", resetAt }, beforeReset),
    false,
  );
});

test("vivianQuotaExceededReply stays in character, mentions UTC+7 reset, and never says connection lost", () => {
  for (const tier of ["free", "selected"]) {
    const reply = tierPanel.vivianQuotaExceededReply(tier);
    assert.doesNotMatch(reply, /การเชื่อมต่อขาด/);
    assert.match(reply, /UTC\+7/);
    assert.match(reply, /เที่ยงคืน/);
  }
  assert.match(tierPanel.vivianQuotaExceededReply("free"), /Selected Tier/);

  const mailto = tierPanel.buildClientMailtoUrl({
    userEmail: "reader@example.com",
    userId: "user-123",
    displayName: "Sora Fan",
    reason: "Want cloud models",
    requestId: "req-999",
  });
  assert.match(mailto, /^mailto:viviannextlabs@gmail\.com\?subject=/);
  assert.match(decodeURIComponent(mailto), /reader@example\.com/);
  assert.match(decodeURIComponent(mailto), /user-123/);
  assert.match(decodeURIComponent(mailto), /Sora Fan/);
  assert.match(decodeURIComponent(mailto), /Want cloud models/);
  assert.match(decodeURIComponent(mailto), /req-999/);
});

test("cloud-models handles free tier cloudAllowed:false and propagates 403 tier/quota errors", async () => {
  const limits = load("../lib/cloud-storage.ts", {}, { TextDecoder });
  const statusFormat = load("../lib/storage-status.ts");

  let nextResponse = () => Response.json({
    userId: "free-user",
    tier: "free",
    cloudAllowed: false,
    models: [],
    usage: null,
    preference: null,
  });

  const cloudModels = load("../lib/cloud-models.ts", {
    "@/lib/auth/fetch": { authFetch: async () => nextResponse() },
    "@/lib/local-models": {},
    "@/lib/cloud-storage": limits,
    "@/lib/storage-status": statusFormat,
  });

  const freeLib = await cloudModels.getCloudModels();
  assert.equal(freeLib.tier, "free");
  assert.equal(freeLib.cloudAllowed, false);
  assert.equal(freeLib.usage, null);
  assert.equal(cloudModels.isCloudLibraryAllowed(freeLib), false);
  assert.equal(cloudModels.isCloudLibraryAllowed({ userId: "sel", tier: "selected", cloudAllowed: true, models: [], usage: null }), true);
  assert.equal(cloudModels.isCloudLibraryAllowed({ userId: "legacy", models: [], usage: null }), true);

  nextResponse = () => Response.json(
    { error: "Selected tier required", code: "TIER_REQUIRED", requiredTier: "selected" },
    { status: 403 },
  );
  await assert.rejects(
    () => cloudModels.saveCloudModelPreference("m1:m.model3.json"),
    (err) => err instanceof cloudModels.CloudModelError && err.status === 403 && err.code === "TIER_REQUIRED" && err.requiredTier === "selected",
  );
});

test("sceneRequest preserves 403 TIER_REQUIRED and STORAGE_QUOTA_EXCEEDED error metadata", async () => {
  let code = "TIER_REQUIRED";
  const sceneLib = load("../lib/use-scene-library.ts", {
    react: { useCallback: (fn) => fn, useEffect: () => {}, useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}] },
    "@/lib/auth/fetch": {
      authFetch: async () => Response.json(
        { error: "Upgrade required", code, requiredTier: "selected" },
        { status: 403 },
      ),
    },
    "@/lib/storage-status": { notifyStorageChanged() {} },
    "@/lib/scenes": { AUTO_SCENE_ENABLED: false },
    "@/lib/performance": { startTiming: () => ({}), cancelTiming() {} },
    "@/lib/scene-preload": { preloadSceneLibrary: async () => {}, preloadSceneImage: async () => {} },
  });

  await assert.rejects(
    () => sceneLib.sceneRequest("/api/scenes", { method: "POST" }),
    (err) => err instanceof sceneLib.SceneRequestError && err.status === 403 && err.code === "TIER_REQUIRED",
  );

  code = "STORAGE_QUOTA_EXCEEDED";
  await assert.rejects(
    () => sceneLib.sceneRequest("/api/scenes", { method: "POST" }),
    (err) => err instanceof sceneLib.SceneRequestError && err.status === 403 && err.code === "STORAGE_QUOTA_EXCEEDED",
  );
});

test("companion sendMessage handles QUOTA_EXCEEDED and pre-flight zero quota without showing connection lost", async () => {
  const companionSource = readFileSync(new URL("../app/companion.tsx", import.meta.url), "utf8");
  const start = companionSource.indexOf("  function handleChatQuotaReached(");
  const end = companionSource.indexOf("  // Thin adapter kept for the old call shape:", start);
  const block = ts.transpileModule(companionSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  function buildHarness({ account, fetchImpl }) {
    const state = {
      account,
      messages: [],
      draft: "สวัสดีวิเวียน",
      errorNotice: "old error",
      limitModalOpen: false,
      sending: false,
      fetchCalls: 0,
    };
    const accountRef = { current: account };
    const messagesRef = { current: state.messages };
    const bindings = {
      AbortController,
      crypto,
      Date,
      Error,
      performance,
      window: { setTimeout, clearTimeout },
      console: { error() {}, warn() {} },
      CHAT_TIMEOUT_MS: 5000,
      TTS_TIMEOUT_MS: 5000,
      selectedModel: "Miss",
      readChatResponse,
      isQuotaDepleted: tierPanel.isQuotaDepleted,
      vivianQuotaExceededReply: tierPanel.vivianQuotaExceededReply,
      historyMessage: (from, text, id = crypto.randomUUID()) => ({ id, from, text }),
      normalizeCompanion: () => null,
      startTiming: () => undefined,
      finishTiming() {},
      cancelTiming() {},
      withTimeout: async (p) => p,
      unlockAudio: async () => {},
      getAudioStreamer: () => ({
        startTurn() {},
        setContext() {},
        enqueueChunk() {},
        resetAttempt() {},
        markTurnComplete() {},
        markTurnError() {},
        waitForPlaybackStart: async () => ({ started: false, interrupted: false }),
        hasStartedPlayback: () => false,
        interrupt() {},
      }),
      speak: async () => false,
      playReaction: async () => {},
      resetReaction() {},
      loadMemory: async () => {},
      refreshAccount: async () => {},
      stopSpeech() {},
      markActivity() {},
      captureCurrentFrame: () => null,
      handleExpressionCommand: async () => false,
      authFetch: async (url, init) => {
        state.fetchCalls += 1;
        return fetchImpl(url, init);
      },
      accountRef,
      cameraActiveRef: { current: false },
      sendingRef: { current: false },
      resettingRef: { current: false },
      speakingRef: { current: false },
      mutedRef: { current: true },
      userInterruptedRef: { current: false },
      interactedRef: { current: false },
      messagesRef,
      activeConversationRef: { current: "conv-1" },
      chatStreamAbortRef: { current: null },
      audioContextRef: { current: null },
      speechLanguageRef: { current: "th" },
      voiceIdRef: { current: "" },
      history: { ready: true, isCloudConversation: () => false },
      conversations: [],
      sceneLibrary: { getGeneration: () => 1, applyChatScene() {} },
      message: state.draft,
      attachedImage: null,
      setAccount: (updater) => {
        state.account = typeof updater === "function" ? updater(state.account) : updater;
        accountRef.current = state.account;
      },
      setMessages: (updater) => {
        state.messages = typeof updater === "function" ? updater(state.messages) : updater;
        messagesRef.current = state.messages;
      },
      setMessage: (v) => { state.draft = v; },
      setAttachedImage: () => {},
      setSending: (v) => { state.sending = v; },
      setErrorNotice: (v) => { state.errorNotice = v; },
      setLimitModalOpen: (v) => { state.limitModalOpen = v; },
      setCompanion: () => {},
      setMemories: () => {},
    };
    const sendMessage = new Function(...Object.keys(bindings), `${block}\nreturn sendMessage;`)(...Object.values(bindings));
    return { state, sendMessage };
  }

  // 1. Server returns 403 QUOTA_EXCEEDED
  const futureReset = new Date(Date.now() + 3600_000).toISOString();
  const h1 = buildHarness({
    account: {
      user: { id: "u1", email: "free@example.com" },
      tier: "free",
      capabilities: { tier: "free", dailyChatLimit: 5, canUseCloudModels: false, canUseCloudScenes: false, canViewSharedModels: false, personalStorageLimitBytes: 0, isAdmin: false },
      chatQuota: { allowed: true, tier: "free", used: 4, limit: 5, remaining: 1, usageDate: "2026-11-23", resetAt: futureReset },
      storage: { usedBytes: 0, limitBytes: 0 },
      selectedRequest: null,
      mailtoUrl: "mailto:viviannextlabs@gmail.com",
      requestEmail: "viviannextlabs@gmail.com",
    },
    fetchImpl: async () => Response.json(
      {
        error: "Daily chat limit reached",
        status: 403,
        code: "QUOTA_EXCEEDED",
        requiredTier: "selected",
        quota: { allowed: false, tier: "free", used: 5, limit: 5, remaining: 0, usageDate: "2026-11-23", resetAt: futureReset },
      },
      { status: 403 },
    ),
  });
  await h1.sendMessage();
  assert.equal(h1.state.fetchCalls, 1);
  assert.equal(h1.state.errorNotice, null);
  assert.equal(h1.state.limitModalOpen, true);
  assert.equal(h1.state.account.chatQuota.remaining, 0);
  assert.equal(h1.state.draft, "สวัสดีวิเวียน");
  assert.equal(h1.state.messages.length, 1);
  assert.equal(h1.state.messages[0].from, "vivian");
  assert.doesNotMatch(h1.state.messages[0].text, /การเชื่อมต่อขาด/);
  assert.match(h1.state.messages[0].text, /Selected Tier/);

  // 2. Pre-flight blocks when remaining === 0 before resetAt (no network call)
  await h1.sendMessage();
  assert.equal(h1.state.fetchCalls, 1);
  assert.equal(h1.state.errorNotice, null);
  assert.equal(h1.state.limitModalOpen, true);

  // 3. Normal success updates chatQuota live
  const h2 = buildHarness({
    account: {
      user: { id: "u1", email: "free@example.com" },
      tier: "free",
      capabilities: { tier: "free", dailyChatLimit: 5, canUseCloudModels: false, canUseCloudScenes: false, canViewSharedModels: false, personalStorageLimitBytes: 0, isAdmin: false },
      chatQuota: { allowed: true, tier: "free", used: 0, limit: 5, remaining: 5, usageDate: "2026-11-23", resetAt: futureReset },
      storage: { usedBytes: 0, limitBytes: 0 },
      selectedRequest: null,
      mailtoUrl: "mailto:viviannextlabs@gmail.com",
      requestEmail: "viviannextlabs@gmail.com",
    },
    fetchImpl: async () => Response.json({
      text: "สวัสดีค่ะ",
      chatQuota: { allowed: true, tier: "free", used: 1, limit: 5, remaining: 4, usageDate: "2026-11-23", resetAt: futureReset },
    }),
  });
  await h2.sendMessage();
  assert.equal(h2.state.account.chatQuota.remaining, 4);
  assert.equal(h2.state.errorNotice, null);
  assert.equal(h2.state.limitModalOpen, false);
});

test("companion importModels keeps local IndexedDB import working on Free tier without calling cloud sync", async () => {
  const companionSource = readFileSync(new URL("../app/companion.tsx", import.meta.url), "utf8");
  const start = companionSource.indexOf("  async function importModels(");
  const end = companionSource.indexOf("  async function syncModelToCloud(", start);
  const fnSource = ts.transpileModule(companionSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  let localSaves = 0;
  let cloudSyncs = 0;
  const pack = { id: "local-1", assets: [], models: [{ id: "local-1:m.model3.json", name: "Witch", manifestPath: "m.model3.json" }] };
  const bindings = {
    requestAnimationFrame: (cb) => cb(),
    navigator: {},
    Error,
    CloudModelError: class CloudModelError extends Error {},
    CLOUD_TIER_REQUIRED_MESSAGE: tierPanel.CLOUD_TIER_REQUIRED_MESSAGE,
    isCloudLibraryAllowed: (lib) => Boolean(lib && lib.cloudAllowed !== false && lib.tier !== "free"),
    cloudLibrary: { userId: "u1", tier: "free", cloudAllowed: false, models: [], usage: null },
    accountRef: { current: { tier: "free", capabilities: { canUseCloudModels: false } } },
    modelImporting: false,
    modelPaused: false,
    stopBackgroundPreload() {},
    startupModelResolvedRef: { current: false },
    setStartupModelPending() {},
    setModelImporting() {},
    setModelImportProgress() {},
    setModelPaused() {},
    setModelNotice() {},
    importModelFiles: async () => pack,
    saveModelPackage: async () => { localSaves += 1; },
    modelCatalogEntry: (p) => p,
    setModelPackages() {},
    setActiveModelId() {},
    syncModelToCloud: async () => { cloudSyncs += 1; },
  };
  const importModels = new Function(...Object.keys(bindings), `${fnSource}\nreturn importModels;`)(...Object.values(bindings));
  await importModels([new File(["zip"], "witch.zip")]);
  assert.equal(localSaves, 1);
  assert.equal(cloudSyncs, 0);
});

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

test("StorageStatusPanel renders Free gate, Selected 512 MB personal meter, and Sorachan full view cleanly", () => {
  const storageMod = loadTsxWithMocks("../app/components/storage-status.tsx", {
    react: {
      useCallback: (fn) => fn,
      useEffect: () => {},
      useRef: (v) => ({ current: v }),
      useState: (init) => [init, () => {}],
    },
    "@/lib/auth/fetch": { authFetch: async () => Response.json({}) },
    "@/lib/storage-status": load("../lib/storage-status.ts"),
    "@/lib/cloud-storage": load("../lib/cloud-storage.ts", {}, { TextDecoder }),
    "@/app/components/tier-panel": tierPanel,
  });

  const freeTree = storageMod.StorageStatusPanel({
    account: {
      user: { id: "u1", email: "free@example.com" },
      tier: "free",
      capabilities: { tier: "free", dailyChatLimit: 5, canUseCloudModels: false, canUseCloudScenes: false, canViewSharedModels: false, personalStorageLimitBytes: 0, isAdmin: false },
      chatQuota: { allowed: true, tier: "free", used: 0, limit: 5, remaining: 5, usageDate: "2026-11-23", resetAt: "2026-11-23T17:00:00.000Z" },
      storage: { usedBytes: 0, limitBytes: 0 },
      selectedRequest: null,
      mailtoUrl: "mailto:viviannextlabs@gmail.com",
      requestEmail: "viviannextlabs@gmail.com",
    },
    onRequestSelected: () => {},
  });
  const freeText = collectText(freeTree);
  assert.match(freeText, /ต้องเป็น Selected tier ขึ้นไปจึงจะใช้ Cloud R2 ได้ \(นำเข้าแบบ local บนเครื่องได้ปกติ\)/);
  assert.match(freeText, /Request Selected Tier/);

  const selectedTree = storageMod.StorageStatusPanel({
    account: {
      user: { id: "u2", email: "sel@example.com" },
      tier: "selected",
      capabilities: { tier: "selected", dailyChatLimit: 20, canUseCloudModels: true, canUseCloudScenes: true, canViewSharedModels: false, personalStorageLimitBytes: 512 * 1024 * 1024, isAdmin: false },
      chatQuota: { allowed: true, tier: "selected", used: 2, limit: 20, remaining: 18, usageDate: "2026-11-23", resetAt: "2026-11-23T17:00:00.000Z" },
      storage: { usedBytes: 128 * 1024 * 1024, limitBytes: 512 * 1024 * 1024 },
      selectedRequest: null,
      mailtoUrl: "mailto:viviannextlabs@gmail.com",
      requestEmail: "viviannextlabs@gmail.com",
    },
  });
  const selectedText = collectText(selectedTree);
  assert.match(selectedText, /Personal Cloud R2/);
  assert.match(selectedText, /128\.0 MB \/ 512 MB/);
  assert.doesNotMatch(selectedText, /8 GB|Sorachan|shared/i);
});

test("SceneManager hides upload when cloudAllowed is false and shows Thai tier gate + upgrade button", () => {
  const sceneMod = loadTsxWithMocks("../app/components/scene-manager.tsx", {
    react: {
      useEffect: () => {},
      useRef: (v) => ({ current: v }),
      useState: (init) => [init, () => {}],
    },
    "@/components/ui/smoothui/animated-file-upload": () => null,
    "@/lib/auth/fetch": { authFetch: async () => Response.json({}) },
    "@/lib/scenes": load("../lib/scenes.ts"),
    "@/lib/use-scene-library": { SceneRequestError: class extends Error {}, sceneRequest: async () => ({}) },
    "@/app/components/tier-panel": tierPanel,
  });

  const gatedTree = sceneMod.SceneManager({
    library: { scenes: [], preferences: { autoScene: false, activeSceneId: null, preset: "day", revision: "" }, ready: true, busy: false, notice: null },
    cloudAllowed: false,
    onRequestSelected: () => {},
  });
  const gatedText = collectText(gatedTree);
  assert.match(gatedText, /ต้องเป็น Selected tier ขึ้นไปจึงจะใช้ Cloud R2 ได้ \(นำเข้าแบบ local บนเครื่องได้ปกติ\)/);
  assert.match(gatedText, /Request Selected Tier/);
});

test("UI pages & components remove invite-only copy, preserve local models, and gate admin/mailto correctly", () => {
  const accessDenied = readFileSync(new URL("../app/access-denied/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(accessDenied, /ยังไม่ได้รับเชิญ/);
  assert.doesNotMatch(accessDenied, /เลือกบัญชี Google อื่น/);

  const loginPage = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  assert.match(loginPage, /session_expired/);
  assert.match(loginPage, /clearAuthToken\(\)/);

  const companion = readFileSync(new URL("../app/companion.tsx", import.meta.url), "utf8");
  assert.match(companion, /authFetch\("\/api\/account"/);
  assert.match(companion, /!pack\.cloudOwner \|\| pack\.cloudOwner === accountId \|\| pack\.cloudOwner === "shared"/);
  assert.match(companion, /account\?\.tier === "sorachan" && account\?\.capabilities\?\.isAdmin && \(\s*<SorachanAdminPanel/);

  const tierPanelSource = readFileSync(new URL("../app/components/tier-panel.tsx", import.meta.url), "utf8");
  assert.match(tierPanelSource, /viviannextlabs@gmail\.com/);
  assert.match(tierPanelSource, /mailto:/);
  assert.match(tierPanelSource, /\/api\/tier-requests/);
  assert.match(tierPanelSource, /\/api\/admin\/tier-requests/);
});
