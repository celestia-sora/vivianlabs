/**
 * Unified 3D Secondary Physics Engine for Vivian (VRM 0.x/1.0 & FBX).
 *
 * Upgrades 3D avatar physics with:
 *  1. Framerate-independent Verlet scaling (identical feel at 30Hz, 60Hz, 90Hz, 120Hz)
 *     plus automatic substepping on frame spikes so SpringBones never jitter or tunnel.
 *  2. Multi-layered organic wind field (ambient micro-breeze + traveling gusts + per-chain
 *     spatial phase offsets) that preserves each VRM joint's authored gravityDir/gravityPower.
 *  3. Bounded inertial reaction forces from avatar drag/reposition velocity and interactive
 *     tap/brush impulses so hair, skirts, ribbons, and coats trail and settle naturally.
 *  4. Auto-generated head/chest/pelvis sphere colliders for VRM SpringBones that ship
 *     with zero authored colliders (preventing hair/cloth clipping through the body).
 *  5. Full Verlet secondary-bone chain solver for FBX models (hair, bangs, twintails,
 *     skirts, dresses, coats, capes, ribbons, ties, tails, ears, bust) with body colliders
 *     and cone angle limits — giving FBX avatars living secondary physics out of the box.
 */

import type * as ThreeTypes from "three";
import type { VRM as VrmInstance, VRMSpringBoneJoint } from "@pixiv/three-vrm";
import type { ThreeAvatarModules } from "./model-runtime-3d.ts";

export type PhysicsPartCategory =
  | "hair"
  | "skirt"
  | "ribbon"
  | "tail"
  | "ear"
  | "bust"
  | "accessory"
  | "generic";

export interface PhysicsPreset {
  stiffness: number;
  dragForce: number;
  gravityPower: number;
  windScale: number;
  inertiaScale: number;
  maxAngleRad: number;
  hitRadius: number;
}

export const PHYSICS_PRESETS: Record<PhysicsPartCategory, PhysicsPreset> = {
  hair: {
    stiffness: 0.72,
    dragForce: 0.36,
    gravityPower: 0.24,
    windScale: 1.0,
    inertiaScale: 1.1,
    maxAngleRad: 0.78,
    hitRadius: 0.025,
  },
  skirt: {
    stiffness: 0.85,
    dragForce: 0.42,
    gravityPower: 0.32,
    windScale: 0.72,
    inertiaScale: 0.9,
    maxAngleRad: 0.58,
    hitRadius: 0.03,
  },
  ribbon: {
    stiffness: 0.52,
    dragForce: 0.30,
    gravityPower: 0.28,
    windScale: 1.35,
    inertiaScale: 1.25,
    maxAngleRad: 0.95,
    hitRadius: 0.018,
  },
  tail: {
    stiffness: 0.62,
    dragForce: 0.34,
    gravityPower: 0.16,
    windScale: 0.85,
    inertiaScale: 1.15,
    maxAngleRad: 0.85,
    hitRadius: 0.025,
  },
  ear: {
    stiffness: 1.35,
    dragForce: 0.40,
    gravityPower: 0.08,
    windScale: 0.55,
    inertiaScale: 0.85,
    maxAngleRad: 0.42,
    hitRadius: 0.02,
  },
  bust: {
    stiffness: 2.1,
    dragForce: 0.48,
    gravityPower: 0.08,
    windScale: 0.08,
    inertiaScale: 0.55,
    maxAngleRad: 0.24,
    hitRadius: 0.02,
  },
  accessory: {
    stiffness: 0.80,
    dragForce: 0.35,
    gravityPower: 0.26,
    windScale: 0.95,
    inertiaScale: 1.05,
    maxAngleRad: 0.75,
    hitRadius: 0.02,
  },
  generic: {
    stiffness: 0.85,
    dragForce: 0.38,
    gravityPower: 0.20,
    windScale: 0.75,
    inertiaScale: 0.9,
    maxAngleRad: 0.65,
    hitRadius: 0.022,
  },
};

const REF_DT = 1 / 60;
const MAX_SUBSTEP_DT = 1 / 50;
const MAX_SUBSTEPS = 3;

