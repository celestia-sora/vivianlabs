# Embedding provider — deferred (decision D4)

Status: **deferred to the Phase 1 eval**. Phase 2 ships keyword+recency
retrieval only. No provider is picked yet; this document records the
choice process so it is not re-litigated per PR.

## Verified facts (read-only)

- **pgvector is NOT installed on prod.** Verified via Supabase CLI
  read-only on project `ai-waifu` (`frqixaqknuyerovnrndq`): available
  extensions are `pg_stat_statements`, `pgcrypto`, `plpgsql`,
  `supabase_vault`, `uuid-ossp`. There is no `vector` extension.
- Therefore `20261201000000_memory_v2.sql` does **not** enable the
  extension. `memories.embedding` is created as an inert
  `double precision[]` placeholder; `embedding_model` stores the model
  name per row once a provider is chosen.
- Groq embedding availability was not verifiable from code alone at audit
  time (Open item 1 in `docs/memory-persona-audit.md`). The provider
  check must call `GET /openai/v1/models` + read current Groq docs
  during Phase 1 before any pick.

## Choice process (when the eval runs)

1. Check whether Groq currently offers a production embedding model
   (`GET /openai/v1/models` + Groq docs). Sources disagree; verify, do
   not assume.
2. If not, candidates are Gemini embeddings (project already has optional
   `GEMINI_API_KEY`) or another affordable provider.
3. Score against the Phase 1 retrieval cases (Thai quality, recall@k,
   latency per turn, quota fit for 2 users, API stability).
4. Record the pick here: provider, model name, vector dimension
   (`MEMORY_EMBEDDING_DIM`), eval comparison table.
5. Follow-up migration: `create extension vector`, switch the column to
   `vector(dim)`, add an HNSW/IVF index, ship idempotent
   `scripts/reembed-memories.ts`.

Until then: `MEMORY_V2_EMBEDDINGS` stays OFF, consolidation counts stale
embeddings but writes nothing, retrieval never calls an embedding API.
