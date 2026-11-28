/**
 * Full-Body Procedural Mocap & Expressive Gesture Synthesizer for VRM Avatars.
 *
 * Gives every `.vrm` (0.x & 1.0) natural mocap-like full-body motion out of the box
 * without requiring external motion files:
 *  - Organic contrapposto hip weight-shift + grounded leg/knee/foot articulation
 *  - Relaxed natural finger curl across all 10 fingers (no stiff T-pose hands)
 *  - Breathing spine/chest/shoulder rhythm & subtle head/neck sway
 *  - Speech-driven hand/arm micro-gestures synchronized to voice amplitude
 *  - 6 expressive full-body gestures (auto-triggered by AI emotion & selectable in UI)
 *    with smooth exponential crossfading and zero per-frame allocations.
 */

import type { VRM as VrmInstance, VRMHumanBoneName } from "@pixiv/three-vrm";
import type { AvatarEmotion } from "./avatar-emotion.ts";

export type VrmGestureId =
  | "greeting_wave"
  | "shy_fidget"
  | "pout_hips"
  | "happy_cheer"
  | "thinking_chin"
  | "playful_tilt";

export interface BuiltInVrmGesture {
  id: VrmGestureId;
  label: string;
  durationSec: number;
  loopable: boolean;
}

export const BUILT_IN_VRM_MOCAP_GROUP = "ท่าขยับอัตโนมัติ (Mocap)";

export const BUILT_IN_VRM_GESTURES: readonly BuiltInVrmGesture[] = [
  { id: "greeting_wave", label: "โบกมือทักทาย", durationSec: 3.4, loopable: true },
  { id: "shy_fidget", label: "เขิน / ซึนเดเระ", durationSec: 4.2, loopable: true },
  { id: "pout_hips", label: "งอนเท้าสะเอว", durationSec: 4.0, loopable: true },
  { id: "happy_cheer", label: "ดีใจร่าเริง", durationSec: 3.2, loopable: true },
  { id: "thinking_chin", label: "ครุ่นคิด", durationSec: 4.4, loopable: true },
  { id: "playful_tilt", label: "ขี้เล่นแซว", durationSec: 3.8, loopable: true },
];

export function emotionToBuiltInGesture(emotion: AvatarEmotion): VrmGestureId | null {
  switch (emotion) {
    case "happy":
    case "laugh":
      return "happy_cheer";
    case "blush":
    case "love":
      return "shy_fidget";
    case "angry":
      return "pout_hips";
    case "tease":
    case "hair":
      return "playful_tilt";
    case "thinking":
    case "confused":
      return "thinking_chin";
    case "surprised":
      return "greeting_wave";
    default:
      return null;
  }
}

export interface VrmMocapState {
  elapsedSec: number;
  dt: number;
  hipsRestPos: { x: number; y: number; z: number } | null;
  pointerSmoothX: number;
  pointerSmoothY: number;
  mouthCurrent: number;
  speechActivity: number;
  /** Currently active gesture (null = organic living idle stance). */
  gestureId: VrmGestureId | null;
  /** Smoothly blended gesture weight [0, 1]. */
  gestureWeight: number;
  /** Time since current gesture began (seconds). */
  gestureAgeSec: number;
  /** Additional procedural head/spine reaction offsets from emotion scorer. */
  reactHeadPitch: number;
  reactHeadYaw: number;
  reactHeadRoll: number;
  reactSpinePitch: number;
}