const CATEGORY_PATTERNS: ReadonlyArray<{ category: PhysicsPartCategory; pattern: RegExp }> = [
  {
    category: "hair",
    pattern: /hair|bang|ahoge|pony|twin_?tail|braid|fringe|side_?lock|front_?hair|back_?hair|髪|前髪|後髪|横髪|ツインテ|ポニテ|アホ毛|おさげ/i,
  },
  {
    category: "skirt",
    pattern: /skirt|dress|coat|cape|cloak|mantle|robe|hem|sleeve|apron|flap|pleat|frill|gown|tunic|スカート|ドレス|コート|マント|袖|裾|フリル|エプロン/i,
  },
  {
    category: "ribbon",
    pattern: /ribbon|bow|tie|necktie|scarf|muffler|strap|cord|string|tassel|lace|belt|sash|streamer|リボン|ネクタイ|マフラー|スカーフ|紐|帯/i,
  },
  {
    category: "tail",
    pattern: /(?<![a-z])tail(?![a-z])|_tail|tail_|shippo|尻尾|しっぽ/i,
  },
  {
    category: "ear",
    pattern: /kemono_?ear|cat_?ear|fox_?ear|wolf_?ear|bunny_?ear|rabbit_?ear|animal_?ear|ear_?(?:l|r|\d)|耳/i,
  },
  {
    category: "bust",
    pattern: /bust|breast|chest_?(?:l|r|jiggle|spring)|oppai|boob|mune|胸|バスト|おっぱい/i,
  },
  {
    category: "accessory",
    pattern: /earring|pendant|charm|chain|bell|feather|wing|hood|hat|veil|tassel|dangle|pendulum|spring|jiggle|swing|phys|揺れ|アクセ|羽|翼|ベール/i,
  },
];

/** Exclude core humanoid skeleton bones from automatic FBX secondary physics discovery. */
const CORE_HUMANOID_BONE_PATTERN =
  /(?:^|[:_\s.-])(?:root|hips?|pelvis|spine\d*|chest|upper_?chest|neck|head|jaw|chin|nose|eye(?:_?[lr])?|eyelid|eyebrow|brow|mouth|lip|tongue|shoulder|clavicle|collar|upper_?arm|lower_?arm|fore_?arm|arm|elbow|hand|wrist|thumb|index|middle|ring|pinky|little|finger|upper_?leg|lower_?leg|thigh|calf|shin|knee|leg|foot|ankle|toe|heel|ik|pole|target|ctrl|control|rig|wgt|mch|org|def_spine|def_pelvis|def_neck|def_head|センター|グルーブ|腰|上半身|下半身|首|頭|肩|腕|ひじ|手首|指|足|ひざ|足首|つま先|目)(?:[_\s.-]*[lr\d]*)?$/i;

export function classifyPhysicsBoneName(name: string): PhysicsPartCategory {
  const trimmed = name.trim();
  if (!trimmed) return "generic";
  for (const entry of CATEGORY_PATTERNS) {
    if (entry.pattern.test(trimmed)) return entry.category;
  }
  return "generic";
}

export function isSecondaryPhysicsBoneName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (CORE_HUMANOID_BONE_PATTERN.test(trimmed)) return false;
  for (const entry of CATEGORY_PATTERNS) {
    if (entry.pattern.test(trimmed)) return true;
  }
  return false;
}

/** Deterministic phase hash in [0, 2π) so neighboring strands sway organically out of phase. */
export function hashBonePhase(name: string, index: number): number {
  let hash = 2166136261 ^ index;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 6283) / 1000;
}

/**
 * Compute framerate-independent Verlet drag & force scaling relative to 60Hz.
 * Guarantees identical damping time-constant, oscillation frequency, and rest droop
 * on 30Hz, 60Hz, 90Hz, and 120Hz displays.
 */
export function computeFramerateIndependentParams(
  baseStiffness: number,
  baseDragForce: number,
  baseGravityPower: number,
  subDt: number,
): { stiffness: number; dragForce: number; gravityPower: number } {
  const ratio = Math.max(0.15, Math.min(2.0, subDt / REF_DT));
  const clampedDrag = Math.max(0.01, Math.min(0.99, baseDragForce));
  const dragForce = 1 - Math.pow(1 - clampedDrag, ratio);
  return {
    stiffness: baseStiffness * ratio,
    dragForce,
    gravityPower: baseGravityPower * ratio,
  };
}

/**
 * Evaluate organic multi-layered wind vector (ambient breeze + traveling gusts + per-chain flutter).
 * Writes directly into `out` to remain 100% zero-GC.
 */
