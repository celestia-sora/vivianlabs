# Vivian Memory & Persona — Phase 0 Audit

Source-of-truth audit grounded in code, not README/AGENTS.md. Repo: `https://github.com/celestia-sora/vivianlabs.git` (remote `origin`).
Plan version: 2026-11-08 (`vivian-memory-persona-plan`).
Line numbers as of `main` @ `bf19f51` (Nov 2026). No behavior changed in this phase — read-only audit.

---

## 1. Memory extraction, compression, retrieval — where, prompts, models, budgets

| Concern | File:line | Details |
|---|---|---|
| Extraction helper | `app/api/chat/route.ts:121-136` `extractMemories` | Guard `userText.length < 12 → []` (`:122`). Model `groqMemoryModelName()` (`:32`, default `openai/gpt-oss-20b` via `GROQ_MEMORY_MODEL`). Budget `maxTokens: 280` (`:127`). Returns ≤2 items, ≤500 chars each, categories limited to `preference|profile|project|relationship` (`:130-132`). |
| Extraction prompt | `app/api/chat/route.ts:125` | "Extract only durable user facts… Never save secrets, passwords, API keys, one-time requests, precise location, health, financial… Return strict JSON only: `{memories:[{memory, category, importance 1-5}]}`… Maximum 2 memories." |
| Compression helper | `app/api/chat/route.ts:139-153` `compressTurns` | Guard `older.length < 4 → previous` (`:140`). Transcript 400 chars/msg, capped 7,000 (`:141`). Model same `groqMemoryModelName()`, `maxTokens: 500` (`:146`). Output sliced to 900 (`:151`), stored via `lib/companion-store.ts:51` sliced to 1,800. |
| Compression prompt | `app/api/chat/route.ts:144` | "Summarize… into compact Thai context… Keep names, preferences, unresolved topics, relationship tone. Ignore secrets. Return JSON only: `{summary}` maximum 700 characters." Previous summary prepended (`:145`) → rolling. |
| Retrieval (pre-reply) | `app/api/chat/route.ts:346-363` | `supabase.from("memories").select("id,memory,category,importance,updated_at,last_used_at,use_count").eq("user_key",userKey).order("importance",desc).order("updated_at",desc).limit(30)` (`:352`). Then in-memory score `:354-357`: `importance * (1/(1+ageDays/45)) + min(1,use_count/10)`. Inject top 8, 240 chars each (`:372`). History trim: `recentTurnLimit=12`, `recentCharLimit=4500` (`:41-42`), each turn tail-capped 1,800 (`:161`). |
| Manual CRUD | `app/api/memory/route.ts:9,30,47,64` | `GET` limit 30 (`:14`); `POST` upsert `onConflict:"user_key,memory"` (`:38`), 500-char rejection (`:36`); `PATCH` update; `DELETE` scopes `all|memory|conversation` (`:68`). Single memory cap 500 chars. |

Models in `app/api/chat/route.ts:31-33`: chat `GROQ_MODEL ?? "qwen/qwen3.8-27b"`, memory `GROQ_MEMORY_MODEL ?? "openai/gpt-oss-20b"`, vision `GROQ_VISION_MODEL ?? "qwen/qwen3.8-27b"`. Both memory ops share the memory model.

**Gate for extraction:** `memoryIntent` regex (`route.ts:40`) — only runs if user text matches `จำไว้|จำว่า|เรียกฉันว่า|ชื่อของฉัน|ฉันชอบ|ฉันไม่ชอบ|ความชอบ|favorite|prefer|my name|remember|call me` (case-insensitive), plus `!idle && !visionIdle && groqApiKey` (`route.ts:651`). Otherwise no extraction.

---

## 2. GPT-OSS 20B call — endpoint, params, reasoning, JSON mode

- Wrapper: `callGroq` (`app/api/chat/route.ts:60-82`). Endpoint `https://api.groq.com/openai/v1/chat/completions` (`:76`).
- Payload (`:66-75`): `model, messages, temperature, max_tokens`, plus for JSON calls `response_format: {type:"json_object"}` (`:74`) and `temperature: 0` (`:71`). `reasoning_effort: "none"` + `top_p: 0.8` only when `!options.json` (`:71`) — so memory JSON calls **omit** `reasoning_effort` entirely.
- Memory calls always pass `{json:true, maxTokens}` → JSON mode + temp 0. No structured output / schema, no retry on malformed. Parse `JSON.parse` (`:130`) in try/catch → `[]` on failure (`:133-136`).
- Groq compaction on HTTP 413: `compactGroqMessages` (`:90-106`) keeps system start 4,400 chars (persona head) + end 2,500 chars (custom instructions + language lock), middle cut.