interface EulerTarget {
  x: number;
  y: number;
  z: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Set a VRM normalized humanoid bone's Euler rotation cleanly across BOTH
 * VRM 0.x (pre-rotateVRM0 -Z forward, which negates local X & Z) and
 * VRM 1.0 (+Z forward). Angles are authored in VRM 1.0 convention:
 *   +X = avatar left, +Y = up, +Z = forward toward camera.
 */
function applyNormalizedBone(
  vrm: VrmInstance,
  boneName: VRMHumanBoneName,
  rx: number,
  ry: number,
  rz: number,
  dir: number,
): void {
  const node = vrm.humanoid?.getNormalizedBoneNode(boneName);
  if (!node) return;
  node.rotation.set(rx * dir, ry, rz * dir);
}

const LEFT_FINGERS: ReadonlyArray<{ bone: VRMHumanBoneName; curl: number }> = [
  { bone: "leftIndexProximal", curl: 0.22 },
  { bone: "leftIndexIntermediate", curl: 0.28 },
  { bone: "leftIndexDistal", curl: 0.16 },
  { bone: "leftMiddleProximal", curl: 0.28 },
  { bone: "leftMiddleIntermediate", curl: 0.34 },
  { bone: "leftMiddleDistal", curl: 0.20 },
  { bone: "leftRingProximal", curl: 0.34 },
  { bone: "leftRingIntermediate", curl: 0.38 },
  { bone: "leftRingDistal", curl: 0.22 },
  { bone: "leftLittleProximal", curl: 0.40 },
  { bone: "leftLittleIntermediate", curl: 0.44 },
  { bone: "leftLittleDistal", curl: 0.26 },
];

const RIGHT_FINGERS: ReadonlyArray<{ bone: VRMHumanBoneName; curl: number }> = [
  { bone: "rightIndexProximal", curl: 0.22 },
  { bone: "rightIndexIntermediate", curl: 0.28 },
  { bone: "rightIndexDistal", curl: 0.16 },
  { bone: "rightMiddleProximal", curl: 0.28 },
  { bone: "rightMiddleIntermediate", curl: 0.34 },
  { bone: "rightMiddleDistal", curl: 0.20 },
  { bone: "rightRingProximal", curl: 0.34 },
  { bone: "rightRingIntermediate", curl: 0.38 },
  { bone: "rightRingDistal", curl: 0.22 },
  { bone: "rightLittleProximal", curl: 0.40 },
  { bone: "rightLittleIntermediate", curl: 0.44 },
  { bone: "rightLittleDistal", curl: 0.26 },
];

// Reusable scratch targets to keep the 60fps loop 100% zero-GC
const _lUpperArm: EulerTarget = { x: 0, y: 0, z: 0 };
const _rUpperArm: EulerTarget = { x: 0, y: 0, z: 0 };
const _lLowerArm: EulerTarget = { x: 0, y: 0, z: 0 };
const _rLowerArm: EulerTarget = { x: 0, y: 0, z: 0 };
const _lHand: EulerTarget = { x: 0, y: 0, z: 0 };
const _rHand: EulerTarget = { x: 0, y: 0, z: 0 };
const _lShoulder: EulerTarget = { x: 0, y: 0, z: 0 };
const _rShoulder: EulerTarget = { x: 0, y: 0, z: 0 };

/**
 * Evaluate and apply full-body procedural mocap onto a VRM avatar.
 * Call once per frame before `vrm.update(dt)` when no external animation clip is active.
 */
export function applyVrmFullBodyMocap(vrm: VrmInstance, state: VrmMocapState): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;

  const dir = vrm.meta?.metaVersion === "0" ? -1 : 1;
  const t = state.elapsedSec;
  const gt = state.gestureAgeSec;
  const gw = Math.max(0, Math.min(1, state.gestureWeight));
  const talk = Math.max(0, Math.min(1, state.speechActivity));

  // Multi-harmonic organic breathing & slow contrapposto weight shift (~8.5s cycle)
  const breath = Math.sin(t * 1.45);
  const sway = Math.sin(t * 0.62);
  const weightShift = Math.sin(t * 0.74) * 0.72 + Math.sin(t * 0.33 + 1.1) * 0.28;

  // Gesture-specific body/hip/leg/head accents
  let gHipX = 0;
  let gHipRoll = 0;
  let gHipYaw = 0;
  let gKneeBounce = 0;
  let gInwardKnees = 0;
  let gSpinePitch = 0;
  let gSpineYaw = 0;
  let gHeadPitch = 0;
  let gHeadYaw = 0;
  let gHeadRoll = 0;
  let leftFingerScale = 1;
  let rightFingerScale = 1;

  // Base organic relaxed standing arms (VRM 1.0 authored angles)
  const talkWaveA = Math.sin(t * 4.4) * talk;
  const talkWaveB = Math.cos(t * 3.1 + 0.7) * talk;

  _lUpperArm.x = 0.06 + talk * 0.08;
  _lUpperArm.y = -0.05 - talk * 0.16 - talkWaveB * 0.05;
  _lUpperArm.z = -1.19 + breath * 0.018 + sway * 0.014 + talk * 0.12 + talkWaveA * 0.04;

