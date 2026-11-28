# Vivian Dual-Engine Avatar Architecture — Live2D Cubism 4 + 3D (VRM & FBX)

`vivianlabs` supports both **Live2D Cubism 4** (`pixi.js@^6.5.10`, `pixi-live2d-display/cubism4`) and **3D Avatars** (`three@0.187.0`, `@pixiv/three-vrm@3.6.0`, `@pixiv/three-vrm-animation@3.6.0`, optimized `FastFBXLoader`) behind a mutually exclusive **`Live2D` | `3D (VRM / FBX)`** switcher in **Menu → Character (ตัวละคร)**.

- Default mode for new users is **`live2d`**, persisted per browser in `localStorage` (`vivian-avatar-mode`).
- Only one WebGL canvas and engine mounts at a time: switching to 3D cleanly disposes PixiJS/Live2D, and switching back to Live2D cleanly disposes Three.js/VRM/FBX and releases all Blob URLs and GPU memory.
- Three.js / VRM / FBX bundles are lazily loaded only when 3D mode is activated (`lib/model-runtime-3d.ts`).

## 3D Module Map

| File | Role |
| --- | --- |
| `lib/use-avatar-3d.tsx` | Self-contained React hook gated by `enabled` (`avatarMode === "3d"`): manages the 3D catalog, `Avatar3DStage` lifecycle, lighting/quality settings, drag/zoom/reset + look-at handlers, 3D expressions, mocap poses, upload/cloud sync, and full disposal on switch to Live2D |
| `lib/avatar-3d-engine.ts` | Core `Avatar3DStage` class (Three.js WebGLRenderer, VRM 0.x/1.0 + FBX loading, `.vrma` & Mixamo `.fbx` mocap clip playback, toggleable `anime` / `realistic` lighting, visible-mesh auto-framing, Rigify/Auto-Rig Pro widget & skybox filtering, anime `*_OL` inverted-hull ink tuning, unmapped Blender texture auto-binding, SkinnedMesh draw-call batching, world-space T-pose relaxation, multi-skeleton FBX sync, autonomous breathing/blinking/look-at/SpringBone breeze, lip-sync, emotion reactions, face snapshot capture) |
| `lib/vrm-procedural-mocap.ts` | Full-body procedural mocap synthesizer for VRM 0.x & 1.0 (organic contrapposto hip weight-shift, grounded leg/knee/foot articulation, 10-finger relaxed curl, speech-driven talking hand gestures, and 6 built-in full-body gestures: `greeting_wave`, `shy_fidget`, `pout_hips`, `happy_cheer`, `thinking_chin`, `playful_tilt`) |
| `lib/fast-fbx-loader.js` | Performance-patched Three.js `FBXLoader` (O(1) `rawBoneByParentId` skeleton index + shared `Bone` reuse + O(1) animation keyframe maps) eliminating upstream O(N⁴) hangs on 250+ mesh Blender/Sketchfab FBX exports |
| `lib/vrm-metadata.ts` | Zero-WebGL binary inspector for VRM 0.x/1.0 GLB headers, embedded thumbnails, `.vrma` binary checks, FBX binary/ASCII validation, and companion motion detection |
| `lib/model-runtime-3d.ts` | Lazy dynamic cached preloader for `three`, `GLTFLoader`, `FastFBXLoader`, `RoomEnvironment`, `@pixiv/three-vrm`, and `@pixiv/three-vrm-animation` |
| `lib/avatar-emotion.ts` | 3D emotion mapping (VRM 1.0/0.x expression resolver, FBX ARKit/MMD morph weights, clip matcher, and procedural head/body reactions) |
| `lib/local-models-3d.ts` | `.vrm` / `.vrma` / `.fbx` / `.zip` / folder importer with automatic 1-level Sketchfab nested-ZIP unwrapping, duplicate truncated texture deduplication, UV texture preview exclusion, dedicated IndexedDB v2 store (`vivian-local-models-3d`), namespaced selection keys (`vivian-model-selection-3d` / `vivian-local-model-3d`), and scoped revocable Blob URL resolver |
| `lib/cloud-storage.ts` & `lib/cloud-models.ts` | Accepts `.vrm`, `.fbx`, and `.model3.json` manifests in R2/Supabase; client cleanly partitions cloud packages via `isLive2DCloudModel` vs `is3DCloudModel` |
| `app/companion.tsx` | Adds the segmented **`Live2D` \| `3D (VRM / FBX)`** mode switcher in Character panel, mounts mutually exclusive WebGL canvases, and routes TTS lip-sync, AI emotion reactions, and `/expression` commands to whichever engine is active |

