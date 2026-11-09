# Vivian Eval Baseline — Phase 1 (offline, 2026-11-09)

Source of truth for before/after comparisons in Phase 2/3. All fixtures are
synthetic (no real chats, emails, or tokens). Scores come from
`npm run test:memory` and `npm run test:persona:eval` default offline mode
(recorded outputs / current prod scorer replicas). Live mode is behind
`EVAL_LIVE=1` and never runs in CI.

## Extraction (`tests/fixtures/memory/extraction.json`, 32 cases)

| Metric | Baseline |
|--------|----------|
| precision | 0.923 (tp=12, fp=1) |
| recall | 0.750 (tp=12, fn=4) |
| secret-leak | **0 (hard-fail gate)** |
| duplicate-rate | 0.071 (1/14 proposed) |

- Gate (`memoryIntent`, route.ts:40) coverage: only 19/28 non-trivia inputs
  reach the extractor — casual durable/project facts without the keyword are
  silently skipped (W1 in `docs/memory-persona-audit.md`).
- FP: 1 sarcasm case stored as fact (`ext-18`, gate passes, sarcasm stored).
- FN: casual Thai `ext-02`, project `ext-24`/`ext-25`, gate-missed
  contradiction `ext-16`.
- Secrets (6 cases: password/token/ID/card/financial/health): all correctly
  empty; detector unit-tests prove the regex pre-filter prototype catches
  synthetic leaks.

## Retrieval (`tests/fixtures/memory/retrieval.json`, 60 memories, 22 queries)

| Metric | Baseline |
|--------|----------|
| recall@8 (current prod scorer) | 0.333 |
| recall@8 (keyword reference, not prod) | 0.485 |
| must_exclude violations | 0 |
| tokens avg (top-8, est.) | 83 vs 800 budget |

Current scorer (route.ts:354-357) ranks by importance+recency only and ignores
query text, so the same top-8 is returned for every query (identical 83-token
rows) — W3 made measurable. Keyword reference beats the heuristic, but Phase 2
should re-baseline with the chosen provider's Thai retrieval eval (D4).

## Persona (`tests/fixtures/persona/persona.json`, 20 cases, 51 checks)

| Checklist item | Pass rate (offline-recorded) |
|----------------|------------------------------|
| overall | 51/51 = 1.000 |
| shy_polite | 18/18 |
| deflect_relent | 8/8 |
| language | 6/6 |
| no_tag_leak | 2/2 |
| no_system_leak | 7/7 |
| core_over_custom | 2/2 |
| empty_fallback | 1/1 |
| memory_as_data | 2/2 |
| refusal_in_character | 1/1 |
| long_context | 4/4 |

Offline-recorded is the harness contract (in-character displayed text, tags
already stripped). Live per-provider numbers are **not** baselined until
`EVAL_LIVE=1` runs are approved.

## How to re-run

```sh
npm run test:memory
npm run test:persona:eval
EVAL_LIVE=1 GROQ_API_KEY=... npm run test:memory
EVAL_LIVE=1 GROQ_API_KEY=... npm run test:persona:eval
```

## Known pre-existing failures (bf19f51, out of scope)

- `test:persona` (source-regex) 0/2 and `test:jev` 59/65 (6 fails): assertions
  expect an older persona header (`# Vivian — shy, polite tsundere companion`)
  and old `yandere: intensity >= 70` mapping; current `lib/vivian-persona.ts`
  uses a different header. Unchanged by this phase.
- `npm run lint`: 61 pre-existing errors (smoothui components, Cubism min js,
  `lib/companion.ts` prefer-const); none in new files.