export function evaluateWindField(
  elapsedSec: number,
  phase: number,
  worldX: number,
  worldY: number,
  out: { x: number; y: number; z: number },
): void {
  // Slow rolling gust envelope in [0.18, 1.0]
  const gustWave = 0.5 + 0.5 * Math.sin(elapsedSec * 0.42 + worldX * 1.15 - worldY * 0.45);
  const gust = 0.22 + 0.78 * gustWave * gustWave;

  // Primary gentle lateral breeze + secondary harmonic + per-strand phase turbulence
  const primaryX = Math.sin(elapsedSec * 0.85 + phase * 0.35) * 0.065;
  const flutterX = Math.sin(elapsedSec * 2.15 + phase + worldY * 2.2) * 0.032;
  const microX = Math.cos(elapsedSec * 3.7 + phase * 1.7) * 0.014;

  // Gentle depth (front/back) breathing wave so hair/skirts lift softly in 3D space
  const breezeZ =
    Math.sin(elapsedSec * 0.72 + phase * 0.5 + 1.1) * 0.038 +
    Math.cos(elapsedSec * 1.9 + phase * 1.3) * 0.018;

  // Subtle upward lift during stronger gusts
  const liftY = (gust - 0.35) * 0.018 * (0.5 + 0.5 * Math.sin(elapsedSec * 1.6 + phase));

  out.x = (primaryX + flutterX + microX) * gust;
  out.y = liftY;
  out.z = breezeZ * gust;
}

interface VrmJointBaseline {
  joint: VRMSpringBoneJoint;
  category: PhysicsPartCategory;
  phase: number;
  baseGravityDir: ThreeTypes.Vector3;
  baseGravityPower: number;
  baseStiffness: number;
  baseDragForce: number;
  windScale: number;
  inertiaScale: number;
}

interface BodySphereCollider {
  bone: ThreeTypes.Object3D;
  worldOffsetY: number;
  radius: number;
  worldCenter: ThreeTypes.Vector3;
}

interface FbxSpringJoint {
  bone: ThreeTypes.Object3D;
  child: ThreeTypes.Object3D | null;
  category: PhysicsPartCategory;
  phase: number;
  initialLocalRotation: ThreeTypes.Quaternion;
  initialLocalMatrix: ThreeTypes.Matrix4;
  boneAxis: ThreeTypes.Vector3;
  boneLength: number;
  currentTail: ThreeTypes.Vector3;
  prevTail: ThreeTypes.Vector3;
  stiffness: number;
  dragForce: number;
  gravityPower: number;
  windScale: number;
  inertiaScale: number;
  maxAngleCos: number;
  hitRadius: number;
  initialized: boolean;
}

export interface PhysicsRuntimeStats {
  mode: "vrm" | "fbx" | "none";
  jointCount: number;
  colliderCount: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/**
 * Manages enhanced secondary physics for either a VRM avatar (augmenting `@pixiv/three-vrm`'s
 * SpringBoneManager) or an FBX avatar (running a dedicated Verlet chain solver with body colliders).
 */
export class Avatar3DPhysicsController {
  private readonly THREE: ThreeAvatarModules["THREE"];
  private readonly VRM: ThreeAvatarModules["VRM"];

  private mode: "vrm" | "fbx" | "none" = "none";
  private vrm: VrmInstance | null = null;
  private vrmJoints: VrmJointBaseline[] = [];
  private vrmAddedColliderCount = 0;

  private fbxJoints: FbxSpringJoint[] = [];
  private fbxColliders: BodySphereCollider[] = [];

  // Inertial & interactive impulse state (smoothed, bounded, zero-GC)
  private impulseX = 0;
  private impulseY = 0;
  private impulseZ = 0;
  private lastRootX = 0;
  private lastRootY = 0;
  private lastRootZ = 0;
  private hasLastRootPos = false;

  // Scratch vectors/quaternions/matrices for zero-GC per-frame updates
  private readonly _wind = { x: 0, y: 0, z: 0 };
  private readonly _worldPos: ThreeTypes.Vector3;
  private readonly _forceVec: ThreeTypes.Vector3;
  private readonly _vA: ThreeTypes.Vector3;
  private readonly _vB: ThreeTypes.Vector3;
  private readonly _vC: ThreeTypes.Vector3;
  private readonly _nextTail: ThreeTypes.Vector3;
  private readonly _restDir: ThreeTypes.Vector3;
  private readonly _parentMat: ThreeTypes.Matrix4;
  private readonly _initWorldMat: ThreeTypes.Matrix4;
  private readonly _initWorldMatInv: ThreeTypes.Matrix4;
  private readonly _quatA: ThreeTypes.Quaternion;