## Interaction, Lighting & Performance

- **User controls (3D):** Drag to reposition, pinch/wheel to zoom, double-tap/double-click or button to reset. No manual 3D orbit/rotation — the engine autonomously handles relaxed posture, breathing, blinking, look-at, SpringBone physics, lip-sync, and full-body mocap reactions.
- **Lighting toggle:** Persisted in `localStorage` (`vivian-3d-lighting-mode`):
  - `anime`: Soft MToon-friendly three-point + hemisphere light, `NoToneMapping`, matte Phong specular tuning, transparent over existing 2D Scene backgrounds.
  - `realistic`: `ACESFilmicToneMapping`, `RoomEnvironment` IBL reflections, soft `PCFSoftShadowMap` shadows, and shadow-catching floor plane.
- **Performance & Mobile GPU Budget:**
  - **O(1) FBX loader (`lib/fast-fbx-loader.js`):** O(1) skeleton cluster index + shared `Bone` reuse + O(1) animation keyframe time maps.
  - **Skeleton deduplication & SkinnedMesh draw-call batching:** Shares identical `Skeleton` instances across multi-mesh FBX avatars and merges compatible `SkinnedMesh`es sharing `(parent, skeleton, transform, material)` + lightweight shared `MeshBasicMaterial` anime outlines (`*_OL`).
  - **Zero-GC animation loop & background pause:** Pre-allocated scratch math/Maps eliminate per-frame allocations; `visibilitychange` automatically pauses `requestAnimationFrame` when hidden; `preserveDrawingBuffer: false` eliminates per-frame TBDR framebuffer copies on mobile GPUs (with synchronous render before `captureFaceSnapshot()`).
  - **Adaptive DPR & texture cap:** In `auto` quality mode, oversized 4K/8K textures downscale before WebGL upload (`1024px` iOS, `1536px` dense multi-texture desktop, `2048px` default desktop) with up to 4× anisotropy, and ultra-dense models (`>400K` vertices) cap DPR and skip redundant shadow-map passes while preserving full ACES + IBL Realistic lighting.

## 24-Pose Semantic Motion Library & Secondary Physics

- **Layered pipeline:** `Conversation / Emotion -> SemanticMotionIntent (lib/avatar-3d-poses.ts) -> Pose & Priority Resolver -> VRM Mocap Controller (lib/vrm-procedural-mocap.ts) -> Joint Clamps + Secondary Physics (lib/avatar-3d-physics.ts) -> Avatar3DStage`.
- **24 Semantic Pose IDs:** Grouped into `idle` (`relaxed_idle`, `weight_shifting`, `natural_breathing`, `looking_around`), `conversation` (`explaining`, `attentive_listening`, `gentle_nodding`, `thinking`), `emotion` (`genuine_happiness`, `shy_embarrassed`, `confused`, `sad_concerned`, `surprised`, `playful_teasing`), and `action` (`greeting_wave`, `pointing`, `arms_crossed`, `casual_sitting`, `leaning_forward`, `stretching`, `hair_adjustment`, `natural_laughing`, `goodbye`, `phone_interaction`).
- **Known rig limitations & safe fallbacks:** Because the companion stage renders over 2D scenes without 3D chair or phone props, `casual_sitting` resolves to `relaxed_idle` and `phone_interaction` resolves to `attentive_listening` unless a scene prop is present. Unbound VRM expression presets (such as empty `neutral` or zero-bind `relaxed`) are filtered from runtime expression selection.
- **How to add & test a new semantic pose:**
  1. Add the pose ID and metadata (`category`, `labelTh`, `priority`, `defaultEmotion`, `gazeMode`, `blendInSec`, `blendOutSec`, `holdSec`) to `SEMANTIC_POSE_LIBRARY` in `lib/avatar-3d-poses.ts`.
  2. Add the FK/IK-verified 1-DOF elbow target in `applyVrmFullBodyMocap()` (`lib/vrm-procedural-mocap.ts`); all bone rotations are automatically clamped by `JOINT_LIMITS` and exponentially smoothed across pose switches.
  3. Run `node --experimental-strip-types --test tests/avatar-3d-poses.test.mjs tests/avatar-3d.test.mjs tests/avatar-3d-physics.test.mjs` and `npx tsc --noEmit`.