  _rUpperArm.x = 0.06 + talk * 0.08;
  _rUpperArm.y = 0.05 + talk * 0.18 + talkWaveA * 0.06;
  _rUpperArm.z = 1.19 - breath * 0.018 + sway * 0.014 - talk * 0.14 + talkWaveB * 0.05;

  _lLowerArm.x = 0;
  _lLowerArm.y = -0.18 - talk * 0.42 - Math.abs(talkWaveB) * 0.12;
  _lLowerArm.z = -0.08 + talk * 0.12;

  _rLowerArm.x = 0;
  _rLowerArm.y = 0.18 + talk * 0.48 + Math.abs(talkWaveA) * 0.14;
  _rLowerArm.z = 0.08 - talk * 0.14;

  _lHand.x = talkWaveB * 0.08;
  _lHand.y = 0;
  _lHand.z = -0.06 + talkWaveA * 0.1;

  _rHand.x = talkWaveA * 0.08;
  _rHand.y = 0;
  _rHand.z = 0.06 - talkWaveB * 0.1;

  _lShoulder.x = 0;
  _lShoulder.y = -talk * 0.03;
  _lShoulder.z = breath * 0.016;

  _rShoulder.x = 0;
  _rShoulder.y = talk * 0.03;
  _rShoulder.z = -breath * 0.016;