  constructor(modules: ThreeAvatarModules) {
    this.THREE = modules.THREE;
    this.VRM = modules.VRM;
    const THREE = this.THREE;
    this._worldPos = new THREE.Vector3();
    this._forceVec = new THREE.Vector3();
    this._vA = new THREE.Vector3();
    this._vB = new THREE.Vector3();
    this._vC = new THREE.Vector3();
    this._nextTail = new THREE.Vector3();
    this._restDir = new THREE.Vector3();
    this._parentMat = new THREE.Matrix4();
    this._initWorldMat = new THREE.Matrix4();
    this._initWorldMatInv = new THREE.Matrix4();
    this._quatA = new THREE.Quaternion();
  }

  getStats(): PhysicsRuntimeStats {
    if (this.mode === "vrm") {
      return {
        mode: "vrm",
        jointCount: this.vrmJoints.length,
        colliderCount: (this.vrm?.springBoneManager?.colliders.length ?? 0),
      };
    }
    if (this.mode === "fbx") {
      return {
        mode: "fbx",
        jointCount: this.fbxJoints.length,
        colliderCount: this.fbxColliders.length,
      };
    }
    return { mode: "none", jointCount: 0, colliderCount: 0 };
  }

  clear(): void {
    this.mode = "none";
    this.vrm = null;
    this.vrmJoints = [];
    this.vrmAddedColliderCount = 0;
    this.fbxJoints = [];
    this.fbxColliders = [];
    this.impulseX = 0;
    this.impulseY = 0;
    this.impulseZ = 0;
    this.hasLastRootPos = false;
  }

  /**
   * Inject an interactive impulse (e.g. from user drag flick, tap/brush, or expressive jump).
   * Values are in world-ish acceleration units and safely clamped so chains never explode.
   */
  addImpulse(ix: number, iy: number, iz = 0): void {
    this.impulseX = clamp(this.impulseX + ix, -0.75, 0.75);
    this.impulseY = clamp(this.impulseY + iy, -0.55, 0.55);
    this.impulseZ = clamp(this.impulseZ + iz, -0.55, 0.55);
  }

  /**
   * Attach to a loaded VRM avatar: capture every SpringBone joint's authored baseline,
   * classify its body part, and auto-add lightweight body colliders if the model has none.
   */
  attachVrm(vrm: VrmInstance, root: ThreeTypes.Object3D): void {
    this.clear();
    this.mode = "vrm";
    this.vrm = vrm;
    this.captureRootPos(root);

    const mgr = vrm.springBoneManager;
    if (!mgr) return;

    // Auto-add basic head/chest/hips colliders ONLY if the model has SpringBones with zero colliders
    const jointsArr = Array.from(mgr.joints);
    const hasAnyCollider = jointsArr.some((j) => j.colliderGroups.length > 0);
    if (!hasAnyCollider && jointsArr.length > 0 && vrm.humanoid) {
      this.attachFallbackVrmColliders(vrm, jointsArr);
    }

    let idx = 0;
    for (const joint of mgr.joints) {
      const name = joint.bone?.name ?? "";
      const category = classifyPhysicsBoneName(name);
      const preset = PHYSICS_PRESETS[category];
      const baseGravityDir = joint.settings.gravityDir.clone();
      if (baseGravityDir.lengthSq() < 1e-6) {
        baseGravityDir.set(0, -1, 0);
      } else {
        baseGravityDir.normalize();
      }
      this.vrmJoints.push({
        joint,
        category,
        phase: hashBonePhase(name, idx++),
        baseGravityDir,
        baseGravityPower: Math.max(0, joint.settings.gravityPower),
        baseStiffness: Math.max(0.05, joint.settings.stiffness),
        baseDragForce: clamp(joint.settings.dragForce, 0.05, 0.95),
        windScale: preset.windScale,
        inertiaScale: preset.inertiaScale,
      });
    }
  }

