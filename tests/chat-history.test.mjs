import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { loadSceneModule as load } from "./scene-module-loader.mjs";
const history = load("../lib/chat-history.ts", {}, { crypto: webcrypto });
const store = load("../lib/chat-history-store.ts", { "@/lib/chat-history": history });
const id = "00000000-0000-4000-8000-000000000001";
const msg = history.historyMessage("me", "hello");
test("legacy device conversations receive stable UUIDs before migration and remain recoverable", () => {
  const migrated = history.normalizeHistory([{ id: "daily-talk", title: "Old", updatedAt: 1000, messages: [{ from: "me", text: "remembered" }] }]);
  assert.ok(history.historyUuid(migrated[0].id)); assert.ok(history.historyUuid(migrated[0].messages[0].id));
  assert.deepEqual(JSON.parse(JSON.stringify(history.normalizeHistory(JSON.parse(JSON.stringify(migrated))))), JSON.parse(JSON.stringify(migrated)));
  assert.deepEqual(Array.from(history.normalizeHistory(null)), []);
});
test("cloud merge keeps independent device additions and server text wins for an existing ID", () => {
  const local = { id, title: "Local", updatedAt: 1000, messages: [msg, history.historyMessage("vivian", "unsynced")] };
  const remote = { id, title: "Cloud", updatedAt: 2000, messages: [{ ...msg, text: "server", synced: true }, history.historyMessage("vivian", "another device")] };
  const merged = history.mergeHistory([remote], [local])[0];
  assert.equal(merged.messages.length, 3); assert.equal(merged.messages.find((item) => item.id === msg.id).text, "server");
  assert.equal(merged.title, "Cloud");
});
test("write validation rejects forged roles, unstable IDs, duplicate IDs and excessive content", () => {
  const valid = { id, title: "Title", messages: [msg], create: true };
  assert.equal(store.validateHistoryWrite(valid).id, id);
  for (const body of [null, { ...valid, id: "daily-talk" }, { ...valid, create: undefined }, { ...valid, messages: [{ ...msg, from: "system" }] }, { ...valid, messages: [msg, msg] }, { ...valid, messages: [{ ...msg, text: "a".repeat(16001) }] }, { ...valid, messages: [{ ...msg, timestamp: "invalid" }] }]) assert.throws(() => store.validateHistoryWrite(body));
});
test("chat history store scopes save, list, read, and delete by userKey", async () => {
  const conversations = [];
  const messages = [];
  const db = {
    async rpc(name, args) {
      assert.equal(name, "vivian_save_conversation");
      const existing = conversations.find((c) => c.id === args.p_id);
      if (!existing) {
        if (!args.p_create) return { error: { code: "P0002" } };
        conversations.push({ id: args.p_id, user_key: args.p_user_key, title: args.p_title, updated_at: "2026-11-23T00:00:00Z" });
      } else if (existing.user_key !== args.p_user_key) {
        return { error: { code: "42501" } };
      }
      for (const m of args.p_messages) {
        messages.push({ id: messages.length + 1, conversation_id: args.p_id, client_message_id: m.id, role: m.role, content: m.content, created_at: m.created_at });
      }
      return { error: null };
    },
    from(table) {
      const filters = [];
      let action = "select";
      let single = false;
      const q = {
        select() { return q; },
        delete() { action = "delete"; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        gt(k, v) { filters.push((r) => Number(r[k]) > Number(v)); return q; },
        order() { return q; },
        range() { return q; },
        limit() { return q; },
        maybeSingle() { single = true; return q; },
        then(resolve, reject) {
          const list = table === "conversations" ? conversations : messages;
          const matched = list.filter((r) => filters.every((f) => f(r)));
          if (action === "delete") {
            for (const row of matched) list.splice(list.indexOf(row), 1);
            return Promise.resolve({ error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: single ? matched[0] ?? null : matched, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };

  await store.saveHistory(db, { id, title: "User A Chat", messages: [msg], create: true }, "user-a");
  assert.equal((await store.listHistory(db, 0, "user-a")).conversations.length, 1);
  assert.equal((await store.listHistory(db, 0, "user-b")).conversations.length, 0);
  await assert.rejects(() => store.readHistory(db, id, "0", "user-b"), (err) => err.status === 404);
  await assert.rejects(() => store.saveHistory(db, { id, title: "Hijack", messages: [msg], create: true }, "user-b"), (err) => err.status === 404);
  await store.deleteHistory(db, id, "user-b");
  assert.equal(conversations.length, 1);
  await store.deleteHistory(db, id, "user-a");
  assert.equal(conversations.length, 0);
});
test("cloud loader follows conversation and message cursors past the first page", async () => {
  const calls = [];
  const client = load("../lib/chat-history-client.ts", { "@/lib/auth/fetch": { authFetch: async (url) => {
    calls.push(url);
    if (url.includes("offset=0")) return Response.json({ conversations: [{ id, title: "Title", updatedAt: 1000, messages: [] }], nextOffset: 50 });
    if (url.includes("offset=50")) return Response.json({ conversations: [], nextOffset: null });
    if (url.includes("after=0")) return Response.json({ messages: Array.from({ length: 100 }, (_, index) => ({ ...msg, id: `${index}` })), nextCursor: "100" });
    return Response.json({ messages: [{ ...msg, timestamp: "2000-01-01T00:00:00.000Z" }], nextCursor: null });
  } } });
  const result = await client.fetchHistory(); assert.equal(result[0].messages.length, 101);
  assert.equal(result[0].messages[0].timestamp, "2000-01-01T00:00:00.000Z");
  assert.equal(result[0].cloud, true); assert.equal(result[0].messages[0].synced, true); assert.equal(calls.length, 4);
});
test("unavailable cloud data and failed writes throw instead of claiming successful sync", async () => {
  const client = load("../lib/chat-history-client.ts", { "@/lib/auth/fetch": { authFetch: async () => Response.json({ error: "Unavailable" }, { status: 503 }) } });
  await assert.rejects(client.fetchHistory(), /Unavailable/);
  await assert.rejects(client.appendHistory({ id, title: "Title" }, [msg], true), /Unavailable/);
});
test("history route rejects signed-out requests before body parsing or database access and scopes calls by user.id", async () => {
  const denied = Response.json({ code: "AUTH_REQUIRED" }, { status: 401 });
  const route = load("../app/api/conversations/route.ts", {
    "@/lib/auth/server": { requireAuthorizedUser: async () => ({ user: null, denied }) },
    "@/lib/supabase-admin": { getSupabaseAdmin: () => assert.fail("No DB access") },
    "@/lib/chat-history-store": store,
    "@/lib/scenes": load("../lib/scenes.ts"),
    "@/lib/scene-images": { readBoundedSceneBody: () => assert.fail("No body read") },
    "@/lib/rate-limit": { rateLimit: () => assert.fail("No work before auth") },
  });
  assert.equal(await route.GET(new Request("https://vivian.example/api/conversations")), denied);
  assert.equal(await route.PUT(new Request("https://vivian.example/api/conversations", { method: "PUT", body: "invalid" })), denied);

  const seenUserIds = [];
  let activeUser = { id: "user-a", email: "a@example.com" };
  const scopedRoute = load("../app/api/conversations/route.ts", {
    "@/lib/auth/server": { requireAuthorizedUser: async () => ({ user: activeUser, denied: null }) },
    "@/lib/supabase-admin": { getSupabaseAdmin: () => ({}) },
    "@/lib/chat-history-store": {
      ...store,
      listHistory: async (_db, _offset, userKey) => { seenUserIds.push(["list", userKey]); return { conversations: [], nextOffset: null }; },
      readHistory: async (_db, _id, _after, userKey) => { seenUserIds.push(["read", userKey]); return { messages: [], nextCursor: null }; },
      saveHistory: async (_db, _input, userKey) => { seenUserIds.push(["save", userKey]); },
      deleteHistory: async (_db, _id, userKey) => { seenUserIds.push(["delete", userKey]); },
    },
    "@/lib/scenes": load("../lib/scenes.ts"),
    "@/lib/scene-images": { readBoundedSceneBody: async (req) => Buffer.from(await req.text()) },
    "@/lib/rate-limit": { rateLimit: () => ({ allowed: true }) },
  });
  await scopedRoute.GET(new Request("https://vivian.example/api/conversations"));
  await scopedRoute.GET(new Request(`https://vivian.example/api/conversations?id=${id}`));
  activeUser = { id: "user-b", email: "b@example.com" };
  await scopedRoute.PUT(new Request("https://vivian.example/api/conversations", { method: "PUT", body: JSON.stringify({ id, title: "Title", messages: [msg], create: true }) }));
  await scopedRoute.DELETE(new Request(`https://vivian.example/api/conversations?id=${id}`, { method: "DELETE" }));
  assert.deepEqual(seenUserIds, [["list", "user-a"], ["read", "user-a"], ["save", "user-b"], ["delete", "user-b"]]);
});
