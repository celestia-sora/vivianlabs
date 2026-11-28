/**
 * Full-Body Procedural Mocap & Semantic Pose Controller for VRM 0.x & 1.0 Avatars.
 *
 * Drives all 24 semantic poses from `lib/avatar-3d-poses.ts` with:
 *  - Zero-twist 1-DOF anatomical elbow kinematics & strict per-bone joint-limit clamping
 *  - Gaze-first -> head-second -> arm-third overlapping entry timing
 *  - Per-bone exponential smoothing so switching between any two poses or emotions never snaps
 *  - Subtle, non-mechanical breathing (tiny chest/spine, zero shoulder pumping)
 *  - Grounded contrapposto weight distribution & expressive finger shapes (relaxed, open, fist, point, peace)
 */

import type { VRM as VrmInstance, VRMHumanBoneName } from "@pixiv/three-vrm";
import type { AvatarEmotion } from "./avatar-emotion.ts";
import {
  getSemanticPoseDefinition,
  resolveConversationPoseIntent,
  resolveSemanticPose,
  SEMANTIC_POSE_LIBRARY,
  type GazeTargetMode,
  type SemanticPoseId,
} from "./avatar-3d-poses.ts";

export type VrmGestureId = SemanticPoseId;

export interface BuiltInVrmGesture {
  id: SemanticPoseId;
  group: string;
  label: string;
  durationSec: number;
  loopable: boolean;
}

export const BUILT_IN_VRM_MOCAP_GROUP = "ท่าทางประจำวัน";

/** All manually previewable semantic poses (prop-dependent poses are excluded from manual UI buttons). */
export const BUILT_IN_VRM_GESTURES: readonly BuiltInVrmGesture[] = SEMANTIC_POSE_LIBRARY
  .filter((def) => def.showInManualUi)
  .map((def) => ({
    id: def.id,
    group: def.categoryLabelTh,
    label: def.labelTh,
    durationSec: def.holdSec,
    loopable: def.loopable,
  }));

export const BUILT_IN_VRM_MOCAP_GROUPS: ReadonlySet<string> = new Set(
  BUILT_IN_VRM_GESTURES.map((g) => g.group),
);

export function isBuiltInVrmMotionGroup(group: string): boolean {
  return BUILT_IN_VRM_MOCAP_GROUPS.has(group) || group === BUILT_IN_VRM_MOCAP_GROUP;
}

export function emotionToBuiltInGesture(emotion: AvatarEmotion): SemanticPoseId | null {
  const intent = resolveConversationPoseIntent({ emotion });
  const resolved = resolveSemanticPose(intent);
  return resolved.resolvedId;
}

export interface VrmMocapState {
  elapsedSec: number;
  dt: number;
  hipsRestPos: { x: number; y: number; z: number } | null;
  pointerSmoothX: number;
  pointerSmoothY: number;
  mouthCurrent: number;
  speechActivity: number;
  /** Currently active semantic pose (null or "relaxed_idle" = organic living idle stance). */
  gestureId: SemanticPoseId | null;
  /** Smoothly blended gesture weight [0, 1]. */
  gestureWeight: number;
  /** Time since current gesture began (seconds). */
  gestureAgeSec: number;
  /** Optional pose intensity multiplier [0.15, 1.25]. */
  gestureIntensity?: number;
  /** Additional procedural head/spine reaction offsets from emotion scorer. */
  reactHeadPitch: number;
  reactHeadYaw: number;
  reactHeadRoll: number;
  reactSpinePitch: number;
  /** When true, bypass smoothing and snap directly to target pose (used on initial load). */
  snapImmediate?: boolean;
}

interface EulerTarget {
  x: number;
  y: number;
  z: number;
}

type HandShape = "relaxed" | "open" | "fist" | "peace" | "point";

interface FingerSpec {
  bone: VRMHumanBoneName;
  finger: "index" | "middle" | "ring" | "little";
  curl: number;
}