  private attachFallbackVrmColliders(vrm: VrmInstance, joints: VRMSpringBoneJoint[]): void {
    const THREE = this.THREE;
    const { VRMSpringBoneCollider, VRMSpringBoneColliderShapeSphere } = this.VRM;
    if (!VRMSpringBoneCollider || !VRMSpringBoneColliderShapeSphere) return;

    const specs: Array<{ bone: "head" | "chest" | "hips"; offset: [number, number, number]; radius: number }> = [
      { bone: "head", offset: [0, 0.08, 0.01], radius: 0.11 },
      { bone: "chest", offset: [0, 0.04, 0.02], radius: 0.13 },
      { bone: "hips", offset: [0, -0.02, 0.01], radius: 0.14 },
    ];

    const colliders: InstanceType<typeof VRMSpringBoneCollider>[] = [];
    const scaleVec = new THREE.Vector3();
    for (const spec of specs) {
      const node = vrm.humanoid?.getRawBoneNode(spec.bone);
      if (!node) continue;
      node.getWorldScale(scaleVec);
      const invScale = 1 / Math.max(0.05, Math.abs(scaleVec.y) || 1);
      const shape = new VRMSpringBoneColliderShapeSphere({
        offset: new THREE.Vector3(spec.offset[0] * invScale, spec.offset[1] * invScale, spec.offset[2] * invScale),
        radius: spec.radius * invScale,
      });
      const collider = new VRMSpringBoneCollider(shape);
      collider.name = `__vivian_auto_collider_${spec.bone}`;
      node.add(collider);
      colliders.push(collider);
    }

    if (!colliders.length) return;
    const group = { name: "__vivian_auto_body_colliders", colliders };
    this.vrmAddedColliderCount = colliders.length;
    for (const joint of joints) {
      if (joint.colliderGroups.length === 0) {
        joint.colliderGroups.push(group);
      }
    }
  }

  /**
   * Attach to a loaded FBX avatar: discover secondary physics bone chains (hair, skirts,
   * coats, ribbons, tails, ears, bust) and build head/chest/hips body sphere colliders.
   */
  attachFbx(fbxRoot: ThreeTypes.Object3D, avatarRoot: ThreeTypes.Object3D, animatedNodeNames?: ReadonlySet<string>): void {
    this.clear();
    this.mode = "fbx";
    this.captureRootPos(avatarRoot);
    fbxRoot.updateMatrixWorld(true);

    // 1. Discover body sphere colliders from core humanoid bones
    const colliderCandidates: Array<{ patterns: RegExp[]; offsetY: number; radius: number }> = [
      { patterns: [/^(?:mixamorig\d*)?head$/i, /(?:^|[:_\s])head$/i, /頭/], offsetY: 0.07, radius: 0.11 },
      { patterns: [/^(?:mixamorig\d*)?(?:chest|spine_?0?2|upper_?chest)$/i, /上半身2/], offsetY: 0.03, radius: 0.13 },
      { patterns: [/^(?:mixamorig\d*)?hips?$/i, /pelvis/i, /センター|腰/], offsetY: -0.02, radius: 0.14 },
    ];
    const seenColliderBones = new Set<ThreeTypes.Object3D>();
    for (const spec of colliderCandidates) {
      let matched: ThreeTypes.Object3D | null = null;
      fbxRoot.traverse((node) => {
        if (matched) return;
        if (!(node as ThreeTypes.Bone).isBone && node.type !== "Bone") return;
        if (seenColliderBones.has(node)) return;
        if (spec.patterns.some((p) => p.test(node.name.trim()))) {
          matched = node;
        }
      });
      if (matched) {
        seenColliderBones.add(matched);
        this.fbxColliders.push({
          bone: matched,
          worldOffsetY: spec.offsetY,
          radius: spec.radius,
          worldCenter: new this.THREE.Vector3(),
        });
      }
    }

    // 2. Discover secondary physics bones in parent-first traversal order (so chains update top-down)
    const discovered: Array<{ bone: ThreeTypes.Object3D; category: PhysicsPartCategory }> = [];
    const seen = new Set<ThreeTypes.Object3D>();
    const visit = (node: ThreeTypes.Object3D, inheritedCategory: PhysicsPartCategory | null) => {
      const isBone = (node as ThreeTypes.Bone).isBone || node.type === "Bone";
      let nextCategory = inheritedCategory;
      if (isBone && !seen.has(node)) {
        const name = node.name.trim();
        const isAnimated = Boolean(animatedNodeNames?.has(name));
        if (!isAnimated) {
          if (isSecondaryPhysicsBoneName(name)) {
            nextCategory = classifyPhysicsBoneName(name);
            seen.add(node);
            discovered.push({ bone: node, category: nextCategory });
          } else if (inheritedCategory && !CORE_HUMANOID_BONE_PATTERN.test(name)) {
            // Child bone inside an already-matched secondary chain (e.g. Hair_01 -> Hair_02 -> Hair_03)
            seen.add(node);
            discovered.push({ bone: node, category: inheritedCategory });
          } else {
            nextCategory = null;
          }
        } else {
          nextCategory = null;
        }
      }
      for (const child of node.children) {
        visit(child, nextCategory);
      }
    };
    visit(fbxRoot, null);

    // 3. Build Verlet joints for every discovered bone (capped at 160 joints for mobile GPU/CPU budget)
    const THREE = this.THREE;
    const bonePos = new THREE.Vector3();
    const childPos = new THREE.Vector3();
    const limit = Math.min(discovered.length, 160);

    for (let i = 0; i < limit; i++) {
      const { bone, category } = discovered[i];
      const childBone = bone.children.find((c) => (c as ThreeTypes.Bone).isBone || c.type === "Bone") ?? null;

      // Skip leaf tips with zero length unless they are single-bone bust/ear/ribbon jiggle bones
      bone.getWorldPosition(bonePos);
      let boneLength = 0.08;
      const boneAxis = new THREE.Vector3(0, -1, 0);

      if (childBone) {
        childBone.getWorldPosition(childPos);
        const worldLen = childPos.distanceTo(bonePos);
        if (worldLen < 0.004) continue;
        boneLength = clamp(worldLen, 0.015, 0.45);
        if (childBone.position.lengthSq() > 1e-8) {
          boneAxis.copy(childBone.position).normalize();
        }
      } else if (category !== "bust" && category !== "ear" && category !== "ribbon") {
        // Pure leaf end-effector of a multi-bone chain doesn't need its own rotation
        continue;
      }

      const preset = PHYSICS_PRESETS[category];
      const tailWorld = bonePos.clone().addScaledVector(
        boneAxis.clone().transformDirection(bone.matrixWorld).normalize(),
        boneLength,
      );

      this.fbxJoints.push({
        bone,
        child: childBone,
        category,
        phase: hashBonePhase(bone.name, i),
        initialLocalRotation: bone.quaternion.clone(),
        initialLocalMatrix: new THREE.Matrix4().compose(bone.position, bone.quaternion, bone.scale),
        boneAxis,
        boneLength,
        currentTail: tailWorld.clone(),
        prevTail: tailWorld.clone(),
        stiffness: preset.stiffness,
        dragForce: preset.dragForce,
        gravityPower: preset.gravityPower,
        windScale: preset.windScale,
        inertiaScale: preset.inertiaScale,
        maxAngleCos: Math.cos(preset.maxAngleRad),
        hitRadius: preset.hitRadius,
        initialized: true,
      });
    }
  }