  // Blend in active full-body expressive gesture smoothly by weight `gw`
  if (state.gestureId && gw > 0.001) {
    switch (state.gestureId) {
      case "greeting_wave": {
        const wave = Math.sin(gt * 5.6);
        const waveLag = Math.sin(gt * 5.6 - 0.55);
        // Right arm gracefully raised beside cheek, waving gently
        _rUpperArm.x = lerp(_rUpperArm.x, -0.14, gw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.30, gw);
        _rUpperArm.z = lerp(_rUpperArm.z, 0.32 + wave * 0.07, gw);
        _rLowerArm.x = lerp(_rLowerArm.x, 0.08, gw);
        _rLowerArm.y = lerp(_rLowerArm.y, 0.38, gw);
        _rLowerArm.z = lerp(_rLowerArm.z, -1.78 + wave * 0.24, gw);
        _rHand.z = lerp(_rHand.z, -0.12 + waveLag * 0.22, gw);
        _rShoulder.z = lerp(_rShoulder.z, -0.10, gw);
        // Left arm softly curved near waist
        _lUpperArm.y = lerp(_lUpperArm.y, -0.14, gw);
        _lUpperArm.z = lerp(_lUpperArm.z, -1.12, gw);
        _lLowerArm.y = lerp(_lLowerArm.y, -0.45, gw);
        _lLowerArm.z = lerp(_lLowerArm.z, 0.14, gw);
        gHipX = 0.022 * gw;
        gHipRoll = -0.035 * gw;
        gHeadRoll = 0.09 * gw;
        gHeadPitch = -0.04 * gw;
        rightFingerScale = lerp(1, 0.18, gw); // Open friendly waving hand
        break;
      }

      case "shy_fidget": {
        const fidget = Math.sin(gt * 3.4);
        // Both hands shyly drawn near chest/front with subtle tsundere fidget
        _lUpperArm.x = lerp(_lUpperArm.x, 0.18, gw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.48, gw);
        _lUpperArm.z = lerp(_lUpperArm.z, -1.04, gw);
        _lLowerArm.y = lerp(_lLowerArm.y, -1.32 + fidget * 0.05, gw);
        _lLowerArm.z = lerp(_lLowerArm.z, 0.42, gw);
        _lHand.z = lerp(_lHand.z, 0.14 + fidget * 0.08, gw);
        _lShoulder.y = lerp(_lShoulder.y, -0.10, gw);
        _lShoulder.z = lerp(_lShoulder.z, 0.06, gw);

        _rUpperArm.x = lerp(_rUpperArm.x, 0.18, gw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.48, gw);
        _rUpperArm.z = lerp(_rUpperArm.z, 1.04, gw);
        _rLowerArm.y = lerp(_rLowerArm.y, 1.32 - fidget * 0.05, gw);
        _rLowerArm.z = lerp(_rLowerArm.z, -0.42, gw);
        _rHand.z = lerp(_rHand.z, -0.14 - fidget * 0.08, gw);
        _rShoulder.y = lerp(_rShoulder.y, 0.10, gw);
        _rShoulder.z = lerp(_rShoulder.z, -0.06, gw);

        gHipX = -0.018 * gw;
        gHipYaw = -0.06 * gw;
        gInwardKnees = 0.08 * gw;
        gSpinePitch = 0.05 * gw;
        gHeadPitch = 0.08 * gw;
        gHeadYaw = 0.14 * gw;
        gHeadRoll = -0.08 * gw;
        leftFingerScale = lerp(1, 1.35, gw);
        rightFingerScale = lerp(1, 1.35, gw);
        break;
      }

      case "pout_hips": {
        // Tsundere hands-on-hips akimbo posture with hip pop
        _lUpperArm.x = lerp(_lUpperArm.x, 0.08, gw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.12, gw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.78, gw);
        _lLowerArm.y = lerp(_lLowerArm.y, -0.44, gw);
        _lLowerArm.z = lerp(_lLowerArm.z, -1.16, gw);
        _lHand.z = lerp(_lHand.z, 0.38, gw);
        _lShoulder.z = lerp(_lShoulder.z, 0.05, gw);

        _rUpperArm.x = lerp(_rUpperArm.x, 0.08, gw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.12, gw);
        _rUpperArm.z = lerp(_rUpperArm.z, 0.78, gw);
        _rLowerArm.y = lerp(_rLowerArm.y, 0.44, gw);
        _rLowerArm.z = lerp(_rLowerArm.z, 1.16, gw);
        _rHand.z = lerp(_rHand.z, -0.38, gw);
        _rShoulder.z = lerp(_rShoulder.z, -0.05, gw);

        gHipX = 0.036 * gw;
        gHipRoll = 0.065 * gw;
        gHipYaw = 0.10 * gw;
        gSpinePitch = -0.04 * gw;
        gSpineYaw = -0.06 * gw;
        gHeadPitch = -0.05 * gw;
        gHeadYaw = -0.15 * gw;
        gHeadRoll = 0.06 * gw;
        break;
      }

      case "happy_cheer": {
        const bounce = Math.abs(Math.sin(gt * 3.8));
        // Cheerful bent arms lifted near collarbone with soft joyful bounce
        _lUpperArm.x = lerp(_lUpperArm.x, -0.06, gw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.34, gw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.82 - bounce * 0.06, gw);
        _lLowerArm.y = lerp(_lLowerArm.y, -0.58, gw);
        _lLowerArm.z = lerp(_lLowerArm.z, 1.48 + bounce * 0.12, gw);
        _lHand.z = lerp(_lHand.z, 0.10, gw);

        _rUpperArm.x = lerp(_rUpperArm.x, -0.06, gw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.34, gw);
        _rUpperArm.z = lerp(_rUpperArm.z, 0.82 + bounce * 0.06, gw);
        _rLowerArm.y = lerp(_rLowerArm.y, 0.58, gw);
        _rLowerArm.z = lerp(_rLowerArm.z, -1.48 - bounce * 0.12, gw);
        _rHand.z = lerp(_rHand.z, -0.10, gw);

        gKneeBounce = bounce * 0.42 * gw;
        gSpinePitch = -0.03 * gw;
        gHeadPitch = -0.05 * gw;
        gHeadRoll = Math.sin(gt * 1.9) * 0.08 * gw;
        leftFingerScale = lerp(1, 1.45, gw);
        rightFingerScale = lerp(1, 1.45, gw);
        break;
      }

      case "thinking_chin": {
        // Right hand thoughtfully raised near chin, left arm folded across waist
        _rUpperArm.x = lerp(_rUpperArm.x, 0.08, gw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.58, gw);
        _rUpperArm.z = lerp(_rUpperArm.z, 0.62, gw);
        _rLowerArm.y = lerp(_rLowerArm.y, 0.72, gw);
        _rLowerArm.z = lerp(_rLowerArm.z, -1.62, gw);
        _rHand.z = lerp(_rHand.z, -0.18, gw);

        _lUpperArm.x = lerp(_lUpperArm.x, 0.14, gw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.34, gw);
        _lUpperArm.z = lerp(_lUpperArm.z, -1.08, gw);
        _lLowerArm.y = lerp(_lLowerArm.y, -1.12, gw);
        _lLowerArm.z = lerp(_lLowerArm.z, 0.24, gw);

        gHipX = -0.022 * gw;
        gHipRoll = -0.03 * gw;
        gHeadPitch = 0.06 * gw;
        gHeadYaw = -0.10 * gw;
        gHeadRoll = 0.11 * gw;
        rightFingerScale = lerp(1, 0.75, gw);
        break;
      }

      case "playful_tilt": {
        const tease = Math.sin(gt * 2.6);
        // Left hand sassily on hip, right hand playfully raised & gesturing
        _lUpperArm.y = lerp(_lUpperArm.y, -0.12, gw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.80, gw);
        _lLowerArm.y = lerp(_lLowerArm.y, -0.40, gw);
        _lLowerArm.z = lerp(_lLowerArm.z, -1.12, gw);
        _lHand.z = lerp(_lHand.z, 0.34, gw);

        _rUpperArm.y = lerp(_rUpperArm.y, 0.30, gw);
        _rUpperArm.z = lerp(_rUpperArm.z, 0.72 + tease * 0.06, gw);
        _rLowerArm.y = lerp(_rLowerArm.y, 0.52, gw);
        _rLowerArm.z = lerp(_rLowerArm.z, -1.02 + tease * 0.14, gw);
        _rHand.z = lerp(_rHand.z, 0.16 + tease * 0.12, gw);

        gHipX = 0.032 * gw;
        gHipRoll = 0.055 * gw;
        gHipYaw = -0.08 * gw;
        gHeadRoll = -0.12 * gw;
        gHeadYaw = 0.08 * gw;
        rightFingerScale = lerp(1, 0.45, gw);
        break;
      }
    }
  }

