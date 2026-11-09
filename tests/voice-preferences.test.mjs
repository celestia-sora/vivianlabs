import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as values from "../lib/voice-preferences.ts";
const source = ts.transpileModule(readFileSync(new URL("../app/api/voice/preferences/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
let stored;
// Allowed column sets the route may request from the mock DB.
const VALID_COLUMNS = [
  "voice_id,speech_language,speaking_speed",
  "speech_language,speaking_speed",
];
function handler(denied = null, unavailable = false, legacyNoVoiceId = false) {
  const exports = {};
  runInNewContext(source, { exports, Response, Error, Date, AbortSignal, process: { env: {} }, require(name) {
    if (name === "@/lib/auth/server") return { requireApiAccess: async () => denied };
    if (name === "@/lib/voice-preferences") return values;
    if (name === "@/lib/supabase-admin") return { getSupabaseAdmin() {
      if (unavailable) throw new Error();
      return { from(table) {
        assert.equal(table, "vivian_voice_preferences");
        let candidate;
        let selected;
        const query = {
          upsert(row, options) {
            assert.equal(row.id, "global");
            assert.equal(options.onConflict, "id");
            candidate = { ...stored, ...row };
            return query;
          },
          select(columns) {
            assert.ok(VALID_COLUMNS.includes(columns), `Unexpected columns: ${columns}`);
            selected = columns;
            return query;
          },
          eq(column, key) { assert.equal(column, "id"); assert.equal(key, "global"); return query; },
          async single() {
            if (legacyNoVoiceId && selected.includes("voice_id")) {
              return { data: null, error: { message: "column vivian_voice_preferences.voice_id does not exist" } };
            }
            stored = candidate;
            return { data: stored, error: null };
          },
          async maybeSingle() {
            if (legacyNoVoiceId && selected.includes("voice_id")) {
              return { data: null, error: { message: "column vivian_voice_preferences.voice_id does not exist" } };
            }
            return { data: stored ?? null, error: null };
          },
        }; return query;
      } };
    } };
    throw new Error(name);
  } });
  return exports;
}
const request = value => new Request("https://vivian.example/api/voice/preferences", { method: "PATCH", body: JSON.stringify(value) });

test("voiceId is saved globally and returned on subsequent GET", async () => {
  stored = undefined;
  const defaults = await (await handler().GET(new Request("https://vivian.example"))).json();
  assert.equal(defaults.voiceId, "");          // DEFAULT_VOICE_ID is ""
  const saved = await handler().PATCH(request({ voiceId: "abc123XYZ" }));
  assert.equal(saved.status, 200);
  const data = await saved.json();
  assert.equal(data.voiceId, "abc123XYZ");
  const loaded = await (await handler().GET(new Request("https://vivian.example"))).json();
  assert.equal(loaded.voiceId, "abc123XYZ");
  assert.equal(loaded.speechLanguage, "th");   // default
});

test("speech language is shared globally and survives an account switch", async () => {
  stored = undefined;
  const defaults = await (await handler().GET(new Request("https://vivian.example"))).json();
  assert.equal(defaults.speechLanguage, "th");
  const saved = await handler().PATCH(request({ speechLanguage: "en" }));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).speechLanguage, "en");
  const other = await (await handler().GET(new Request("https://vivian.example"))).json();
  assert.equal(other.speechLanguage, "en");
});

test("voiceId and speechLanguage can be written together", async () => {
  stored = undefined;
  const saved = await handler().PATCH(request({ voiceId: "myVoice99", speechLanguage: "ja" }));
  const data = await saved.json();
  assert.equal(data.voiceId, "myVoice99");
  assert.equal(data.speechLanguage, "ja");
});

test("voiceId is trimmed before saving", async () => {
  stored = undefined;
  await handler().PATCH(request({ voiceId: "  spaced  " }));
  const loaded = await (await handler().GET(new Request("https://vivian.example"))).json();
  assert.equal(loaded.voiceId, "spaced");
});

test("invalid body cannot overwrite the global value", async () => {
  stored = { voice_id: "keepMe", speech_language: "en", speaking_speed: 1.0 };
  for (const body of [
    { speechLanguage: "fr" }, { speechLanguage: "EN" }, { speechLanguage: null, voiceId: 42 },
  ]) {
    assert.equal((await handler().PATCH(request(body))).status, 400);
  }
  assert.equal(stored.voice_id, "keepMe");
  assert.equal(stored.speech_language, "en");
});

test("before the voice_id migration runs, language still saves and voiceId falls back to env", async () => {
  stored = { speech_language: "th", speaking_speed: 0.98 };
  const read = await (await handler(null, false, true).GET(new Request("https://vivian.example"))).json();
  // voiceId falls back to env (empty in test) gracefully
  assert.equal(typeof read.voiceId, "string");
  assert.equal(read.speechLanguage, "th");
  const saved = await (await handler(null, false, true).PATCH(request({ voiceId: "v1", speechLanguage: "ko" }))).json();
  // voiceId cannot be persisted yet, falls back gracefully
  assert.equal(typeof saved.voiceId, "string");
  // language is still saved when possible (speech_language col exists)
  assert.equal(saved.speechLanguage, "ko");
});

test("unauthorized callers cannot read or write; cloud failure returns 503", async () => {
  const denied = Response.json({}, { status: 403 });
  assert.equal(await handler(denied, true).PATCH(request({ voiceId: "x" })), denied);
  assert.equal(await handler(denied, true).GET(new Request("https://vivian.example")), denied);
  assert.equal((await handler(null, true).PATCH(request({ voiceId: "x" }))).status, 503);
});