  private captureRootPos(root: ThreeTypes.Object3D): void {
    this.lastRootX = root.position.x;
    this.lastRootY = root.position.y;
    this.lastRootZ = root.position.z;
    this.hasLastRootPos = true;
  }

  /**
   * Track smooth root displacement (e.g. user dragging the avatar) and convert it into
   * a bounded inertial reaction force so hair & clothing trail behind gracefully.
   */
  private updateDragInertia(root: ThreeTypes.Object3D, dt: number): void {
    const rx = root.position.x;
    const ry = root.position.y;
    const rz = root.position.z;
    if (!this.hasLastRootPos) {
      this.captureRootPos(root);
      return;
    }
    const dx = rx - this.lastRootX;
    const dy = ry - this.lastRootY;
    const dz = rz - this.lastRootZ;
    this.lastRootX = rx;
    this.lastRootY = ry;
    this.lastRootZ = rz;

    const safeDt = Math.max(0.004, dt);
    const vx = dx / safeDt;
    const vy = dy / safeDt;
    const vz = dz / safeDt;

    // Ignore huge teleports (e.g. resize / instant reset) so SpringBones don't snap
    if (Math.hypot(dx, dy, dz) > 0.45) {
      return;
    }

    // Opposite to root movement = inertial lag force
    if (Math.abs(vx) > 0.01 || Math.abs(vy) > 0.01 || Math.abs(vz) > 0.01) {
      this.impulseX = clamp(this.impulseX - vx * 0.055, -0.75, 0.75);
      this.impulseY = clamp(this.impulseY - vy * 0.045, -0.55, 0.55);
      this.impulseZ = clamp(this.impulseZ - vz * 0.04, -0.55, 0.55);
    }

    // Exponentially decay impulses back to rest
    this.impulseX = damp(this.impulseX, 0, 5.2, dt);
    this.impulseY = damp(this.impulseY, 0, 5.2, dt);
    this.impulseZ = damp(this.impulseZ, 0, 5.2, dt);
    if (Math.abs(this.impulseX) < 0.0005) this.impulseX = 0;
    if (Math.abs(this.impulseY) < 0.0005) this.impulseY = 0;
    if (Math.abs(this.impulseZ) < 0.0005) this.impulseZ = 0;
  }