**Reasoning-output handling: unknown — needs verification.** Code does not read `reasoning`/`thinking` fields. If the model returns reasoning in a separate field or inline, current parsing (`parsed.memories`, `parsed.summary`) ignores unknown fields and never stores them — but this is assumed, not validated. **Open item 3.**

---

## 3. Supabase schema — memories, companion_state, conversations; pgvector; indexes

Migrations in `supabase/migrations/` (17 files). Relevant:

- `20260829000000_vivian_memory.sql:1-33` — `conversations(id uuid, user_key='default', title, created_at, updated_at)`; `messages(id bigint identity, conversation_id FK, role user|assistant, content)`; **`memories(id, user_key='default', memory text, category='general', importance smallint 1-5 DEFAULT 3, created_at, updated_at, UNIQUE(user_key,memory))`**. RLS on all three. Indexes: `messages_conversation_created_idx`, `memories_user_importance_idx(user_key,importance desc,updated_at desc)`.
- `20260830000000_companion_state.sql:1-12` — `companion_state(user_key TEXT PK, affinity 0-100 DEFAULT 22, trust 0-100 DEFAULT 18, familiarity 0-100 DEFAULT 8, mood TEXT DEFAULT 'calm' (no CHECK), mood_intensity 0-100 DEFAULT 35, conversation_summary TEXT DEFAULT '', last_idle_at, last_interaction_at, updated_at)`. RLS on.
- `20260901000000_memory_engagement.sql:1-3` — `memories += last_used_at, use_count`; index `memories_user_last_used_idx(user_key,last_used_at desc nulls last)`.
- `20261006005533_cloud_conversation_history.sql` — `messages += client_message_id uuid UNIQUE(conversation_id,client_message_id)`; RPC `vivian_save_conversation` append-only by client UUID, advisory lock.
- `20261105090000_custom_instructions.sql:4-12` — `vivian_custom_instructions(id TEXT PK CHECK(id='global'), instructions TEXT CHECK(char_length<=2000))`, RLS service-role only. Singleton for all accounts.

**pgvector: not present.** Repo-wide grep for `pgvector|embedding|vector\(` → zero results. No `vector` column, no vector index, no embedding code anywhere. **Open item 2** (check Supabase project directly — code cannot answer this).

Current index strategy for retrieval: `memories_user_importance_idx` + `memories_user_last_used_idx` (recency+importance). No semantic search.

---

## 4. Memory injection into chat prompt — all/top-k/summaries, token cost

- **All memories loaded** (30) then scored, **top 8 injected** (`route.ts:372`): `` `\n\nความจำเกี่ยวกับผู้ใช้ที่ควรใช้เป็นบริบท:\n` + 8 × `- [category] memory.slice(0,240)` ``.
- Worst case: 8 × 240 chars ≈ 1,920 chars ≈ ~1,000–1,400 tokens (Thai worse: characters ≈ tokens×2). No token budget, no truncation beyond per-item 240.
- Summary: `conversationSummary` (≤1,800 stored, ≤900 per new summary) injected near end of `personalityPrompt` (`:269`).
- Cost on real dataset unknown — never measure against production (plan §4.10). Synthetic approximation: 8×240 + summary ≤1,800 + persona (~9.8k chars in `lib/vivian-persona.ts` ≈ 5k tokens) + Thai canon `lib/vivian-story.ts` (~39 lines). Persona alone dominates. **Persona text itself is the largest token cost every turn** — this is the real budget problem, not memories.

---

## 5. JEV memory decision — what it sees, what it never sees

- Entry: `lib/jev.ts:139` `decideVivian`; plan resolution: `lib/chat-decision.ts:20-31` `resolveChatPlan`; call site `app/api/chat/route.ts:341-342`.
- JEV sees only `jev.ts:166-178`: `message` ≤1,200 chars, last 2 turns ≤240 each, `hasImage`, `memoryAvailable`, `capabilities`, ≤3 `toolkitCandidates`, `inputSource`, optional `availableScenes`. Questions include `needs_memory` (`jev.ts:53-54`): "Would durable user memories be relevant… Prefer yes for personal companion conversation; this only prepares context and never obligates an answer."
- **Never sees:** memory rows, `conversationSummary`, persona/story, image/audio bytes, credentials, user IDs (`docs/jev-decision-layer.md:46`, `lib/jev.ts:149-150` explicit projection).
- **Fails open:** `retrieveMemory = passive || localTools.includes("memory_retrieval") || memoryRecall || !decision || decision.memory.required || decision.memory.confidence < 0.85` (`chat-decision.ts:26-31`). Only a confident negative (`required=false, confidence ≥0.85`) skips retrieval. JEV timeout 2,000ms (`jev.ts:148`) → `decision=null` → retrieve. Passive `greeting/idle/vision_idle` bypass JEV and always retrieve (`route.ts:341`).

