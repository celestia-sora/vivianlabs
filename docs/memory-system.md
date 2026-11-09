# Vivian Memory System (Phase 2)

Data model, pipelines, flags and tuning knobs for Phase 2 Memory v2.
Behavior ships behind flags that default OFF; with all flags off the
runtime is byte-identical to pre-Phase 2.

## Flags

| Flag | Default | Effect |
|---|---|---|
| `MEMORY_V2_EXTRACTION` | OFF | Strict JSON schema extraction + secret pre-filter + v2 write path (dedupe/supersede) |
| `MEMORY_V2_RETRIEVAL` | OFF | Scored keyword+recency retrieval with hard budgets |
| `MEMORY_CONSOLIDATION` | OFF | On-demand consolidation (server N-message trigger + `POST /api/memory/consolidate`) |
| `MEMORY_V2_GATE` | OFF | Replace `memoryIntent` regex gate with always-consider + cheap prefilter |
| `MEMORY_V2_EMBEDDINGS` | OFF | Embedding stub; stays OFF until the D4 eval (see `docs/memory-embeddings.md`) |

Tuning: `MEMORY_RETRIEVAL_BUDGET_CHARS` (800), `MEMORY_CORE_BUDGET_CHARS`
(200), `MEMORY_CONSOLIDATION_N` (20), `MEMORY_EMBEDDING_DIM` (768),
`MEMORY_EMBEDDING_MODEL`.

## Schema (additive)

`20261201000000_memory_v2.sql` adds to `memories`: `type` (fact |
preference | episode | relationship | mood), `importance_01` (0..1,
backfilled `(importance-1)/4` from legacy 1..5, synced by trigger),
`last_accessed_at`, `access_count`, `source_message_ids`, `superseded_by`
(bigint FK, same type as `memories.id`), inert `embedding` (float array;
pgvector not installed on prod — see `docs/memory-embeddings.md`),
`embedding_model`; plus `memory_consolidation_runs` lease table. RLS
stays enabled, no public policies. Rollback: drop the added columns /
table (see migration header). `created_at` already existed.

Deviations from plan §8.1: `superseded_by` is `bigint` (matches
`memories.id`), not `uuid`; inert embedding column instead of `vector`.

## Pipelines

- **Extraction (after-reply, `after()`, non-blocking):** Groq
  GPT-OSS 20B (D1, `GROQ_MEMORY_MODEL`), strict schema
  (`response_format json_schema strict:true`), retry once on 400 /
  malformed, timeout skips the turn and bumps `extraction_failures`.
  Deterministic secret pre-filter (`isSecretLike`, Thai + English)
  blocks storage even when the model proposes it. Reasoning fields are
  never read, stored or logged. Compression uses strict schema too.
- **Write:** exact/near-dupe (same type, similarity ≥ 0.85) bumps
  importance (+0.05 capped at 1), `last_accessed_at`, merges
  `source_message_ids`, bumps `access_count`. Contradiction (overlap ≥
  0.4 + opposite polarity, cheap polarity rules) inserts and sets
  `superseded_by` on the old row. Otherwise insert. Embedding writes
  are stubbed behind `MEMORY_V2_EMBEDDINGS`.
- **Retrieval (reply path):** `score = 0.60*keyword-similarity +
  0.25*recency + 0.15*importance01`. Similarity is token Jaccard +
  Thai bigram overlap until embeddings exist. Core set
  (relationship/preference with importance01 ≥ 0.75) is protected by
  `MEMORY_CORE_BUDGET_CHARS`; total cap `MEMORY_RETRIEVAL_BUDGET_CHARS`;
  lowest scores dropped first. Superseded rows and expired moods (7d
  TTL) are excluded. Injected ids bump `last_accessed_at` /
  `access_count` in background (plus legacy `last_used_at` /
  `use_count` for old readers). Memory content is never sent to JEV.
- **Consolidation (on demand, D3):** server after every N new messages
  (`MEMORY_CONSOLIDATION_N=20`) via `after()`; client idle-triggered
  `POST /api/memory/consolidate` (503 when flag off, 409 when a lease
  is held). Single-flight lease in `memory_consolidation_runs`
  (5-minute expiry). Idempotent steps with hard caps (50 items/run,
  5 model calls): merge near-dupes, resolve contradictions, roll
  episodes, decay importance (lower only, floor 0.1), supersede expired
  moods (never hard-delete), count stale embeddings (re-embed stubbed).
  Failed runs record `status=failed` and stats, change nothing visible.
- **Observability:** NDJSON `retrieve` timing entries (ids/counts
  only, never content); counters for extraction failures, schema
  rejections, secret-filter hits, retrieval fallback, dedupe/supersede
  hits, consolidation runs/failures.

## Types and mood

`fact` stable facts, `preference` likes/dislikes, `episode` notable
events rolled up over time, `relationship` shared moments/boundaries,
`mood` short-lived (excluded from long-term retrieval after 7 days).
Existing `companion_state` mood/relationship storage is untouched;
explicit update rules are Phase 3 (§9.2).

## Reset

`resetCompanionData` clears `memories` (all v2 columns incl. embeddings
and `superseded_by`), `conversations`, `messages`, `companion_state`,
and `memory_consolidation_runs`. The custom-instructions step is
unchanged in Phase 2 — D7 preservation is Phase 3's change.

## Tests

- `npm run test:memory` — offline unit tests (prefilter, schema,
  scoring, budgets, dedupe, supersede, lease, decay; Thai throughout).
- `node --test tests/memory-v2.postgres.test.mjs` — disposable local
  Postgres container, additive-only + RLS + reset-clearing checks.
  Never against production Supabase.

## Failure drills (considered, soft-fail everywhere)

- Embedding provider down: flag off → keyword+recency path untouched.
- Groq 429/timeout on extraction: turn skipped, counter bumped, chat
  reply already returned; no pile-up retries (one retry max on
  malformed/400 only).
- Supabase slow: 2s timeout, empty retrieval falls back gracefully.
- Consolidation mid-run crash: lease expires in 5 min, next run resumes;
  failed run changes nothing visible.
- Strict-schema 400: retry once without streaming, then skip.