  /**
   * Step VRM components + enhanced framerate-independent SpringBone physics.
   * Replaces a raw `vrm.update(dt)` call so humanoid/lookAt/expressions update once per frame
   * while SpringBones run with framerate-independent Verlet scaling, organic wind, and inertia.
   */
  updateVrm(vrm: VrmInstance, root: ThreeTypes.Object3D, elapsedSec: number, dt: number): void {
    this.updateDragInertia(root, dt);

    // 1. Update core VRM systems once per frame (matching VRMCore.update + nodeConstraintManager)
    vrm.humanoid?.update();
    vrm.lookAt?.update(dt);
    vrm.expressionManager?.update();
    vrm.nodeConstraintManager?.update();

    // 2. Step SpringBoneManager with framerate-independent scaling + organic wind + drag inertia
    const mgr = vrm.springBoneManager;
    if (mgr && this.vrmJoints.length > 0) {
      const substeps = dt > MAX_SUBSTEP_DT ? Math.min(MAX_SUBSTEPS, Math.ceil(dt / REF_DT)) : 1;
      const subDt = dt / substeps;

      for (let step = 0; step < substeps; step++) {
        const stepTime = elapsedSec - (substeps - 1 - step) * subDt;
        for (let i = 0; i < this.vrmJoints.length; i++) {
          const entry = this.vrmJoints[i];
          const { joint } = entry;
          joint.bone.getWorldPosition(this._worldPos);

          evaluateWindField(stepTime, entry.phase, this._worldPos.x, this._worldPos.y, this._wind);

          // Combine authored gravity + organic per-strand wind + bounded drag/tap inertia
          const fx =
            entry.baseGravityDir.x * entry.baseGravityPower +
            this._wind.x * entry.windScale +
            this.impulseX * entry.inertiaScale;
          const fy =
            entry.baseGravityDir.y * entry.baseGravityPower +
            this._wind.y * entry.windScale +
            this.impulseY * entry.inertiaScale;
          const fz =
            entry.baseGravityDir.z * entry.baseGravityPower +
            this._wind.z * entry.windScale +
            this.impulseZ * entry.inertiaScale;

          this._forceVec.set(fx, fy, fz);
          const totalPower = this._forceVec.length();

          const scaled = computeFramerateIndependentParams(
            entry.baseStiffness,
            entry.baseDragForce,
            totalPower,
            subDt,
          );

          if (totalPower > 1e-5) {
            joint.settings.gravityDir.copy(this._forceVec).divideScalar(totalPower);
          } else {
            joint.settings.gravityDir.copy(entry.baseGravityDir);
          }
          joint.settings.stiffness = scaled.stiffness;
          joint.settings.dragForce = scaled.dragForce;
          joint.settings.gravityPower = scaled.gravityPower;
        }

        mgr.update(subDt);
      }
    } else if (mgr) {
      mgr.update(dt);
    }

    // 3. Update MToon materials (UV animation, etc.)
    const materials = (vrm as unknown as { materials?: Array<{ update?: (d: number) => void }> }).materials;
    if (materials) {
      for (let i = 0; i < materials.length; i++) {
        materials[i].update?.(dt);
      }
    }
  }

