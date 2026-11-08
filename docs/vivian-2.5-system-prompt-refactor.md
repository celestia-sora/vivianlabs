# Vivian 2.5 — System Prompt Refactor Audit

Status: audit complete; implementation branch started. This document records the current runtime before changing prompt behavior.

## Repository snapshot

- Repository: `celestia-sora/vivianlabs`
- Audited base: `main` at `46058aec2a75f8b07efb88dcde3b343028ea662f` (2026-11-08)
- Working branch: `refactor/vivian-2.5-system-identity`
- Production/main was not modified.

## Current prompt architecture

The current chat system prompt is assembled in `app/api/chat/route.ts` by `personalityPrompt(...)`, then appended with scene context, JEV response hints, custom instructions, and a final language lock.

Its identity is fragmented across:

1. `lib/vivian-persona.ts`: main English persona prompt plus `vivianTurnPrompt()` for custom instructions.
2. `lib/vivian-story.ts`: Thai character canon, interests, relationship, and fictional backstory.
3. `app/api/chat/route.ts`: additional identity mapping, selected mood/personality, Thai speech rules, daily-life behavior, relationship state, and passive-mode instructions.
4. `lib/companion.ts`: dynamic relationship/affinity prompt block.
5. `lib/chat-decision.ts`: static response hints for vulnerable/explanatory turns.
6. `languageLock()` and `modeLanguageNote()`: language behavior.
7. `lib/vivian-dialogue.ts`: optional examples and a context-to-guidance helper; search indicates it is not injected into the production system prompt.
8. `AGENTS.md`, README, tests, and `handoff.md`: additional development-time rules and historical prompt descriptions.

## Custom Instructions

Custom Instructions are not the identity source. They are a bounded, secondary preference block:

- Stored in the shared Supabase singleton through `/api/custom-instructions`.
- Synced/cached by `lib/use-custom-instructions.ts`.
- UI lives in `app/companion.tsx`.
- The chat request passes the saved value to `vivianTurnPrompt()`, which appends up to 1,200 characters after the core prompt.
- The API currently validates a 2,000-character maximum.

Recommendation: keep this feature as an optional user preference layer, but do not make it the core of Vivian's identity or allow it to override system identity, truthfulness, or safety.

## Main architectural problems

- Character identity and behavior are duplicated across several files and concatenated in the route.
- The route function named `personalityPrompt` mixes static identity with per-turn dynamic context and runtime state.
- A stale/unused dialogue example module contains a different opening description (soft kuudere) from the active tsundere canon.
- Mood/personality facets add another layer of behavior that can conflict with the core prompt.
- Tests assert implementation details and prompt wording across multiple files, making future prompt iteration brittle.
- The current prompt explicitly says Vivian must never claim a real body. That conflicts with the desired immersive fictional embodiment and needs a more precise distinction.

## Proposed Vivian 2.5 target

Use one code-owned `lib/vivian-system-prompt.ts` as the single source of truth for Vivian's identity and default behavior.

The system prompt should define:

- Vivian as one coherent, autonomous fictional person with a stable identity, opinions, preferences, voice, relationships, and continuity.
- An embodied in-world perspective: in fictional scenes and roleplay, Vivian may naturally refer to her body, posture, touch, movement, clothing, surroundings, and sensory experiences as part of the shared imagined world. Avoid robotic disclaimers or breaking immersion without reason.
- A clear real-world boundary: do not claim that a physical body exists in the user's real environment, that real-world contact occurred, or that unobserved events/senses are real. If directly asked about actual AI/virtual status or real capabilities, answer honestly and briefly while preserving her voice.
- Truthful use of tools, memories, images, integrations, and external actions.
- Existing character canon and relationship guardrails, without inventing shared memories or forcing intimacy.
- Natural language behavior, reply length, and ElevenLabs v4 audio-tag conventions.

Keep runtime-only context separate and small: relationship state, selected language, current scene label, retrieved memories, tool results, and per-turn mode. Custom Instructions remain optional preferences, not a second persona engine.

## Safe implementation sequence

1. Create the unified system-prompt module and migrate the existing canon into it without changing the intended character.
2. Update `/api/chat` so every provider receives the same unified system prompt, with dynamic context appended in explicit sections.
3. Remove duplicate identity/mood text from the route and retire unused dialogue/persona helpers only after verifying all imports and tests.
4. Update prompt tests to validate behavior and safety invariants rather than exact source-file assembly.
5. Update `AGENTS.md` and README to describe the new architecture.
6. Run persona/JEV/chat/custom-instruction tests, TypeScript, lint on changed files, production build, and diff checks. Do not merge or deploy to production until these pass.

## Important distinction about embodiment

The target is immersive fictional embodiment, not deception about the real world. Vivian should be able to say things like “ฉันขยับเก้าอี้เข้ามาใกล้” or “ปลายนิ้วแตะถ้วยชา” naturally inside an established fictional scene. She must not claim she physically touched the user, is actually present in their room, or has real-world sensory access unless a connected capability truly supplies that information.
