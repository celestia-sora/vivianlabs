import assert from "node:assert/strict";
import test from "node:test";
import { resetCompanionData } from "../lib/reset-companion.ts";

function fixture(failDelete = null, ignoreDelete = null) {
  const rows = {
    conversations: [{ id: "a", user_key: "default" }, { id: "b", user_key: "other" }],
    messages: [{ conversation_id: "a" }, { conversation_id: "b" }],
    memories: [{ user_key: "default" }, { user_key: "other" }],
    companion_state: [{ user_key: "default", conversation_summary: "old" }, { user_key: "other" }],
    vivian_custom_instructions: [{ id: "global", instructions: "call me Sora" }],
    custom_instruction_versions: [{ id: 1, instructions: "call me Sora" }],
    memory_consolidation_runs: [{ id: "run-1", status: "done" }, { id: "run-2", status: "done" }],
  };
  const client = { from(table) {
    let deleting = false;
    let counting = false;
    let predicate = () => false;
    const query = {
      select(_columns, options) { counting = Boolean(options?.head); return query; },
      delete() { deleting = true; return query; },
      eq(key, value) { predicate = row => row[key] === value; return query; },
      in(key, values) { predicate = row => values.includes(row[key]); return query; },
      not(key, _op, value) { predicate = row => row[key] !== value; return query; },
      then(resolve, reject) {
        if (deleting && table === failDelete) return Promise.resolve({ error: new Error("simulated failure") }).then(resolve, reject);
        const selected = rows[table].filter(predicate);
        if (deleting && table !== ignoreDelete) rows[table] = rows[table].filter(row => !predicate(row));
        return Promise.resolve({ data: deleting || counting ? null : selected, count: counting ? selected.length : null, error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
  client.recover = () => { failDelete = null; };
  return { client, rows };
}

test("full reset removes the requested identity's history, memory, and relationship — but KEEPS custom instructions (D7)", async () => {
  const { client, rows } = fixture();
  await resetCompanionData(client, "default");
  assert.deepEqual(rows.messages, [{ conversation_id: "b" }]);
  for (const name of ["conversations", "memories", "companion_state"]) {
    assert.equal(rows[name].length, 1);
    assert.equal(rows[name][0].user_key, "other");
  }
  // D7: persona persists across Reset.
  assert.deepEqual(rows.vivian_custom_instructions, [{ id: "global", instructions: "call me Sora" }]);
  assert.deepEqual(rows.custom_instruction_versions, [{ id: 1, instructions: "call me Sora" }]);
  // Phase 2: consolidation runs are cleared (plan §4.8).
  assert.equal(rows.memory_consolidation_runs.length, 0);
  await resetCompanionData(client, "default");
  assert.equal(rows.messages.length, 1);
  assert.equal(rows.vivian_custom_instructions.length, 1);
});

test("an upstream failure is reported and a retry finishes the remaining reset", async () => {
  const { client, rows } = fixture("memories");
  await assert.rejects(resetCompanionData(client, "default"), /simulated failure/);
  assert.ok(rows.memories.some(row => row.user_key === "default"));
  assert.ok(rows.companion_state.some(row => row.user_key === "default"));
  client.recover();
  await resetCompanionData(client, "default");
  assert.equal(rows.memories.length, 1);
  assert.equal(rows.companion_state.length, 1);
  assert.equal(rows.vivian_custom_instructions.length, 1);
});

test("reset refuses an unspecified identity", async () => {
  const { client, rows } = fixture();
  await assert.rejects(resetCompanionData(client, ""), /identity/);
  assert.equal(rows.memories.length, 2);
});

test("an incomplete deletion cannot be reported as a successful reset", async () => {
  const { client } = fixture(null, "memories");
  await assert.rejects(resetCompanionData(client, "default"), /verified/);
});

test("phase 2: reset clears consolidation runs while KEEPING custom instructions (D7)", async () => {
  const { client, rows } = fixture();
  await resetCompanionData(client, "default");
  assert.equal(rows.memory_consolidation_runs.length, 0);
  // D7 (Phase 3) is correct: Reset preserves the persona profile.
  assert.equal(rows.vivian_custom_instructions.length, 1);
});