  // --- 1. HIPS & FULL-BODY WEIGHT SHIFT (Contrapposto) ---
  const hipShift = weightShift * 0.022 + gHipX;
  const hipRoll = -weightShift * 0.034 + gHipRoll;
  const hipYaw = weightShift * 0.042 + gHipYaw;

  const hipsNode = humanoid.getNormalizedBoneNode("hips");
  if (hipsNode) {
    if (state.hipsRestPos) {
      hipsNode.position.set(
        state.hipsRestPos.x + hipShift * dir,
        state.hipsRestPos.y - Math.abs(hipShift) * 0.28 - gKneeBounce * 0.024,
        state.hipsRestPos.z,
      );
    }
    hipsNode.rotation.set(
      (gKneeBounce * 0.05) * dir,
      hipYaw,
      hipRoll * dir,
    );
  }

  // --- 2. GROUNDED LEGS, KNEES & FEET (Counter-articulate with hip weight shift) ---
  // When weight shifts right (hipShift < 0), left leg relaxes with soft knee bend and vice versa.
  const relaxLeft = Math.max(0, -weightShift) * 0.65 + (gHipX > 0 ? 0.25 * gw : 0);
  const relaxRight = Math.max(0, weightShift) * 0.65 + (gHipX < 0 ? 0.25 * gw : 0);

  applyNormalizedBone(
    vrm,
    "leftUpperLeg",
    -0.03 - relaxLeft * 0.08 - gKneeBounce * 0.14,
    0.05 - gInwardKnees,
    0.03 + hipShift * 1.15 - gInwardKnees * 0.45,
    dir,
  );
  applyNormalizedBone(
    vrm,
    "leftLowerLeg",
    0.05 + relaxLeft * 0.16 + gKneeBounce * 0.28,
    0,
    0,
    dir,
  );
  applyNormalizedBone(
    vrm,
    "leftFoot",
    -0.02 - relaxLeft * 0.07 - gKneeBounce * 0.13,
    0,
    -hipShift * 0.85,
    dir,
  );

  applyNormalizedBone(
    vrm,
    "rightUpperLeg",
    -0.03 - relaxRight * 0.08 - gKneeBounce * 0.14,
    -0.05 + gInwardKnees,
    -0.03 + hipShift * 1.15 + gInwardKnees * 0.45,
    dir,
  );
  applyNormalizedBone(
    vrm,
    "rightLowerLeg",
    0.05 + relaxRight * 0.16 + gKneeBounce * 0.28,
    0,
    0,
    dir,
  );
  applyNormalizedBone(
    vrm,
    "rightFoot",
    -0.02 - relaxRight * 0.07 - gKneeBounce * 0.13,
    0,
    -hipShift * 0.85,
    dir,
  );