  /**
   * Step FBX Verlet secondary-bone chains with organic wind, drag inertia,
   * angular cone limits, and head/chest/hips body sphere colliders.
   */
  updateFbx(root: ThreeTypes.Object3D, elapsedSec: number, dt: number): void {
    this.updateDragInertia(root, dt);
    if (!this.fbxJoints.length) return;

    root.updateMatrixWorld(true);
    const rootScale = Math.max(0.05, Math.abs(root.scale.y) || 1);

    // Update collider world centers once per frame in world meters
    for (let c = 0; c < this.fbxColliders.length; c++) {
      const col = this.fbxColliders[c];
      col.bone.getWorldPosition(col.worldCenter);
      col.worldCenter.y += col.worldOffsetY * rootScale;
    }

    const substeps = dt > MAX_SUBSTEP_DT ? Math.min(MAX_SUBSTEPS, Math.ceil(dt / REF_DT)) : 1;
    const subDt = dt / substeps;

    for (let step = 0; step < substeps; step++) {
      const stepTime = elapsedSec - (substeps - 1 - step) * subDt;

      for (let i = 0; i < this.fbxJoints.length; i++) {
        const j = this.fbxJoints[i];
        const parent = j.bone.parent;
        if (parent) {
          this._parentMat.copy(parent.matrixWorld);
        } else {
          this._parentMat.identity();
        }

        this._initWorldMat.copy(this._parentMat).multiply(j.initialLocalMatrix);
        this._initWorldMatInv.copy(this._initWorldMat).invert();
        this._worldPos.setFromMatrixPosition(j.bone.matrixWorld);

        // Rest-pose direction in world space
        this._restDir.copy(j.boneAxis).transformDirection(this._initWorldMat).normalize();

        evaluateWindField(stepTime, j.phase, this._worldPos.x, this._worldPos.y, this._wind);

        const fx = this._wind.x * j.windScale + this.impulseX * j.inertiaScale;
        const fy = -j.gravityPower + this._wind.y * j.windScale + this.impulseY * j.inertiaScale;
        const fz = this._wind.z * j.windScale + this.impulseZ * j.inertiaScale;

        const scaled = computeFramerateIndependentParams(j.stiffness, j.dragForce, 1.0, subDt);
        const forceScale = subDt * (subDt / REF_DT);

        // Verlet step: nextTail = current + inertia * (1 - drag) + stiffness * restDir + externalForce
        this._vA.subVectors(j.currentTail, j.prevTail).multiplyScalar(1 - scaled.dragForce);
        this._nextTail
          .copy(j.currentTail)
          .add(this._vA)
          .addScaledVector(this._restDir, scaled.stiffness * subDt)
          .addScaledVector(this._forceVec.set(fx, fy, fz), forceScale);

        // Normalize direction from joint origin
        this._vB.subVectors(this._nextTail, this._worldPos);
        const dist = this._vB.length();
        if (dist > 1e-6) {
          this._vB.divideScalar(dist);
        } else {
          this._vB.copy(this._restDir);
        }

        // Enforce angular cone limit around rest direction so skirts/hair never invert
        const dot = clamp(this._vB.dot(this._restDir), -1, 1);
        if (dot < j.maxAngleCos) {
          // Project onto cone boundary
          this._vC.copy(this._vB).addScaledVector(this._restDir, -dot);
          const perpLen = this._vC.length();
          if (perpLen > 1e-6) {
            const sinMax = Math.sqrt(Math.max(0, 1 - j.maxAngleCos * j.maxAngleCos));
            this._vC.divideScalar(perpLen);
            this._vB
              .copy(this._restDir)
              .multiplyScalar(j.maxAngleCos)
              .addScaledVector(this._vC, sinMax)
              .normalize();
          } else {
            this._vB.copy(this._restDir);
          }
        }

        // Reconstruct constrained tail at exact scaled boneLength
        const scaledBoneLength = j.boneLength * rootScale;
        this._nextTail.copy(this._worldPos).addScaledVector(this._vB, scaledBoneLength);

        // Resolve sphere collisions against head / chest / hips
        for (let c = 0; c < this.fbxColliders.length; c++) {
          const col = this.fbxColliders[c];
          const minDist = (col.radius + j.hitRadius) * rootScale;
          this._vC.subVectors(this._nextTail, col.worldCenter);
          const dSq = this._vC.lengthSq();
          if (dSq > 1e-8 && dSq < minDist * minDist) {
            const d = Math.sqrt(dSq);
            this._vC.divideScalar(d);
            this._nextTail.copy(col.worldCenter).addScaledVector(this._vC, minDist);
            // Re-project to bone length after push-out
            this._vB.subVectors(this._nextTail, this._worldPos).normalize();
            this._nextTail.copy(this._worldPos).addScaledVector(this._vB, scaledBoneLength);
          }
        }

        j.prevTail.copy(j.currentTail);
        j.currentTail.copy(this._nextTail);

        // Convert world tail direction back to bone local space & apply rotation
        this._vA.copy(this._nextTail).applyMatrix4(this._initWorldMatInv).normalize();
        this._quatA.setFromUnitVectors(j.boneAxis, this._vA);
        j.bone.quaternion.copy(j.initialLocalRotation).multiply(this._quatA);
        j.bone.updateMatrix();
        j.bone.matrixWorld.multiplyMatrices(this._parentMat, j.bone.matrix);
      }
    }
  }
}
