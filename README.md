# Vivian AI Companion

Meet Vivian — a shy, polite, slightly awkward tsundere AI companion with her own opinions, mood state, and memory. She chats in natural, friendly Gen Z Thai (or your locked language), remembers details that matter, sees shared images/camera frames, and responds with synchronized Live2D expressions and voice.

- **Version:** `2.6.0`
- **Source code:** [github.com/celestia-sora/vivianlabs](https://github.com/celestia-sora/vivianlabs)
- **Sign-in service:** [vivianAuth](https://github.com/celestia-sora/vivianAuth) (Cloudflare Workers + D1)
- **Built with:** Next.js 16.3.3, React 19, TypeScript, Tailwind CSS v4, PixiJS v6 (`pixi-live2d-display/cubism4`), Supabase, Cloudflare R2

---

## Get her running ✨

You’ll need Git, Node.js 22+, and npm. Open a terminal and run:

```bash
git clone https://github.com/celestia-sora/vivianlabs.git
cd vivianlabs
npm ci
cp .env.example .env.local
npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env.local` instead of `cp`.

Open [http://localhost:3000](http://localhost:3000) to chat with Vivian 💜

For local preview without signing in via vivianAuth, set `NODE_ENV=development` and `DEV_BYPASS_LOGIN=true` in `.env.local` (never honored in production).

---

## Set up services

Configure credentials in `.env.local` for the capabilities you want to enable. See [.env.example](.env.example) for defaults.

| Service | Environment variables |
| --- | --- |
| Primary chat & memory | `GROQ_API_KEY`, `GROQ_MODEL` (default `qwen/qwen3.8-27b`), `GROQ_MEMORY_MODEL` (default `openai/gpt-oss-20b`), optional `GEMINI_API_KEY` (`GEMINI_MODEL`, default `gemini-2.5-flash`) |
| Vision | Groq only via `GROQ_VISION_MODEL` (default `qwen/qwen3.8-27b`, no Gemini fallback) |
| Sign-in bridge | `VIVIANAUTH_URL` + `VIVIAN_INTERNAL_TOKEN` (must match vivianAuth's Cloudflare secret) |
| App database | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, optional `SUPABASE_STORAGE_LIMIT_BYTES`; optional `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for Supabase Realtime only |
| Speech-to-Text & TTS | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
| Web search | `GEMINI_API_KEY`; optional `TAVILY_API_KEY` |
| JEV decision layer | `TYPESAFE_API_KEY` (or `JEV_API_KEY`), `JEV_ENABLED`, `JEV_DEBUG` |
| Private cloud storage | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `SCENE_STORAGE_PROVIDER=r2`, optional `SCENE_IMAGE_TOKEN_SECRET` (see [R2 guide](docs/private-r2-storage.md)) |
| Selected tier requests | Optional `RESEND_API_KEY`, `RESEND_FROM`, `NEXT_PUBLIC_APP_URL`, `TIER_ACTION_SECRET` (notifies `viviannextlabs@gmail.com`; `mailto:` fallback & Admin panel work without Resend) |

Keep provider API keys, Supabase service-role keys, and R2 credentials server-side only — never place privileged secrets in `NEXT_PUBLIC_*` environment variables.

---

## Sign-in, privacy & account tiers 🔒

Sign-in is delegated to [vivianAuth](https://github.com/celestia-sora/vivianAuth) (D1-backed). After login, vivianAuth redirects back with `#token=<session>`, which the client stores in `localStorage` (`vivian_auth_token`) and sends via `Authorization: Bearer` headers. Every API route verifies tokens server-side against vivianAuth `POST /api/verify`, and sign-out revokes sessions via `POST /api/logout`. Supabase stores application data only — never sign-in identities.

### Per-account isolation

Each verified account gets its own isolated companion data in Supabase:

- **Partner onboarding & profile (`/api/user-profile`):** New non-Sorachan users are greeted with a quick Gen Z Thai onboarding modal (`เพื่อนซี้`, `เพิ่งรู้จักกัน`, `รุ่นพี่ / รุ่นน้อง`, or `คนคุย / คนพิเศษ`, plus nickname, optional pronouns, and chat vibe notes) and talk with an isolated Vivian persona that excludes Sorachan/Ryuka lore. Designated Sorachan accounts preserve the original canon setup.
- **Memories, chat history & relationship state:** Conversations, durable memories, mood/affinity state, custom instructions (with version history), voice preferences (`voiceId` and `speechLanguage`), private scenes, and cloud models are scoped per account (`user_id`).
- **Reset Vivian:** Available under **Menu → Settings** (`เริ่มใหม่กับ Vivian (รีเซ็ต)`). Clears that account's cloud conversations, messages, memories, consolidation runs, relationship state, and local device chat cache while keeping imported Live2D models, voice settings, login session, and saved custom instructions.

### Tier matrix

Any confirmed, non-anonymous vivianAuth D1 account starts on the **Free** tier:

| Tier | Daily chat quota (Bangkok midnight reset) | Live2D models & custom scenes |
| --- | --- | --- |
| **Free** | 5 chats / day | Local browser IndexedDB model imports (<= 512 MiB) & preset backgrounds (`Christmas Day` / `Night`); Cloud R2 disabled |
| **Selected** | 20 chats / day | `512 MiB` personal Cloud R2 quota for synced Live2D packages & private uploaded scenes |
| **Sorachan** | Unlimited | Shared `8 GB` Cloud R2 budget (`2 GB` safety buffer kept free) + admin controls for reviewing Selected tier requests |

Users on **Free** can request **Selected** access directly from the in-app modal via `/api/tier-requests`.

Keep row-level security (RLS) enabled on Supabase tables with no public read or write policies; server routes enforce bearer verification and account ownership before reading or mutating data.

---

## What Vivian does ♡

- **Character-first Gen Z Thai conversation:** Driven by `lib/vivian-persona.ts` and `lib/vivian-story.ts` across providers (`Groq` primary, optional `Gemini` fallback). Vivian keeps her shy, polite tsundere core with smoother Gen Z Thai phrasing, optional memes in natural spots, and non-robotic UI/error copy across the app.
- **Per-account memory & consolidation:** Extracts durable preferences/facts (`GROQ_MEMORY_MODEL`, default `openai/gpt-oss-20b`), retrieves hybrid recall context, and summarizes/consolidates via `/api/memory` and `/api/memory/consolidate`. See [Memory system](docs/memory-system.md).
- **Web search & tools:** Optional search (`GEMINI_API_KEY` / `TAVILY_API_KEY`), calculator, weather, and Bangkok time tools supply context to Vivian without forcing assistant-style answers.
- **Vision:** Send image uploads or live camera frames (front/rear camera toggle). Uses Groq Qwen vision (`GROQ_VISION_MODEL`) exclusively.
- **Realtime voice & lip-sync:**
  - **Speech-to-Text:** ElevenLabs Scribe v2 Realtime (`/api/stt/token`) with batch `/api/stt` fallback anchored to the selected language (`th`, `en`, `ja`, `ko`, `zh`, or `global` auto).
  - **Text-to-Speech:** ElevenLabs `eleven_v4` Text-to-Dialogue (`/api/tts` and `/api/tts/stream`) emits inline audio tags (stripped before display, kept in TTS synthesis) and word alignment timestamps (`audio_alignment`) for synchronized [`KineticText`](components/KineticText.tsx) playback + Live2D `ParamMouthOpenY` lip-sync. Set `TTS_ALIGNMENT=off` to fall back to unaligned streaming. See [Thai TTS audit](docs/tts-thai.md).
  - **Voice & custom instruction sync:** Per-account ElevenLabs `Voice ID` and speech language persist via `/api/voice/preferences`; custom instructions (`<= 2000` chars) save per account with up to 10 restorable versions via `/api/custom-instructions`.
- **Optional JEV decision layer:** Analyzes recent turns and tool availability to decide when memory, tools, or scenes may help — never overrides Vivian's persona rules. See [JEV architecture](docs/jev-decision-layer.md).

---

## Live2D & 3D avatars ✨

Switch seamlessly between **Live2D** (default) and **3D (VRM / FBX)** inside **Character** (**ตัวละคร**) — your last selected mode is remembered per browser, and only one WebGL canvas is active at a time to keep mobile GPU memory clean.

- **Live2D (Cubism 4):** Import licensed `.zip` or unpacked folders (up to `512 MiB` archive and expanded size). Discovers undeclared `.exp3.json` expressions, poses, and `.motion3.json` groups locally via revocable Blob URLs (`lib/local-models.ts`), and adapts large texture atlases for mobile/desktop GPU budgets (`lib/model-textures.ts`).
- **3D Avatars (`.vrm` 0.x & 1.0, `.vrma`, `.fbx`, `.zip`, or folder):** Powered by Three.js + `@pixiv/three-vrm` + `@pixiv/three-vrm-animation` + an O(1) `FastFBXLoader` (`lib/avatar-3d-engine.ts`, `lib/vrm-procedural-mocap.ts`). Includes toggleable **Anime** / **Realistic (PBR + IBL)** lighting, autonomous relaxed posture (no T-pose), full-body procedural mocap gestures, SpringBone physics, real-time lip-sync, and AI emotion reactions. See [3D architecture](docs/3d-vrm-fbx-architecture.md).
- **Private Cloud R2 sync:** **Selected** and **Sorachan** accounts can sync both Live2D and 3D packages to private Cloud R2 storage (`lib/cloud-models.ts`). Licensed models are never checked into Git or `public/`. Text chat continues working smoothly even without a loaded model.

---

## Custom scenes 🌷

Upload JPG, PNG, WebP, or AVIF backgrounds (`<= 8 MB`) or import via HTTP(S) URL with SSRF protection (`lib/scene-images.ts`) in **Scenes** (**ฉากหลัง**). Scene uploads require **Selected** or **Sorachan** tier; **Free** accounts retain the built-in `Christmas Day` / `Christmas Night` presets. Scene images remain private and are never inspected by vision models. See [Dynamic scenes](docs/dynamic-scenes.md).

---

## Main API routes

All protected API routes verify vivianAuth tokens and enforce account/tier permissions server-side:

| Route | Purpose |
| --- | --- |
| `/api/account` | Account tier, capabilities, daily quota, storage usage, profile, and tier request status |
| `/api/chat` | Chat generation (Groq primary / optional Gemini fallback), search, vision, memory updates, and NDJSON streaming |
| `/api/conversations` | Paginated per-account chat history and idempotent message batch sync |
| `/api/custom-instructions` | Per-account custom instructions and recoverable version history |
| `/api/user-profile` | Per-account onboarding status, nickname, relationship preset, and vibe notes |
| `/api/memory` & `/api/memory/consolidate` | Memory CRUD and idle/batch memory consolidation |
| `/api/voice/preferences` | Per-account ElevenLabs `voiceId` and `speechLanguage` sync |
| `/api/stt` & `/api/stt/token` | Batch Speech-to-Text and single-use Scribe v2 Realtime browser tokens |
| `/api/tts` & `/api/tts/stream` | ElevenLabs `eleven_v4` audio synthesis and aligned streaming output |
| `/api/models/*` & `/api/models/preference` | Private Live2D cloud packages, asset uploads, expression prefs, and active model sync |
| `/api/scenes/*` | Custom background upload, URL preview, authenticated image proxy, and active scene preferences |
| `/api/storage/status` | Personal Cloud R2 or shared Supabase + R2 usage meter |
| `/api/tier-requests`, `/api/tier-requests/review`, `/api/admin/tier-requests` | Selected tier request submission, signed review links, and Sorachan admin management |
| `/api/realtime/config` | Authenticated Supabase Realtime connection config |
| `/api/jev/status` | JEV decision service availability status |

---

## Developer corner 🛠️

### Build & quality checks

```bash
npx tsc --noEmit
npm run lint
npm run build
```

### Verification & test scripts

Run feature and regression suites (do not point integration tests at production databases):

```bash
npm run test:persona
npm run test:persona:eval
npm run test:models
npm run test:scenes
npm run test:storage
npm run test:auth
npm run test:voice-preferences
npm run test:custom-instructions
npm run test:performance
```

Additional targeted suites such as `tests/user-profile.test.mjs`, `tests/tier-ui.test.mjs`, `tests/tier-api.test.mjs`, `tests/companion.test.mjs`, `tests/speech.test.mjs`, and `tests/tts.test.mjs` can be run with `node --experimental-strip-types --test <file>`. See [Performance Sprint guide](docs/performance-sprint.md) for browser performance checks (`npm run test:performance:browser`).

### Supabase migrations

Apply migrations in `supabase/migrations/` in chronological order before deploying matching features — notably:

- `20261003032056_dynamic_scenes.sql` (custom scenes)
- `20261005131311_private_r2_storage.sql` & `20261005152924_shared_r2_budget.sql` (private R2 storage & quota)
- `20261006005533_cloud_conversation_history.sql` (cloud conversation history)
- `20261105090000_custom_instructions.sql`, `20261109000000_custom_instruction_versions.sql`, `20261112100000_account_custom_instructions.sql` (per-account custom instructions + versions)
- `20261105200000_voice_id_preference.sql` & `20261107120000_drop_auth_fk.sql` (voice preferences & vivianAuth D1 identities)
- `20261201000000_memory_v2.sql` (Memory v2)
- `20261202000000_user_tiers_and_isolation.sql` (account tiers, daily chat quotas, and per-account isolation)
- `20261203000000_user_profiles_onboarding.sql` (onboarding & partner profiles)

---

## Project structure

- `app/` — Pages (`/`, `/login`, `/access-denied`), Live2D companion UI (`app/companion.tsx`), components (`app/components/`), and API routes (`app/api/`)
- `components/` — `KineticText` synchronized speech component (`components/KineticText.tsx`) and reusable `smoothui` interaction/upload/carousel/text primitives (`components/ui/smoothui/`)
- `lib/` — Persona prompts, LLM/JEV routing, memory v2, auth policy/verify bridge, tier quotas, Live2D loaders, texture planning, and voice streaming
- `supabase/migrations/` — PostgreSQL schema migrations
- `docs/` — Architecture, storage, memory, persona, TTS, and performance docs
- `tests/` — Unit, integration, persona eval, and performance tests

## Technical notes

- Live2D requires PixiJS v6 (`pixi.js@^6.5.10`) and `pixi-live2d-display/cubism4`. Do not upgrade PixiJS to v7+.
- Live2D loads strictly client-side after Cubism Core (`public/live2d/live2dcubismcore.min.js`) is loaded via `<Script strategy="beforeInteractive">`.
- All provider keys and storage secrets stay on the server; client requests authenticate through bearer tokens verified against vivianAuth.
- External MCP servers are not connected yet.
- Optional features (voice, Live2D models, JEV, web search, cloud storage) degrade gracefully so text chat remains available.

## License & assets

This repository contains Vivian's application code. Models and other assets remain subject to their respective license terms. Live2D credit: **sorachan**. Ensure any imported model license permits your usage and private cloud storage.