---

## 6. Persona prompt — location, layering order (exact)

Primary file: `lib/vivian-persona.ts:2-78` `vivianPersonaPrompt` (~9,800 chars, 84 lines). No `persona.ts` exists. Sections: Identity, Core personality (tsundere), Relationship: Secret Crush, Lolita fashion, Playful troublemaker/meme, Natural Thai voice (example lines), Conversation behavior, Immersion, Romance/mature, Spoken output + Five ElevenLabs tag categories, Output discipline.

Tunable bridge: `vivianTurnPrompt(customInstructions)` (`:80-84`) → `Additional character preferences…` sliced to 1,200 chars.

**System prompt assembly** (`app/api/chat/route.ts:382`):
```
personalityPrompt(...)  (:225-271)
+ sceneContextBlock     (:379-381)
+ plan.responseHint     (lib/chat-decision.ts:58)
+ vivianTurnPrompt(customInstructions)
+ languageLock(language)  // last, wins over Thai-heavy text (:209-216)
```

Inside `personalityPrompt()`, order:
1. `vivianPersonaPrompt` (`:229`)
2. `VIVIAN_STORY` Thai canon (`:231-232`, `lib/vivian-story.ts:1-39`)
3. `characterName` (40-char slice `:309`), `CharacterKey="Miss"` hardcoded (`:234`, body `character` ignored `:307`)
4. `moodStyle` Thai rules (`:236-238`), refusal commitment (`:240-241`), 1–3 sentence/1,000-char cap (`:242`), audio-tag restatement (`:243-246`), distress softening (`:247`)
5. Language rules (`:250-254`)
6. Routine/capability boundaries (`:256-263`)
7. Mood/relationship block `companionPromptBlock(state)` (`:265` → `lib/companion.ts:74-118`, duplicates persona sections in English)
8. Idle/vision-idle lines (`:267-268`)
9. Conversation summary (`:269`)
10. `memoryContext` (top-8, `route.ts:372`) + `toolContext` (`:373`)

Earlier wins implicitly by model attention: persona head is first, language lock last-and-explicit. Memories/tool context come last among knowledge but before custom instructions.

---

## 7. Long-chat trimming / summarization — does persona survive?

- **Trim** `trimHistory()` (`:156-170`): dialogue only, keep tail ≤1,800 chars/msg, ≤12 turns, ≤4,500 chars total; drops leading assistant turn (`:167`).
- **Summarize** `compressTurns()` (`:139-153`): `older ≥ 4` → Groq memory model → ≤900 new summary, ≤1,800 stored. Failure → previous summary unchanged.
- **Persona always survives trim** — system prompt is rebuilt from code constants every request; dialogue trimming never touches it. Summary is *injected*, doesn't replace persona. On 413 compaction, head (4,400) + tail (2,500) kept; summary/memories/middle cut first (`:90-106`).
- **Gap:** summary quality untested; no check that nicknames/running jokes survive. No drift test at 30+ turns.

---

## 8. Failure behavior (each failure)

| Failure | Behavior | Evidence |
|---|---|---|
| Extraction fails / malformed JSON | `return []`, `console.warn` — no write, chat unaffected (post-reply `after()`) | `route.ts:133-136, 651-662` |
| Supabase slow (memory load / state / writes) | `supabaseTimeoutMs=2000` (`:46`); load → `[]`/`defaultCompanionState()`; writes → swallowed, `historySaved=false` | `route.ts:352-363, 632, 662`, `lib/companion-store.ts:15-26` (clamp+normalize) |
| Groq rate-limited / chat timeout | Primary `primaryProviderTimeoutMs=45_000` (`:44`); falls through to Gemini candidates (`:562-587`); all fail → `504` (`:589-592`) | `route.ts:521, 576, 591` |
| Gemini fallback active | Same system prompt, same persona text — but Qwen↔Gemini behavior parity never evaluated | no parity test exists |
| JEV timeout / malformed | `decision=null` → `retrieveMemory=true`, state loads independently | `jev.ts:148`, `chat-decision.ts:31`, `route.ts:326` |
| TTS / Live2D fail | Never block text chat (reply already returned) | `route.ts:635-681` order |

All memory failures fail soft — text chat always completes (except total provider failure → 504).

---

## 9. Existing tests & what is untested

`npm run test:*` scripts in `package.json:10-29`. Requested suites:

- `tests/persona.test.mjs` (2 tests) — regex assertions that persona text exists in `lib/vivian-persona.ts`/`route.ts`/AGENTS. **Untested:** actual LLM behavior, refusal persistence over real multi-turn, language adherence.
- `tests/jev.test.mjs` (45 tests) — parsing, threshold ≥0.85, routing, mocked upstreams. **Untested:** real JEV latency/accuracy, extraction quality, ranking, search relevance.
- `tests/reset-companion.test.mjs` (4 tests) — mocked-Supabase deletion incl. custom instructions; verified-zero-rows. **Untested:** real Postgres partial failure, R2/scene data (out of scope of reset by design).
- `tests/chat-history*.test.mjs` (17 tests) — UUID stability, merge, pagination, RPC service-only. **Untested:** large-transcript perf, production RLS interplay.
- `tests/custom-instructions.test.mjs` (4 tests) — GET/PATCH, trim, 2,000-char cap (400), auth. **Untested:** prompt-injection via instructions, multi-device sync timing, whether instructions actually change LLM output (no LLM call).
- `tests/companion.test.mjs` (7 tests) — mood migration, decay, precedence. State rules **are** partially tested (contra plan assumption).

**Globally untested:** `extractMemories` quality (only routing asserted `jev.test.mjs:297-313`), retrieval ranking formula (`route.ts:356` — decay/use_count never asserted), `compressTurns` quality, top-8 injection cost, provider parity, 30+ turn drift.

---

## 10. Top weaknesses (ranked, with evidence + fix; marked in/out of this plan)

### W1 — Extraction gated by keyword regex; silent data loss for durable facts stated casually
**Evidence:** `memoryIntent` regex `route.ts:40` + gate `:651`. "ฉันชอบ X" passes, but "หลังๆ ชอบกิน..." / "เมื่อก่อนเรียน..." that misses the regex is never extracted. Precision/recall unmeasured.
**Fix (in plan §8.2 + §7.1):** fixture-based eval; move gate to JEV/`needs_memory` or always-consider + cheap prefilter; schema-validated JSON + deterministic secret prefilter; non-blocking post-reply.
**Not in plan:** changing categories/taxonomy until eval numbers exist.

### W2 — Custom instructions effective cap is 1,200 chars but storage allows 2,000; silent truncation
**Evidence:** storage 2,000 (`20261105090000_custom_instructions.sql`, `lib/custom-instructions.ts:1-9`) vs prompt `vivianTurnPrompt` slice 1,200 (`lib/vivian-persona.ts:83`). `normalizeCustomInstructions` slice unreachable via API (validation rejects first). User editing 1,201–2,000 chars gets silent cutoff with no UI signal.
**Fix (in plan §9.0):** enforce one budget server-side, surface counter in Settings, reject oversize with clear error, never silently truncate.
**Open item 5** needs owner confirmation of the single budget.

### W3 — Retrieval: no semantic search, no token budget, top-8 forced; recall unmeasured
**Evidence:** `route.ts:352-372` — SQL limit 30, heuristic score, slice 8. No `vector` column, no embedding (grep zero). No token budget; 8×240 chars can bloat prompt. `must_include/must_exclude` never tested.
**Fix (in plan §8.4 + §7.1):** embedding provider by eval (D4), score `0.60*similarity+0.25*recency+0.15*importance`, core set, fixed token budget, background `last_accessed_at` bumps.
**Blocked on Open items 1–2** (provider choice, pgvector presence).

### W4 — Secrets: prompt-only guard, no deterministic prefilter, no secret-leak test
**Evidence:** extraction prompt says "Never save secrets…" (`:125`) and schema upsert has no filtering (`:652`); no regex prefilter, no test. One model slip = token/password stored in Supabase.
**Fix (in plan §8.2 + §7.1):** deterministic regex prefilter (tokens/keys/ID/card patterns), zero-leak hard-fail eval.
**Not in plan:** moving Supabase encryption to field-level (out of scope).

### W5 — Persona in code, duplicated in 3 places, no fallback / no version history / Reset wipes it
**Evidence:** persona text lives in `lib/vivian-persona.ts` + `lib/vivian-story.ts` + `lib/companion.ts:74-118` (duplicated crush/fashion/agency blocks) — all hardcoded, no env/DB override. DB-stored custom instructions are `Additional preferences` appended, not the persona itself. Reset deletes singleton (`lib/reset-companion.ts:18-20`) + client `resetCustomInstructions()` (`companion.tsx:2271`) — a persona tuned in Settings is lost on Reset. No version history; one bad edit is unrecoverable.
**Fix (in plan §9.0):** shrink code to immutable core, move tunable persona into custom instructions, version table + restore control, D7 decision (Reset keeps instructions).
**Needs owner answers D6/D7, Open items 5–6** before Phase 3 starts.