  // --- 3. SPINE, CHEST, NECK & HEAD (Counter-balance hips + breathing + look-at) ---
  applyNormalizedBone(
    vrm,
    "spine",
    breath * 0.015 + state.reactSpinePitch * 0.5 + gSpinePitch * 0.6,
    -hipYaw * 0.35 + gSpineYaw * 0.5,
    -hipRoll * 0.45 + sway * 0.014,
    dir,
  );
  applyNormalizedBone(
    vrm,
    "chest",
    breath * 0.018 + state.reactSpinePitch * 0.5 + gSpinePitch * 0.4,
    -hipYaw * 0.35 + sway * 0.018 + gSpineYaw * 0.5,
    -hipRoll * 0.35,
    dir,
  );
  applyNormalizedBone(
    vrm,
    "neck",
    -state.pointerSmoothY * 0.08 + state.reactHeadPitch * 0.4 + gHeadPitch * 0.4,
    state.pointerSmoothX * 0.14 + state.reactHeadYaw * 0.4 + gHeadYaw * 0.4,
    gHeadRoll * 0.35,
    dir,
  );
  applyNormalizedBone(
    vrm,
    "head",
    -state.pointerSmoothY * 0.10 + breath * 0.01 + state.reactHeadPitch * 0.6 + gHeadPitch * 0.6,
    state.pointerSmoothX * 0.18 + sway * 0.02 + state.reactHeadYaw * 0.6 + gHeadYaw * 0.6,
    sway * 0.015 + state.reactHeadRoll + gHeadRoll * 0.65,
    dir,
  );

  // --- 4. SHOULDERS, ARMS & WRISTS ---
  applyNormalizedBone(vrm, "leftShoulder", _lShoulder.x, _lShoulder.y, _lShoulder.z, dir);
  applyNormalizedBone(vrm, "rightShoulder", _rShoulder.x, _rShoulder.y, _rShoulder.z, dir);
  applyNormalizedBone(vrm, "leftUpperArm", _lUpperArm.x, _lUpperArm.y, _lUpperArm.z, dir);
  applyNormalizedBone(vrm, "rightUpperArm", _rUpperArm.x, _rUpperArm.y, _rUpperArm.z, dir);
  applyNormalizedBone(vrm, "leftLowerArm", _lLowerArm.x, _lLowerArm.y, _lLowerArm.z, dir);
  applyNormalizedBone(vrm, "rightLowerArm", _rLowerArm.x, _rLowerArm.y, _rLowerArm.z, dir);
  applyNormalizedBone(vrm, "leftHand", _lHand.x, _lHand.y, _lHand.z, dir);
  applyNormalizedBone(vrm, "rightHand", _rHand.x, _rHand.y, _rHand.z, dir);

  // --- 5. NATURAL CURLED FINGERS (All 10 fingers relaxed instead of flat paddles) ---
  const lCurl = leftFingerScale * (1 - talk * 0.25);
  const rCurl = rightFingerScale * (1 - talk * 0.25);
  for (let i = 0; i < LEFT_FINGERS.length; i++) {
    const f = LEFT_FINGERS[i];
    applyNormalizedBone(vrm, f.bone, 0, 0, -f.curl * lCurl, dir);
  }
  for (let i = 0; i < RIGHT_FINGERS.length; i++) {
    const f = RIGHT_FINGERS[i];
    applyNormalizedBone(vrm, f.bone, 0, 0, f.curl * rCurl, dir);
  }
  applyNormalizedBone(vrm, "leftThumbMetacarpal", 0.08, -0.26 * lCurl, -0.14 * lCurl, dir);
  applyNormalizedBone(vrm, "leftThumbProximal", 0, -0.18 * lCurl, -0.12 * lCurl, dir);
  applyNormalizedBone(vrm, "rightThumbMetacarpal", 0.08, 0.26 * rCurl, 0.14 * rCurl, dir);
  applyNormalizedBone(vrm, "rightThumbProximal", 0, 0.18 * rCurl, 0.12 * rCurl, dir);
}
