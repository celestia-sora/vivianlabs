# Vivian persona system (Phase 3)

Single documented location for the layered system prompt. Code core:
`lib/vivian-persona.ts`. Tunable seed: `docs/persona-profile-template.md`.
Fixture for tests: `tests/fixtures/persona/profile.sample.md`.

## Priority order (highest first; not the literal concatenation order)

```
(1) Immutable core — `lib/vivian-persona.ts`
    Safety, consent, truthful identity/capability boundaries, and output
    constraints. Cannot be overridden by custom instructions or memory.
        ↓
(2) Owner Custom Instructions — `vivianTurnPrompt()`
    HIGHEST PRIORITY for configurable personality: voice, tone, behavior,
    interests, relationship style, roleplay preferences, and character
    details. Overrides conflicting defaults and contextual hints.
    The single Settings field is the source of truth for owner customization.
        ↓
(3) Built-in Vivian defaults — fallback character traits and story details.
    Used where the owner has not specified a preference.
        ↓
(4) State hints and retrieved memories — context only; never instructions
    and never allowed to override the owner's custom persona.
        ↓
    Scene context + plan hint, then languageLock (LAST; language is fixed).
```

Assembly in `app/api/chat/route.ts` (system prompt, rebuilt every request):
`personalityPrompt(state, memoryContext, toolContext, summary, ...)`
+ sceneContextBlock + plan.responseHint + vivianTurnPrompt(customInstructions)
+ languageLock(language).

## Custom instructions: storage, validation, budget, injection

- **Stored:** Supabase `public.vivian_custom_instructions`, singleton
  `id='global'`, service-role only (migration
  `20261105090000_custom_instructions.sql`). LocalStorage is an offline
  cache only; cloud is authoritative after first sync.
- **Budget (one, server-side):** `MAX_CUSTOM_INSTRUCTIONS_LENGTH = 2000`
  in `lib/custom-instructions.ts`. Storage CHECK, API validation, prompt
  injection, and the Settings counter all share this single budget. The
  limit is kept within the current Groq 8K context budget; the complete
  custom block is reserved before lower-priority context is trimmed.
- **Validation:** `PATCH /api/custom-instructions` rejects oversize with
  HTTP 400 and a clear message — never silently truncates (audit W2).
  Previously the prompt silently cut to 1200 chars while storage allowed
  2000; `vivianTurnPrompt()` now uses the same 2000 budget.
- **Injection position:** after built-in persona/story/state/memory/tool
  context and immediately before `languageLock`. The chat route reserves
  the complete custom block before trimming lower-priority context, so it
  is never silently truncated by `PROMPT_CHAR_CAP`.
- **Version history:** `custom_instruction_versions` (migration
  `20261109000000_custom_instruction_versions.sql`), last 10 saves kept,
  appended on every PATCH, "Restore previous version" in Settings.
  Rollback: drop the table; singleton is unchanged.
- **Reset (D7, owner confirmed 2026-11-09):** Reset Vivian KEEPS custom
  instructions (and version history). Clearing them is the separate
  explicit "Clear custom instructions" action in Settings.
- **Testing:** the real profile lives in the DB, not git. `test:persona`
  takes the profile as an input fixture
  (`tests/fixtures/persona/profile.sample.md`) and must pass with the
  sample AND with an empty profile (core fallback).

## State rules (§9.2, in `lib/companion.ts`)

- Numeric bounded 0..100: `affinity`, `trust`, `familiarity`,
  `moodIntensity`; `mood` is an enum. All clamped via `clampScore()` /
  `sanitizeCompanionState()`.
- Named bands → short prompt hints: `affinityBand()` (distant/warming/
  close), `trustBand()` (guarded/building/trusting), `familiarityBand()`
  (new/familiar/known), `moodIntensityBand()` (subtle/noticeable/strong).
  `companionPromptBlock()` is token-capped and uses only these bands.
- The model may suggest a change, but code validates/clamps it:
  `validateProposedState()` caps one reply to ±5 affinity/trust,
  ±3 familiarity, ±15 mood intensity — one reply never swings to extreme.
  `applyConversationTurn()` uses the same bounded deltas.
- Decay: `decayCompanionState()` decays `moodIntensity` by 8 per 2-hour
  step and returns `mood` to `calm` at ≤18. Affinity/trust/familiarity
  persist (long-term). Unit tests cover clamping, band thresholds, and
  decay in `tests/companion.test.mjs`.

## Long-chat drift (§9.3)

- Trimming guard: `trimHistory()` in `app/api/chat/route.ts` trims only
  dialogue messages. The system prompt is rebuilt from code constants on
  every request, so layers 1–3 always survive; summarization injects a
  summary, it never replaces persona text. Groq 413 compaction keeps the
  system head (core) + tail (profile + language lock). Asserted in
  `tests/persona.test.mjs`.
- Persona reminder at the end of long contexts: **skipped** — no drift
  evidence in the offline suite, and the rebuild-every-request guarantee
  already covers it. Add only if a live long-context eval (30+ turns)
  shows drift; measure token/latency cost first.

## Provider parity (§9.4)

- `test:persona` runs the same checklist per provider (primary Qwen via
  Groq, fallback Gemini) in offline/mocked mode: identical core +
  profile assertions for both, reported as separate provider rows.
- Live parity: behind `EVAL_LIVE=1`, the suite expects real provider
  credentials and records per-provider pass rates. Default CI is offline
  and deterministic. Results are reported in the PR summary.

## Emotion tags (§9.5)

- Tags are metadata for ElevenLabs v4, never spoken/displayed words.
  `speechText()` in `lib/speech.ts` strips all `[…]` audio tags from
  spoken text; `speechTextWithAudioTags()` preserves them inline for
  ElevenLabs v4. The streaming buffer also preserves standalone
  non-verbal vocalizations such as `[laughs]` and `[sighs]`; these are
  valid audio payloads even when no spoken words follow.
- WebSocket completion logs include `audioTagCount`, allowing Vercel
  logs to confirm that tags reached the ElevenLabs provider.
- Use vocal-performance tags only: emotion, delivery, and audible human
  vocalizations. Do not use environmental sound effects or visual-only
  stage directions as vocal tags.
- `tests/persona.test.mjs` asserts tag guidance; `tests/speech.test.mjs`,
  `tests/tts-text-buffer.test.mjs`, and `tests/elevenlabs-ws.test.mjs`
  cover normalization, buffering, and provider forwarding.
## How to add a persona test

Add a case to `tests/persona.test.mjs` asserting on (a) the core in
`lib/vivian-persona.ts`, (b) the sample fixture
`tests/fixtures/persona/profile.sample.md`, and/or (c) the empty-profile
fallback (`vivianTurnPrompt("") === ""` while the core still contains
the behavior). Cover Thai in every prompt/test change. Never test
against production data.