### W6 — No contradictions/dedupe logic; UNIQUE(user_key,memory) only exact-match
**Evidence:** write path is bare upsert on exact text (`route.ts:652`). "ชอบ BL" vs "ไม่ชอบ BL" inserts both; near-duplicates stack, retrieval returns both. No `superseded_by`, no dedupe, no consolidation.
**Fix (in plan §8.3 + §8.6):** embedding + keyword candidate search, merge near-dupes, contradiction → insert + `superseded_by`, on-demand consolidation with lease, decay only (no deletion).
**Not in plan:** auto-deleting superseded memories without consolidation step.

### W7 — Provider parity never evaluated; Qwen thinking may leak
**Evidence:** persona suite is source-text only (`persona.test.mjs`); no live parity run. `callGroq` sets `reasoning_effort:"none"` only for non-JSON; memory JSON calls omit it (unknown if model returns reasoning in JSON or separate field). No reasoning-leak test.
**Fix (in plan §9.4 + §7.2):** live persona suite per provider behind `EVAL_LIVE=1`, reasoning-leak check, prompt parity fixes.
**Needs owner confirmation** of live-eval budget (real Groq/Gemini calls) before Phase 1 live runs.

### W8 — AGENTS.md/README drift will mislead future agents (auth, vision order, repo name)
**Evidence:** AGENTS claims Supabase Auth + 2-email allowlist + `/auth/callback` (`AGENTS.md:383`) vs code: vivianAuth bearer-token verification, any confirmed account (`lib/auth/server.ts:7-14`, `lib/auth/policy.ts:11-13`), FKs dropped (`20261107120000_drop_auth_fk.sql`). Vision claimed Gemini-first, code is Groq-first (`route.ts:449-509`). Repo cited `celestial-sora/ai-waifu`, remote is `celestia-sora/vivianlabs`. Timeouts 25/35s vs code 30/45/20s (`route.ts:28,43-45`).
**Fix (in plan §10 + §6):** Phase 4 docs rewrite after code stabilizes. **Do not fix docs now** — audit is the deliverable; docs update is Phase 4.

---

## 11. Open items (plan §14 — answers needed before Phase 2/3)

1. **Embedding provider (D4):** Groq models endpoint not verifiable from code alone; must call `GET /openai/v1/models` + read current Groq docs at Phase 1, then pick by Thai retrieval eval. No default chosen in this audit.
2. **pgvector availability:** not in repo; must check Supabase project extensions directly. If absent, fallback = keyword+recency (§8.4).
3. **GPT-OSS 20B structured output on Groq:** code assumes `response_format json_object` works (`route.ts:74`). If docs say unsupported, must add validation+retry-once (§8.2) before Phase 2.
4. **Contradictions vs plan §3:** plan says vision "Groq Qwen 3.8 27B" — code agrees (`route.ts:33`); plan says auth via `POST /api/verify` — code agrees (`lib/auth/server.ts`). Plan §3 is accurate; AGENTS.md is the stale one (see W8).
5. **Custom instructions storage/format/max/truncation/Reset:** singleton `vivian_custom_instructions(id='global', ≤2000)` service-role RLS; API rejects >2000 (400, no truncation); `normalize` slice unreachable; prompt cap effectively 1,200 silent; injection second-to-last before language lock (`route.ts:382`); Reset clears DB singleton + local cache + client state (`lib/reset-companion.ts:18-20`, `companion.tsx:2262-2271`).
6. **Tunables vs structure in `lib/vivian-persona.ts`:** everything is currently tunable content (speech style, tsundere mechanics, Thai voice, romance, tags) except the tag vocabulary + output-discipline rules which are structural. `vivianTurnPrompt` shows the only current DB bridge. Splitting core vs tunable = Phase 3 design (§9.0), needs D6/D7 owner decisions.

---

## 12. Deviation from plan

- **None** so far. Audit only. No code changes, no migrations, no env vars, no fixtures.
- One branch/PR per phase (§5) respected: this phase delivers exactly `docs/memory-persona-audit.md` and stops for owner review.
- Plan assumptions vs code mismatches found: (a) `persona.ts` does not exist — actual file is `lib/vivian-persona.ts` (subagents confirmed); (b) state-transition rules *are* partially tested (`tests/companion.test.mjs`) unlike plan §11 assumption; (c) `compaction` preserves persona head+tail (not just dialogue trim).

**Stop here for owner review** before Phase 1 (eval harness).
