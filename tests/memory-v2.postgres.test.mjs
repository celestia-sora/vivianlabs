/** Disposable PostgreSQL only; never uses production Supabase credentials. */
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
const run = promisify(execFile);
const container = process.env.MEMORY_TEST_CONTAINER ?? "vivian-memory-postgres";
const runtime = process.env.MEMORY_TEST_RUNTIME ?? "podman";
const database = `vivian_memory_test_${process.pid}`;
async function sql(query, db = database) {
  const result = await run(runtime, ["exec", container, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-Atq", "-c", query]);
  return result.stdout.trim();
}
function migration(name) {
  return readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
}
before(async () => {
  await sql(`create database ${database}`, "postgres");
  await sql("create role anon; create role authenticated; create role service_role bypassrls;");
  await sql(migration("20260829000000_vivian_memory.sql"));
  await sql(migration("20260901000000_memory_engagement.sql"));
  await sql(migration("20261201000000_memory_v2.sql"));
});
after(async () => { await sql(`drop database if exists ${database} with (force)`, "postgres"); });

test("phase 2 migration is additive: legacy rows preserved and 0..1 backfilled (1->0, 3->0.5, 5->1)", async () => {
  await sql("insert into memories(user_key,memory,category,importance) values('default','ผู้ใช้ชอบชาไข่มุก','preference',4),('default','secret-row','general',1) returning id");
  assert.equal(await sql("select count(*) from memories where user_key='default'"), "2");
  assert.equal(await sql("select (importance_01)::text from memories where memory='ผู้ใช้ชอบชาไข่มุก'"), "0.75");
  assert.equal(await sql("select (importance_01)::text from memories where memory='secret-row'"), "0");
  assert.equal(await sql("select type from memories where memory='ผู้ใช้ชอบชาไข่มุก'"), "preference");
});

test("new v2 columns round-trip and importance stays in sync through the trigger", async () => {
  await sql(`insert into memories(user_key,memory,category,importance,type,importance_01,last_accessed_at,access_count,source_message_ids)
    values('default','ผู้ใช้ชอบกาแฟ','preference',3,'preference',0.5,now(),2,array['msg-1'])`);
  assert.equal(await sql("select access_count from memories where memory='ผู้ใช้ชอบกาแฟ'"), "2");
  assert.equal(await sql("select array_to_string(source_message_ids,',') from memories where memory='ผู้ใช้ชอบกาแฟ'"), "msg-1");
  await sql("update memories set importance_01=1 where memory='ผู้ใช้ชอบกาแฟ'");
  assert.equal(await sql("select importance from memories where memory='ผู้ใช้ชอบกาแฟ'"), "5");
});

test("superseded_by references memories and excludes from live set", async () => {
  assert.equal(await sql("select count(*) from pg_constraint where conname='memories_superseded_by_fkey'"), "1");
  await sql("update memories set superseded_by=(select id from memories where memory='ผู้ใช้ชอบกาแฟ') where memory='ผู้ใช้ชอบชาไข่มุก'");
  assert.equal(await sql("select count(*) from memories where superseded_by is null and user_key='default'"), "2");
});

test("embedding column is inert (no pgvector): float array + model tag, never required", async () => {
  assert.equal(await sql("select count(*) from pg_extension where extname='vector'"), "0");
  assert.equal(await sql("select data_type from information_schema.columns where table_name='memories' and column_name='embedding'"), "ARRAY");
  await sql("update memories set embedding=array[0.1,0.2,0.3], embedding_model='none' where memory='ผู้ใช้ชอบกาแฟ'");
  assert.equal(await sql("select embedding_model from memories where memory='ผู้ใช้ชอบกาแฟ'"), "none");
});

test("memory_consolidation_runs lease table is service-only and single-flight friendly", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(sql(`set role ${role}; select * from memory_consolidation_runs`));
  }
  assert.equal(await sql("select bool_and(relrowsecurity) from pg_class where relname='memory_consolidation_runs'"), "t");
  await sql("set role service_role; insert into memory_consolidation_runs(status,stats) values('running','{}'::jsonb)");
  assert.equal(await sql("select status from memory_consolidation_runs limit 1"), "running");
});

test("reset-style clearing empties memories embeddings and consolidation runs", async () => {
  await sql("delete from memories where user_key='default'");
  await sql("delete from memory_consolidation_runs");
  assert.equal(await sql("select count(*) from memories where user_key='default'"), "0");
  assert.equal(await sql("select count(*) from memory_consolidation_runs"), "0");
});