interface JointLimits {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Strict anatomical joint ranges (radians, VRM 1.0 normalized convention) to prevent broken joints. */
const JOINT_LIMITS: Partial<Record<VRMHumanBoneName, JointLimits>> = {
  hips: { minX: -0.28, maxX: 0.28, minY: -0.35, maxY: 0.35, minZ: -0.18, maxZ: 0.18 },
  spine: { minX: -0.22, maxX: 0.28, minY: -0.30, maxY: 0.30, minZ: -0.18, maxZ: 0.18 },
  chest: { minX: -0.22, maxX: 0.25, minY: -0.30, maxY: 0.30, minZ: -0.16, maxZ: 0.16 },
  neck: { minX: -0.32, maxX: 0.34, minY: -0.45, maxY: 0.45, minZ: -0.24, maxZ: 0.24 },
  head: { minX: -0.34, maxX: 0.36, minY: -0.52, maxY: 0.52, minZ: -0.30, maxZ: 0.30 },
  leftShoulder: { minX: -0.20, maxX: 0.20, minY: -0.22, maxY: 0.22, minZ: -0.16, maxZ: 0.22 },
  rightShoulder: { minX: -0.20, maxX: 0.20, minY: -0.22, maxY: 0.22, minZ: -0.22, maxZ: 0.16 },
  leftUpperArm: { minX: -1.45, maxX: 1.55, minY: -1.35, maxY: 0.85, minZ: -1.48, maxZ: 0.85 },
  rightUpperArm: { minX: -1.45, maxX: 1.55, minY: -0.85, maxY: 1.35, minZ: -0.85, maxZ: 1.48 },
  // 1-DOF anatomical elbow hinge: left bends negative Y, right bends positive Y (zero hyperextension!)
  leftLowerArm: { minX: -0.15, maxX: 0.15, minY: -2.40, maxY: -0.04, minZ: -0.18, maxZ: 0.18 },
  rightLowerArm: { minX: -0.15, maxX: 0.15, minY: 0.04, maxY: 2.40, minZ: -0.18, maxZ: 0.18 },
  leftHand: { minX: -0.45, maxX: 0.45, minY: -0.45, maxY: 0.45, minZ: -0.55, maxZ: 0.55 },
  rightHand: { minX: -0.45, maxX: 0.45, minY: -0.45, maxY: 0.45, minZ: -0.55, maxZ: 0.55 },
  leftUpperLeg: { minX: -0.55, maxX: 0.28, minY: -0.32, maxY: 0.32, minZ: -0.20, maxZ: 0.32 },
  rightUpperLeg: { minX: -0.55, maxX: 0.28, minY: -0.32, maxY: 0.32, minZ: -0.32, maxZ: 0.20 },
  leftLowerLeg: { minX: 0.0, maxX: 1.15, minY: -0.08, maxY: 0.08, minZ: -0.05, maxZ: 0.05 },
  rightLowerLeg: { minX: 0.0, maxX: 1.15, minY: -0.08, maxY: 0.08, minZ: -0.05, maxZ: 0.05 },
  leftFoot: { minX: -0.42, maxX: 0.35, minY: -0.22, maxY: 0.22, minZ: -0.22, maxZ: 0.22 },
  rightFoot: { minX: -0.42, maxX: 0.35, minY: -0.22, maxY: 0.22, minZ: -0.22, maxZ: 0.22 },
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep01(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/**
 * Compute smooth eye/gaze offset (in normalized [-1, 1] look-at space) for the active pose's gaze mode.
 */
export function getPoseGazeOffset(
  gazeMode: GazeTargetMode,
  elapsedSec: number,
  gestureAgeSec: number,
  weight: number,
): { x: number; y: number } {
  if (weight <= 0.001) return { x: 0, y: 0 };
  switch (gazeMode) {
    case "away_up":
      return { x: -0.36 * weight, y: 0.32 * weight };
    case "away_side": {
      // Briefly look away, then softly glance back toward user
      const glanceBack = 0.55 + 0.45 * Math.cos(Math.min(Math.PI, gestureAgeSec * 0.9));
      return { x: 0.42 * glanceBack * weight, y: -0.18 * weight };
    }
    case "down_soft":
      return { x: 0.06 * Math.sin(elapsedSec * 0.6) * weight, y: -0.34 * weight };
    case "scan": {
      // Smooth gaze-first dwell left -> center -> right -> center
      const phase = Math.sin(gestureAgeSec * 0.85);
      const shaped = Math.sign(phase) * Math.pow(Math.abs(phase), 0.72);
      return { x: shaped * 0.62 * weight, y: Math.sin(gestureAgeSec * 0.42) * 0.16 * weight };
    }
    case "point_target":
      return { x: -0.34 * weight, y: 0.08 * weight };
    default:
      return { x: 0, y: 0 };
  }
}

/** Per-VRM smoothed bone pose buffer so switching between ANY poses or emotions never snaps. */
interface VrmSmoothCache {
  bones: Map<string, EulerTarget>;
  hipsPos: EulerTarget | null;
}

const _smoothCacheByVrm = new WeakMap<object, VrmSmoothCache>();

function getSmoothCache(vrm: VrmInstance): VrmSmoothCache {
  let cache = _smoothCacheByVrm.get(vrm as unknown as object);
  if (!cache) {
    cache = { bones: new Map(), hipsPos: null };
    _smoothCacheByVrm.set(vrm as unknown as object, cache);
  }
  return cache;
}

export function resetVrmMocapSmoothing(vrm: VrmInstance): void {
  _smoothCacheByVrm.delete(vrm as unknown as object);
}

function applySmoothedNormalizedBone(
  vrm: VrmInstance,
  cache: VrmSmoothCache,
  boneName: VRMHumanBoneName,
  rx: number,
  ry: number,
  rz: number,
  dir: number,
  lambda: number,
  dt: number,
  snap: boolean,
): void {
  const node = vrm.humanoid?.getNormalizedBoneNode(boneName);
  if (!node) return;

  const lim = JOINT_LIMITS[boneName];
  const cx = lim ? clamp(rx, lim.minX, lim.maxX) : rx;
  const cy = lim ? clamp(ry, lim.minY, lim.maxY) : ry;
  const cz = lim ? clamp(rz, lim.minZ, lim.maxZ) : rz;

  let smoothed = cache.bones.get(boneName);
  if (!smoothed || snap) {
    if (!smoothed) {
      smoothed = { x: cx, y: cy, z: cz };
      cache.bones.set(boneName, smoothed);
    } else {
      smoothed.x = cx;
      smoothed.y = cy;
      smoothed.z = cz;
    }
  } else {
    smoothed.x = damp(smoothed.x, cx, lambda, dt);
    smoothed.y = damp(smoothed.y, cy, lambda, dt);
    smoothed.z = damp(smoothed.z, cz, lambda, dt);
  }
  node.rotation.set(smoothed.x * dir, smoothed.y, smoothed.z * dir);
}

const LEFT_FINGERS: ReadonlyArray<FingerSpec> = [
  { bone: "leftIndexProximal", finger: "index", curl: 0.22 },
  { bone: "leftIndexIntermediate", finger: "index", curl: 0.28 },
  { bone: "leftIndexDistal", finger: "index", curl: 0.16 },
  { bone: "leftMiddleProximal", finger: "middle", curl: 0.28 },
  { bone: "leftMiddleIntermediate", finger: "middle", curl: 0.34 },
  { bone: "leftMiddleDistal", finger: "middle", curl: 0.20 },
  { bone: "leftRingProximal", finger: "ring", curl: 0.34 },
  { bone: "leftRingIntermediate", finger: "ring", curl: 0.38 },
  { bone: "leftRingDistal", finger: "ring", curl: 0.22 },
  { bone: "leftLittleProximal", finger: "little", curl: 0.40 },
  { bone: "leftLittleIntermediate", finger: "little", curl: 0.44 },
  { bone: "leftLittleDistal", finger: "little", curl: 0.26 },
];

const RIGHT_FINGERS: ReadonlyArray<FingerSpec> = [
  { bone: "rightIndexProximal", finger: "index", curl: 0.22 },
  { bone: "rightIndexIntermediate", finger: "index", curl: 0.28 },
  { bone: "rightIndexDistal", finger: "index", curl: 0.16 },
  { bone: "rightMiddleProximal", finger: "middle", curl: 0.28 },
  { bone: "rightMiddleIntermediate", finger: "middle", curl: 0.34 },
  { bone: "rightMiddleDistal", finger: "middle", curl: 0.20 },
  { bone: "rightRingProximal", finger: "ring", curl: 0.34 },
  { bone: "rightRingIntermediate", finger: "ring", curl: 0.38 },
  { bone: "rightRingDistal", finger: "ring", curl: 0.22 },
  { bone: "rightLittleProximal", finger: "little", curl: 0.40 },
  { bone: "rightLittleIntermediate", finger: "little", curl: 0.44 },
  { bone: "rightLittleDistal", finger: "little", curl: 0.26 },
];

function fingerCurlForShape(spec: FingerSpec, shape: HandShape, scale: number): number {
  switch (shape) {
    case "open":
      return spec.curl * 0.24;
    case "fist":
      return Math.min(1.42, spec.curl * 3.0 + 0.34);
    case "peace":
      if (spec.finger === "index" || spec.finger === "middle") return 0.05;
      return Math.min(1.42, spec.curl * 2.8 + 0.32);
    case "point":
      if (spec.finger === "index") return 0.05;
      return Math.min(1.38, spec.curl * 2.5 + 0.24);
    default:
      return spec.curl * scale;
  }
}

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
 * Call once per frame before `physics.updateVrm(...)` when no external clip is active.
 */
export function applyVrmFullBodyMocap(vrm: VrmInstance, state: VrmMocapState): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;

  const dir = vrm.meta?.metaVersion === "0" ? -1 : 1;
  const t = state.elapsedSec;
  const dt = Math.max(0.001, Math.min(0.05, state.dt || 0.016));
  const gt = state.gestureAgeSec;
  const rawWeight = smoothstep01(state.gestureWeight);
  const intensity = clamp(state.gestureIntensity ?? 1.0, 0.35, 1.25);
  const gw = rawWeight;
  const talk = clamp(state.speechActivity, 0, 1);
  const snap = Boolean(state.snapImmediate);
  const cache = getSmoothCache(vrm);

  // Resolve pose ID safely (handles legacy aliases & prop-dependent fallbacks)
  const activePoseId: SemanticPoseId = state.gestureId
    ? resolveSemanticPose({ pose_id: state.gestureId }).resolvedId
    : "relaxed_idle";
  const def = getSemanticPoseDefinition(activePoseId);

  // Gaze-first -> head-second -> arm-third natural onset envelope
  const headLead = gw * smoothstep01((gt + 0.08) / Math.max(0.18, def.blendInSec * 0.85));
  const armLead = gw * smoothstep01(gt / Math.max(0.22, def.blendInSec));

  // Subtle non-mechanical breathing (tiny chest/spine, ZERO shoulder pumping)
  const breath = Math.sin(t * 1.25) * 0.72 + Math.sin(t * 0.58 + 0.9) * 0.28;
  // Non-pendulum idle posture drift (slow plateau-like shift rather than constant sine swing)
  const slowWave = Math.sin(t * 0.27) * 0.65 + Math.sin(t * 0.13 + 1.4) * 0.35;
  const weightShift = Math.tanh(slowWave * 1.35) * 0.72;
  const microSway = Math.sin(t * 0.43 + 0.4) * 0.5;

  // Pose-specific accents
  let gHipX = 0;
  let gHipRoll = 0;
  let gHipYaw = 0;
  let gKneeBounce = 0;
  let gInwardKnees = 0;
  let gLegBias = 0;
  let gSpinePitch = 0;
  let gSpineYaw = 0;
  let gHeadPitch = 0;
  let gHeadYaw = 0;
  let gHeadRoll = 0;
  let leftFingerScale = 1;
  let rightFingerScale = 1;
  let leftHandShape: HandShape = "relaxed";
  let rightHandShape: HandShape = "relaxed";

  // Base relaxed standing arms (VRM 1.0 authored angles; zero forced shoulder pumping)
  const talkWaveA = Math.sin(t * 3.8) * talk;
  const talkWaveB = Math.cos(t * 2.7 + 0.7) * talk;

  _lUpperArm.x = 0.05 + talk * 0.05;
  _lUpperArm.y = -0.05 - talk * 0.12 - talkWaveB * 0.03;
  _lUpperArm.z = -1.21 + breath * 0.008 + talk * 0.08 + talkWaveA * 0.025;

  _rUpperArm.x = 0.05 + talk * 0.05;
  _rUpperArm.y = 0.05 + talk * 0.14 + talkWaveA * 0.04;
  _rUpperArm.z = 1.21 - breath * 0.008 - talk * 0.10 + talkWaveB * 0.03;

  _lLowerArm.x = 0;
  _lLowerArm.y = -0.18 - talk * 0.34 - Math.abs(talkWaveB) * 0.08;
  _lLowerArm.z = 0;

  _rLowerArm.x = 0;
  _rLowerArm.y = 0.18 + talk * 0.38 + Math.abs(talkWaveA) * 0.10;
  _rLowerArm.z = 0;

  _lHand.x = talkWaveB * 0.05;
  _lHand.y = 0;
  _lHand.z = -0.05 + talkWaveA * 0.07;

  _rHand.x = talkWaveA * 0.05;
  _rHand.y = 0;
  _rHand.z = 0.05 - talkWaveB * 0.07;

  _lShoulder.x = 0;
  _lShoulder.y = -talk * 0.02;
  _lShoulder.z = 0;

  _rShoulder.x = 0;
  _rShoulder.y = talk * 0.02;
  _rShoulder.z = 0;

  // Apply semantic pose targets (all 24 IDs supported via canonical switch + safe fallbacks)
  if (gw > 0.001 && activePoseId !== "relaxed_idle" && activePoseId !== "natural_breathing") {
    const aw = armLead * Math.min(1, intensity);
    const hw = headLead * Math.min(1.1, intensity);

    switch (activePoseId) {
      case "weight_shifting": {
        const shiftCycle = Math.tanh(Math.sin(gt * 0.65) * 1.4);
        gHipX = shiftCycle * 0.036 * gw;
        gHipRoll = -shiftCycle * 0.055 * gw;
        gHipYaw = shiftCycle * 0.06 * gw;
        gLegBias = -shiftCycle * 0.9 * gw;
        gHeadRoll = shiftCycle * 0.045 * hw;
        break;
      }

      case "looking_around": {
        const scan = Math.sin(gt * 0.85);
        const shaped = Math.sign(scan) * Math.pow(Math.abs(scan), 0.72);
        // Gaze leads first, then head follows smoothly, upper torso follows slightly
        gHeadYaw = shaped * 0.28 * hw;
        gHeadPitch = Math.sin(gt * 0.42) * 0.08 * hw;
        gHeadRoll = shaped * 0.05 * hw;
        gSpineYaw = shaped * 0.10 * gw;
        break;
      }

      case "explaining": {
        const phrase = Math.sin(gt * 2.6) * (0.55 + 0.45 * Math.sin(gt * 0.9));
        // Upright engaged posture; right open palm gesturing softly at chest level
        _lUpperArm.x = lerp(_lUpperArm.x, 0.869, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.723, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.649, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -1.031, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, 0.044, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.218 + phrase * 0.06, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 1.04 + phrase * 0.05, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 1.828 - phrase * 0.14, aw);
        _rHand.x = lerp(_rHand.x, 0.12, aw);
        _rHand.z = lerp(_rHand.z, 0.06 + phrase * 0.14, aw);

        gSpinePitch = 0.045 * gw;
        gHipX = 0.020 * gw;
        gLegBias = 0.55 * gw;
        gHeadPitch = (0.02 + phrase * 0.03) * hw;
        gHeadRoll = -0.05 * hw;
        rightHandShape = "open";
        break;
      }

      case "attentive_listening": {
        // Occasional subtle listening nod (~every 3.5s, NOT constant bobbing)
        const nodPhase = gt % 3.8;
        const subtleNod = nodPhase > 1.2 && nodPhase < 1.85 ? Math.sin(((nodPhase - 1.2) / 0.65) * Math.PI) * 0.065 : 0;
        gHipX = 0.018 * gw;
        gHipRoll = -0.025 * gw;
        gLegBias = 0.45 * gw;
        gSpinePitch = 0.03 * gw;
        gHeadRoll = 0.125 * hw; // ~7 degrees natural attentive head tilt
        gHeadPitch = (0.02 + subtleNod) * hw;
        break;
      }

      case "gentle_nodding": {
        // Two discrete calm nods then rest (never a continuous mechanical loop)
        const cycle = gt % 3.2;
        const nod1 = cycle < 0.55 ? Math.sin((cycle / 0.55) * Math.PI) * 0.13 : 0;
        const nod2 = cycle >= 0.65 && cycle < 1.15 ? Math.sin(((cycle - 0.65) / 0.50) * Math.PI) * 0.095 : 0;
        gHeadPitch = (nod1 + nod2) * hw;
        gHeadRoll = 0.04 * hw;
        break;
      }

      case "thinking": {
        const tap = Math.sin(gt * 1.8);
        // Gaze shifts up-away first -> head tilts -> R hand approaches chin cleanly without clipping
        _lUpperArm.x = lerp(_lUpperArm.x, 0.296, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.771, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -1.103, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -1.588, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, -0.735, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.676, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 1.469, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 2.35 + tap * 0.02, aw);
        _rHand.x = lerp(_rHand.x, 0.08, aw);
        _rHand.z = lerp(_rHand.z, -0.10, aw);

        gHipX = -0.026 * gw;
        gHipRoll = -0.036 * gw;
        gLegBias = -0.75 * gw;
        gHeadPitch = 0.04 * hw;
        gHeadYaw = -0.12 * hw;
        gHeadRoll = 0.12 * hw;
        rightHandShape = "point";
        break;
      }

      case "genuine_happiness": {
        const lift = Math.abs(Math.sin(gt * 3.2)) * 0.55;
        // Open joyful reaction without wild arm flinging
        _lUpperArm.x = lerp(_lUpperArm.x, 0.233, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.303, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.969 - lift * 0.04, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -2.05, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, -1.12, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.42, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 0.28 - lift * 0.08, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 1.78 - lift * 0.08, aw);
        _rHand.z = lerp(_rHand.z, -0.08, aw);

        gKneeBounce = lift * 0.32 * gw;
        gHipX = -0.022 * gw;
        gHipRoll = -0.036 * gw;
        gLegBias = -0.65 * gw;
        gSpinePitch = -0.035 * gw;
        gHeadPitch = -0.05 * hw;
        gHeadRoll = Math.sin(gt * 1.7) * 0.075 * hw;
        leftHandShape = "relaxed";
        rightHandShape = "fist";
        break;
      }

      case "shy_embarrassed": {
        const fidget = Math.sin(gt * 2.8);
        const fidgetAlt = Math.cos(gt * 2.1);
        // Restrained bashful posture: fingertips lightly meet in front, glance away then back
        _lUpperArm.x = lerp(_lUpperArm.x, 0.168, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.813, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -1.225, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -1.467 + fidget * 0.045, aw);
        _lHand.z = lerp(_lHand.z, 0.08 + fidgetAlt * 0.07, aw);
        _lShoulder.y = lerp(_lShoulder.y, -0.08, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, 0.168, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.813, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 1.225, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 1.467 - fidget * 0.045, aw);
        _rHand.z = lerp(_rHand.z, -0.08 - fidgetAlt * 0.07, aw);
        _rShoulder.y = lerp(_rShoulder.y, 0.08, aw);

        gHipX = -0.022 * gw;
        gHipYaw = -0.07 * gw;
        gInwardKnees = 0.11 * gw;
        gLegBias = -0.55 * gw;
        gSpinePitch = 0.045 * gw;
        gHeadPitch = 0.08 * hw;
        gHeadYaw = 0.15 * hw;
        gHeadRoll = -0.08 * hw;
        leftFingerScale = lerp(1, 1.25, aw);
        rightFingerScale = lerp(1, 1.25, aw);
        break;
      }

      case "confused": {
        // Mild head tilt + small open-palm questioning gesture on right hand
        _lUpperArm.x = lerp(_lUpperArm.x, 1.06, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.878, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.498, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -0.867, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, 0.091, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, -0.083, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 0.945, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 1.822, aw);
        _rHand.x = lerp(_rHand.x, 0.18, aw);
        _rHand.z = lerp(_rHand.z, 0.10, aw);

        gHipX = -0.016 * gw;
        gLegBias = -0.45 * gw;
        gHeadRoll = 0.17 * hw;
        gHeadYaw = -0.06 * hw;
        gHeadPitch = 0.03 * hw;
        rightHandShape = "open";
        break;
      }

      case "sad_concerned": {
        // Calm, restrained empathetic stance — less movement, softened shoulders, hands together low
        _lUpperArm.x = lerp(_lUpperArm.x, 0.285, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.799, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -1.106, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -1.38, aw);
        _lShoulder.z = lerp(_lShoulder.z, -0.04, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, 0.285, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.799, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 1.106, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 1.38, aw);
        _rShoulder.z = lerp(_rShoulder.z, 0.04, aw);

        gSpinePitch = 0.065 * gw;
        gInwardKnees = 0.06 * gw;
        gHeadPitch = 0.12 * hw;
        gHeadRoll = 0.065 * hw;
        break;
      }

      case "surprised": {
        const recoil = Math.exp(-gt * 1.4);
        // Controlled recoil; relaxed open hands rise to chest/collarbone level (never blocking face)
        _lUpperArm.x = lerp(_lUpperArm.x, -0.143, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.237, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -1.118 - recoil * 0.06, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -2.225, aw);
        _lShoulder.z = lerp(_lShoulder.z, 0.08 * recoil, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, -0.143, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.237, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 1.118 + recoil * 0.06, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 2.225, aw);
        _rShoulder.z = lerp(_rShoulder.z, -0.08 * recoil, aw);

        gKneeBounce = 0.14 * recoil * gw;
        gSpinePitch = -0.075 * gw;
        gHeadPitch = -0.06 * hw;
        leftHandShape = "open";
        rightHandShape = "open";
        break;
      }

      case "playful_teasing": {
        const tease = Math.sin(gt * 2.5);
        // Asymmetric confident stance: L hand on hip, R playful peace/index gesture beside cheek
        _lUpperArm.x = lerp(_lUpperArm.x, 1.147, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.796, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.47, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -1.352, aw);
        _lHand.z = lerp(_lHand.z, 0.22, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, -0.868, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.233, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 1.044 + tease * 0.03, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 2.34 + tease * 0.05, aw);
        _rHand.x = lerp(_rHand.x, 0.14, aw);
        _rHand.y = lerp(_rHand.y, 0.14, aw);
        _rHand.z = lerp(_rHand.z, -0.08 + tease * 0.07, aw);

        gHipX = 0.038 * gw;
        gHipRoll = 0.062 * gw;
        gHipYaw = -0.10 * gw;
        gLegBias = 0.95 * gw;
        gSpineYaw = 0.06 * gw;
        gHeadRoll = -0.13 * hw;
        gHeadYaw = 0.08 * hw;
        rightHandShape = "peace";
        break;
      }

      case "greeting_wave": {
        const wave = Math.sin(gt * 4.8);
        const waveLag = Math.sin(gt * 4.8 - 0.55);
        // Friendly shoulder-height wave with natural wrist lag; L arm softly relaxed
        _lUpperArm.x = lerp(_lUpperArm.x, 1.06, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.878, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.498, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -0.867, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, -1.097, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, -0.058, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 0.123 + wave * 0.05, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 2.044 + wave * 0.18, aw);
        _rHand.x = lerp(_rHand.x, 0.08, aw);
        _rHand.z = lerp(_rHand.z, -0.06 + waveLag * 0.22, aw);

        gHipX = 0.024 * gw;
        gHipRoll = -0.038 * gw;
        gLegBias = 0.70 * gw;
        gHeadRoll = (0.08 + wave * 0.015) * hw;
        gHeadPitch = -0.03 * hw;
        rightHandShape = "open";
        break;
      }

      case "pointing": {
        // Reach smoothly forward with index finger extended, eyes & head oriented to target
        _lUpperArm.x = lerp(_lUpperArm.x, 1.155, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.897, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.423, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -0.871, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, -0.72, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.373, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 0.933, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 1.178, aw);
        _rHand.z = lerp(_rHand.z, -0.04, aw);

        gSpineYaw = -0.08 * gw;
        gHipX = -0.020 * gw;
        gLegBias = -0.60 * gw;
        gHeadYaw = -0.14 * hw;
        gHeadPitch = -0.02 * hw;
        rightHandShape = "point";
        break;
      }

      case "arms_crossed": {
        // Balanced confident/reflective folded-arms stance (elbows cleanly outside ribs, hands folded inward)
        _lUpperArm.x = lerp(_lUpperArm.x, 0.36, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.92, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -1.16, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -1.96, aw);
        _lHand.z = lerp(_lHand.z, 0.14, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, 0.28, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.94, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 1.18, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 2.04, aw);
        _rHand.z = lerp(_rHand.z, -0.14, aw);

        gHipX = 0.036 * gw;
        gHipRoll = 0.058 * gw;
        gHipYaw = 0.10 * gw;
        gLegBias = 0.90 * gw;
        gSpinePitch = -0.035 * gw;
        gSpineYaw = -0.06 * gw;
        gHeadYaw = -0.12 * hw;
        gHeadRoll = 0.05 * hw;
        break;
      }

      case "leaning_forward": {
        // Subtle interested lean from the hips (spine + neck follow naturally, not neck-only)
        _lUpperArm.x = lerp(_lUpperArm.x, 0.22, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.18, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -1.12, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -0.45, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, 0.22, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.18, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 1.12, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 0.45, aw);

        gSpinePitch = 0.14 * gw;
        gKneeBounce = 0.10 * gw;
        gHeadPitch = -0.10 * hw; // Counter-lift head so gaze stays directly on user
        gHeadRoll = 0.06 * hw;
        break;
      }

      case "stretching": {
        const stretchEase = Math.sin(Math.min(Math.PI, gt * 0.85));
        // Slow comfortable overhead stretch without locking elbows or over-arching lumbar
        _lUpperArm.x = lerp(_lUpperArm.x, -1.098, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.774, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, 0.405 + stretchEase * 0.14, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -0.95, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, -1.098, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.774, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, -0.405 - stretchEase * 0.14, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 0.95, aw);

        gSpinePitch = -0.075 * stretchEase * gw;
        gHeadPitch = -0.09 * stretchEase * hw;
        leftHandShape = "open";
        rightHandShape = "open";
        break;
      }

      case "hair_adjustment": {
        const brush = Math.sin(gt * 2.2) * 0.04;
        // Gentle grooming gesture approaching right temple/ear with safe head clearance
        _lUpperArm.x = lerp(_lUpperArm.x, 1.06, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.878, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.498, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -0.867, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, -1.136, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.326, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 0.298 + brush, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 2.30 - brush, aw);
        _rHand.z = lerp(_rHand.z, -0.10 + brush * 1.5, aw);

        gHipX = -0.022 * gw;
        gLegBias = -0.60 * gw;
        gHeadRoll = -0.11 * hw;
        gHeadYaw = 0.08 * hw;
        rightHandShape = "open";
        break;
      }

      case "natural_laughing": {
        // Organic non-uniform laugh rhythm (varied harmonics, not mechanical bounce)
        const laugh = (Math.sin(gt * 6.8) * 0.55 + Math.sin(gt * 10.4 + 0.8) * 0.45) * (0.65 + 0.35 * Math.sin(gt * 1.9));
        _lUpperArm.x = lerp(_lUpperArm.x, 0.515, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.699, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.882, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -1.485, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, -0.529, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, 0.522, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 1.273, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 2.317 + laugh * 0.04, aw);
        _rHand.z = lerp(_rHand.z, -0.08, aw);
        _lShoulder.z = lerp(_lShoulder.z, laugh * 0.03, aw);
        _rShoulder.z = lerp(_rShoulder.z, -laugh * 0.03, aw);

        gSpinePitch = (0.04 + laugh * 0.025) * gw;
        gHeadPitch = (0.04 + laugh * 0.04) * hw;
        gHeadRoll = 0.07 * hw;
        rightHandShape = "open";
        break;
      }

      case "goodbye": {
        const slowWave = Math.sin(gt * 3.1);
        const slowLag = Math.sin(gt * 3.1 - 0.5);
        // Gentle slower farewell wave
        _lUpperArm.x = lerp(_lUpperArm.x, 1.06, aw);
        _lUpperArm.y = lerp(_lUpperArm.y, -0.878, aw);
        _lUpperArm.z = lerp(_lUpperArm.z, -0.498, aw);
        _lLowerArm.y = lerp(_lLowerArm.y, -0.867, aw);

        _rUpperArm.x = lerp(_rUpperArm.x, -0.962, aw);
        _rUpperArm.y = lerp(_rUpperArm.y, -0.163, aw);
        _rUpperArm.z = lerp(_rUpperArm.z, 0.262 + slowWave * 0.04, aw);
        _rLowerArm.y = lerp(_rLowerArm.y, 2.121 + slowWave * 0.14, aw);
        _rHand.x = lerp(_rHand.x, 0.08, aw);
        _rHand.z = lerp(_rHand.z, -0.05 + slowLag * 0.18, aw);

        gHipX = 0.020 * gw;
        gLegBias = 0.55 * gw;
        gHeadRoll = 0.09 * hw;
        gHeadPitch = -0.02 * hw;
        rightHandShape = "open";
        break;
      }
    }
  }

  // --- 1. HIPS & FULL-BODY WEIGHT SHIFT (Grounded contrapposto) ---
  const hipShift = weightShift * 0.018 + gHipX;
  const hipRoll = -weightShift * 0.026 + gHipRoll;
  const hipYaw = weightShift * 0.032 + gHipYaw;

  const hipsNode = humanoid.getNormalizedBoneNode("hips");
  if (hipsNode) {
    if (state.hipsRestPos) {
      const tx = state.hipsRestPos.x + hipShift * dir;
      const ty = state.hipsRestPos.y - Math.abs(hipShift) * 0.28 - gKneeBounce * 0.024;
      const tz = state.hipsRestPos.z;
      if (!cache.hipsPos || snap) {
        cache.hipsPos = { x: tx, y: ty, z: tz };
      } else {
        cache.hipsPos.x = damp(cache.hipsPos.x, tx, 7.2, dt);
        cache.hipsPos.y = damp(cache.hipsPos.y, ty, 7.2, dt);
        cache.hipsPos.z = damp(cache.hipsPos.z, tz, 7.2, dt);
      }
      hipsNode.position.set(cache.hipsPos.x, cache.hipsPos.y, cache.hipsPos.z);
    }
    applySmoothedNormalizedBone(vrm, cache, "hips", gKneeBounce * 0.05, hipYaw, hipRoll, dir, 7.2, dt, snap);
  }

  // --- 2. GROUNDED LEGS, KNEES & FEET (Natural contrapposto support) ---
  const relaxLeft = Math.max(0, -weightShift) * 0.45 + Math.max(0, gLegBias);
  const relaxRight = Math.max(0, weightShift) * 0.45 + Math.max(0, -gLegBias);

  applySmoothedNormalizedBone(
    vrm,
    cache,
    "leftUpperLeg",
    -0.03 - relaxLeft * 0.13 - gKneeBounce * 0.15,
    0.05 - gInwardKnees,
    0.035 + hipShift * 1.25 - gInwardKnees * 0.42,
    dir,
    6.8,
    dt,
    snap,
  );
  applySmoothedNormalizedBone(
    vrm,
    cache,
    "leftLowerLeg",
    0.06 + relaxLeft * 0.24 + gKneeBounce * 0.30,
    0,
    0,
    dir,
    6.8,
    dt,
    snap,
  );
  applySmoothedNormalizedBone(
    vrm,
    cache,
    "leftFoot",
    -0.03 - relaxLeft * 0.10 - gKneeBounce * 0.14,
    0,
    -hipShift * 0.95,
    dir,
    6.8,
    dt,
    snap,
  );

  applySmoothedNormalizedBone(
    vrm,
    cache,
    "rightUpperLeg",
    -0.03 - relaxRight * 0.13 - gKneeBounce * 0.15,
    -0.05 + gInwardKnees,
    -0.035 + hipShift * 1.25 + gInwardKnees * 0.42,
    dir,
    6.8,
    dt,
    snap,
  );
  applySmoothedNormalizedBone(
    vrm,
    cache,
    "rightLowerLeg",
    0.06 + relaxRight * 0.24 + gKneeBounce * 0.30,
    0,
    0,
    dir,
    6.8,
    dt,
    snap,
  );
  applySmoothedNormalizedBone(
    vrm,
    cache,
    "rightFoot",
    -0.03 - relaxRight * 0.10 - gKneeBounce * 0.14,
    0,
    -hipShift * 0.95,
    dir,
    6.8,
    dt,
    snap,
  );

  // --- 3. SPINE, CHEST, NECK & HEAD (Subtle breathing + gaze/head lead) ---
  applySmoothedNormalizedBone(
    vrm,
    cache,
    "spine",
    breath * 0.010 + state.reactSpinePitch * 0.5 + gSpinePitch * 0.58,
    -hipYaw * 0.35 + gSpineYaw * 0.5,
    -hipRoll * 0.45 + microSway * 0.008,
    dir,
    7.0,
    dt,
    snap,
  );
  applySmoothedNormalizedBone(
    vrm,
    cache,
    "chest",
    breath * 0.013 + state.reactSpinePitch * 0.5 + gSpinePitch * 0.42,
    -hipYaw * 0.35 + microSway * 0.010 + gSpineYaw * 0.5,
    -hipRoll * 0.35,
    dir,
    6.8,
    dt,
    snap,
  );
  applySmoothedNormalizedBone(
    vrm,
    cache,
    "neck",
    -state.pointerSmoothY * 0.07 + state.reactHeadPitch * 0.4 + gHeadPitch * 0.42,
    state.pointerSmoothX * 0.13 + state.reactHeadYaw * 0.4 + gHeadYaw * 0.42,
    gHeadRoll * 0.36,
    dir,
    7.2,
    dt,
    snap,
  );
  applySmoothedNormalizedBone(
    vrm,
    cache,
    "head",
    -state.pointerSmoothY * 0.09 + breath * 0.006 + state.reactHeadPitch * 0.6 + gHeadPitch * 0.58,
    state.pointerSmoothX * 0.16 + microSway * 0.012 + state.reactHeadYaw * 0.6 + gHeadYaw * 0.58,
    microSway * 0.008 + state.reactHeadRoll + gHeadRoll * 0.64,
    dir,
    7.0,
    dt,
    snap,
  );

  // --- 4. SHOULDERS, ARMS & WRISTS (Overlapping action: shoulders lead, forearms & wrists trail) ---
  applySmoothedNormalizedBone(vrm, cache, "leftShoulder", _lShoulder.x, _lShoulder.y, _lShoulder.z, dir, 7.2, dt, snap);
  applySmoothedNormalizedBone(vrm, cache, "rightShoulder", _rShoulder.x, _rShoulder.y, _rShoulder.z, dir, 7.2, dt, snap);
  applySmoothedNormalizedBone(vrm, cache, "leftUpperArm", _lUpperArm.x, _lUpperArm.y, _lUpperArm.z, dir, 6.4, dt, snap);
  applySmoothedNormalizedBone(vrm, cache, "rightUpperArm", _rUpperArm.x, _rUpperArm.y, _rUpperArm.z, dir, 6.4, dt, snap);
  applySmoothedNormalizedBone(vrm, cache, "leftLowerArm", _lLowerArm.x, _lLowerArm.y, _lLowerArm.z, dir, 5.8, dt, snap);
  applySmoothedNormalizedBone(vrm, cache, "rightLowerArm", _rLowerArm.x, _rLowerArm.y, _rLowerArm.z, dir, 5.8, dt, snap);
  applySmoothedNormalizedBone(vrm, cache, "leftHand", _lHand.x, _lHand.y, _lHand.z, dir, 5.4, dt, snap);
  applySmoothedNormalizedBone(vrm, cache, "rightHand", _rHand.x, _rHand.y, _rHand.z, dir, 5.4, dt, snap);

  // --- 5. EXPRESSIVE ARTICULATED FINGERS ---
  const lCurlScale = leftFingerScale * (1 - talk * 0.22);
  const rCurlScale = rightFingerScale * (1 - talk * 0.22);
  for (let i = 0; i < LEFT_FINGERS.length; i++) {
    const f = LEFT_FINGERS[i];
    const targetCurl = lerp(f.curl * lCurlScale, fingerCurlForShape(f, leftHandShape, lCurlScale), armLead);
    applySmoothedNormalizedBone(vrm, cache, f.bone, 0, 0, -targetCurl, dir, 10.0, dt, snap);
  }
  for (let i = 0; i < RIGHT_FINGERS.length; i++) {
    const f = RIGHT_FINGERS[i];
    const targetCurl = lerp(f.curl * rCurlScale, fingerCurlForShape(f, rightHandShape, rCurlScale), armLead);
    const vSpread =
      rightHandShape === "peace" && f.bone === "rightIndexProximal"
        ? -0.14 * armLead
        : rightHandShape === "peace" && f.bone === "rightMiddleProximal"
          ? 0.14 * armLead
          : 0;
    applySmoothedNormalizedBone(vrm, cache, f.bone, 0, vSpread, targetCurl, dir, 10.0, dt, snap);
  }
  const thumbCurlForShape = (shape: HandShape, scale: number): number =>
    shape === "fist" || shape === "peace" ? 1.42 : shape === "open" ? 0.35 : scale;
  const lThumbCurl = thumbCurlForShape(leftHandShape, lCurlScale);
  const rThumbCurl = thumbCurlForShape(rightHandShape, rCurlScale);
  applySmoothedNormalizedBone(vrm, cache, "leftThumbMetacarpal", 0.08, -0.26 * lerp(lCurlScale, lThumbCurl, armLead), -0.14 * lCurlScale, dir, 10.0, dt, snap);
  applySmoothedNormalizedBone(vrm, cache, "leftThumbProximal", 0, -0.18 * lerp(lCurlScale, lThumbCurl, armLead), -0.12 * lCurlScale, dir, 10.0, dt, snap);
  applySmoothedNormalizedBone(vrm, cache, "rightThumbMetacarpal", 0.08, 0.26 * lerp(rCurlScale, rThumbCurl, armLead), 0.14 * rCurlScale, dir, 10.0, dt, snap);
  applySmoothedNormalizedBone(vrm, cache, "rightThumbProximal", 0, 0.18 * lerp(rCurlScale, rThumbCurl, armLead), 0.12 * rCurlScale, dir, 10.0, dt, snap);
}
