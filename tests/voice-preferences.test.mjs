import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as values from "../lib/voice-preferences.ts";
import { loadSceneModule as load } from "./scene-module-loader.mjs";

const source = ts.transpileModule(readFileSync(new URL("../app/api/voice/preferences/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

let storedByUser = new Map();
const VALID_COLUMNS = [
  "voice_id,speech_language,speaking_speed",
  "speech_language,speaking_speed",
];

function createDb({ unavailable = false, legacyNoVoiceId = false } = {}) {
  if (unavailable) throw new Error("DB unavailable");
  return {
    from(table) {
      assert.equal(table, "vivian_voice_preferences");
      let candidate;
      let selected;
      let targetId;
      const query = {
        upsert(row, options) {
          assert.ok(typeof row.id === "string" && row.id.trim().length > 0 && row.id !== "global", `Expected per-user id, got ${row.id}`);
          assert.equal(options.onConflict, "id");
          targetId = row.id;
          candidate = { ...(storedByUser.get(row.id) ?? {}), ...row };
          return query;
        },
        select(columns) {
          assert.ok(VALID_COLUMNS.includes(columns), `Unexpected columns: ${columns}`);
          selected = columns;
          return query;
        },
        eq(column, key) {
          assert.equal(column, "id");
          assert.ok(typeof key === "string" && key.trim().length > 0 && key !== "global", `Expected per-user key, got ${key}`);
          targetId = key;
          return query;
        },
        async single() {
          if (legacyNoVoiceId && selected.includes("voice_id")) {
            return { data: null, error: { message: "column vivian_voice_preferences.voice_id does not exist" } };
          }
          storedByUser.set(targetId, candidate);
          return { data: storedByUser.get(targetId), error: null };
        },
        async maybeSingle() {
          if (legacyNoVoiceId && selected.includes("voice_id")) {
            return { data: null, error: { message: "column vivian_voice_preferences.voice_id does not exist" } };
          }
          return { data: storedByUser.get(targetId) ?? null, error: null };
        },
      };
      return query;
    },
  };
}

function handler({
  denied = null,
  unavailable = false,
  legacyNoVoiceId = false,
  user = { id: "user-voice-a", email: "a@example.com" },
} = {}) {
  const exports = {};
  const supabaseAdmin = { getSupabaseAdmin: () => createDb({ unavailable, legacyNoVoiceId }) };
  const elevenLabsVoice = load("../lib/elevenlabs-voice.ts", {
    "./supabase-admin.ts": supabaseAdmin,
  });

  runInNewContext(source, {
    exports,
    Response,
    Error,
    Date,
    AbortSignal,
    process: { env: {} },
    require(name) {
      if (name === "@/lib/auth/server") {
        return {
          requireAuthorizedUser: async () => (denied ? { user: null, denied } : { user, denied: null }),
        };
      }
      if (name === "@/lib/voice-preferences") return values;
      if (name === "@/lib/elevenlabs-voice") return elevenLabsVoice;
      if (name === "@/lib/supabase-admin") return supabaseAdmin;
      throw new Error(name);
    },
  });
  return exports;
}

const request = (value) =>
  new Request("https://vivian.example/api/voice/preferences", {
    method: "PATCH",
    body: JSON.stringify(value),
  });

test("voiceId and speechLanguage are isolated per user account", async () => {
  storedByUser = new Map();
  const userA = { id: "user-voice-a", email: "a@example.com" };
  const userB = { id: "user-voice-b", email: "b@example.com" };

  const defaultsA = await (await handler({ user: userA }).GET(new Request("https://vivian.example"))).json();
  assert.equal(defaultsA.voiceId, "");
  assert.equal(defaultsA.speechLanguage, "th");

  const savedA = await handler({ user: userA }).PATCH(request({ voiceId: "abc123XYZ", speechLanguage: "en" }));
  assert.equal(savedA.status, 200);
  const dataA = await savedA.json();
  assert.equal(dataA.voiceId, "abc123XYZ");
  assert.equal(dataA.speechLanguage, "en");

  // User B does not inherit User A's settings
  const loadedB = await (await handler({ user: userB }).GET(new Request("https://vivian.example"))).json();
  assert.equal(loadedB.voiceId, "");
  assert.equal(loadedB.speechLanguage, "th");

  await handler({ user: userB }).PATCH(request({ voiceId: "voiceB99", speechLanguage: "ja" }));
  const reloadedA = await (await handler({ user: userA }).GET(new Request("https://vivian.example"))).json();
  assert.equal(reloadedA.voiceId, "abc123XYZ");
  assert.equal(reloadedA.speechLanguage, "en");
});

test("voiceId and speechLanguage can be written together and voiceId is trimmed", async () => {
  storedByUser = new Map();
  const saved = await handler().PATCH(request({ voiceId: "  myVoice99  ", speechLanguage: "ja" }));
  const data = await saved.json();
  assert.equal(data.voiceId, "myVoice99");
  assert.equal(data.speechLanguage, "ja");
});

test("invalid body cannot overwrite the user's saved value", async () => {
  storedByUser = new Map([["user-voice-a", { id: "user-voice-a", voice_id: "keepMe", speech_language: "en", speaking_speed: 1.0 }]]);
  for (const body of [
    { speechLanguage: "fr" },
    { speechLanguage: "EN" },
    { speechLanguage: null, voiceId: 42 },
  ]) {
    assert.equal((await handler().PATCH(request(body))).status, 400);
  }
  assert.equal(storedByUser.get("user-voice-a").voice_id, "keepMe");
  assert.equal(storedByUser.get("user-voice-a").speech_language, "en");
});

test("before the voice_id migration runs, language still saves and voiceId falls back to env", async () => {
  storedByUser = new Map([["user-voice-a", { id: "user-voice-a", speech_language: "th", speaking_speed: 0.98 }]]);
  const read = await (await handler({ legacyNoVoiceId: true }).GET(new Request("https://vivian.example"))).json();
  assert.equal(typeof read.voiceId, "string");
  assert.equal(read.speechLanguage, "th");
  const saved = await (await handler({ legacyNoVoiceId: true }).PATCH(request({ voiceId: "v1", speechLanguage: "ko" }))).json();
  assert.equal(typeof saved.voiceId, "string");
  assert.equal(saved.speechLanguage, "ko");
});

test("unauthorized callers cannot read or write; cloud failure returns 503", async () => {
  const denied = Response.json({}, { status: 403 });
  assert.equal(await handler({ denied, unavailable: true }).PATCH(request({ voiceId: "x" })), denied);
  assert.equal(await handler({ denied, unavailable: true }).GET(new Request("https://vivian.example")), denied);
  assert.equal((await handler({ unavailable: true }).PATCH(request({ voiceId: "x" }))).status, 503);
});
