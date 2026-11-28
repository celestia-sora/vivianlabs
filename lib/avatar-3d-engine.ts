"use client";
/**
 * 3D VRM & FBX Companion Stage Engine for Vivian 3.0.
 *
 * Design principles (from /grill-me):
 *  - Supports VRM (0.x & 1.0 via @pixiv/three-vrm) and FBX (via Three.js FBXLoader).
 *  - Toggleable lighting modes: "anime" (soft MToon-friendly) vs "realistic" (PBR + shadows + IBL).
 *  - User interaction is strictly position + zoom + reset (no user 3D orbit/rotation).
 *  - The engine autonomously animates the avatar: relaxed standing stance (no T-pose),
 *    breathing, subtle sway, natural blinking, smooth eye/head look-at, VRM SpringBone
 *    physics + breeze, AI emotion expressions + procedural head/body reactions,
 *    real-time audio lip-sync, and embedded/companion FBX animation clip playback.
 */

import type * as ThreeTypes from "three";
import type { VRM as VrmInstance, VRMHumanBoneName } from "@pixiv/three-vrm";
import {
  PROCEDURAL_EMOTION_POSE,
  resolve3DExpression,
  resolve3DMotion,
  resolveFbxMorphWeights,
  type AvatarEmotion,
} from "@/lib/avatar-emotion";
import type { Model3DResources, ModelFormat, ModelMotion } from "@/lib/local-models-3d";
import { clampModelTransform, DEFAULT_MODEL_TRANSFORM, type ModelTransform } from "@/lib/model-position";
import type { ThreeAvatarModules } from "@/lib/model-runtime-3d";
import { faceCrop, snapshotToBlob } from "@/lib/model-snapshot";
import { isSystemExpressionName, isVrmaPath } from "@/lib/vrm-metadata";
import {
  applyVrmFullBodyMocap,
  BUILT_IN_VRM_GESTURES,
  BUILT_IN_VRM_MOCAP_GROUP,
  emotionToBuiltInGesture,
  type VrmGestureId,
  type VrmMocapState,
} from "@/lib/vrm-procedural-mocap";

export type LightingMode = "anime" | "realistic";

const LIGHTING_STORAGE_KEY = "vivian-3d-lighting-mode";
const TARGET_AVATAR_HEIGHT = 1.65;
const CAMERA_FOV_DEG = 30;

export function loadLightingMode(): LightingMode {
  try {
    const raw = globalThis.localStorage?.getItem(LIGHTING_STORAGE_KEY);
    return raw === "realistic" ? "realistic" : "anime";
  } catch {
    return "anime";
  }
}

export function saveLightingMode(mode: LightingMode): void {
  try {
    globalThis.localStorage?.setItem(LIGHTING_STORAGE_KEY, mode);
  } catch {
    /* Optional preference persistence. */
  }
}

export interface Avatar3DRuntimeInfo {
  format: ModelFormat;
  expressions: string[];
  motions: ModelMotion[];
  vertexCount?: number;
  drawCalls?: number;
}

interface MorphBinding {
  mesh: ThreeTypes.Mesh;
  index: number;
  name: string;
}

interface FbxBoneState {
  bone: ThreeTypes.Object3D;
  restLocalQuat: ThreeTypes.Quaternion;
  parentInvWorldQuat: ThreeTypes.Quaternion;
  restWorldQuat: ThreeTypes.Quaternion;
}

interface FbxBoneRig {
  hips: FbxBoneState[];
  spine: FbxBoneState[];
  chest: FbxBoneState[];
  neck: FbxBoneState[];
  head: FbxBoneState[];
  jaw: FbxBoneState[];
  leftShoulder: FbxBoneState[];
  rightShoulder: FbxBoneState[];
  leftUpperArm: FbxBoneState[];
  rightUpperArm: FbxBoneState[];
  leftLowerArm: FbxBoneState[];
  rightLowerArm: FbxBoneState[];
  needsArmRelax: boolean;
}

interface LoadedAvatar {
  format: ModelFormat;
  root: ThreeTypes.Group;
  content: ThreeTypes.Object3D;
  vrm?: VrmInstance;
  mixer: ThreeTypes.AnimationMixer;
  clips: Map<string, ThreeTypes.AnimationClip>;
  motionList: ModelMotion[];
  activeAction: ThreeTypes.AnimationAction | null;
  activeMotionKey: string | null;
  expressions: string[];
  morphBindings: Map<string, MorphBinding[]>;
  mouthMorphNames: string[];
  blinkMorphNames: string[];
  fbxRig?: FbxBoneRig;
  hipsRestPos?: { x: number; y: number; z: number } | null;
  headWorldY: number;
  avatarHeight: number;
  vertexCount: number;
  drawCalls: number;
  lookAtTarget: ThreeTypes.Object3D;
  dispose: () => void;
}

/** Standard Mixamo → VRM Humanoid bone map for companion FBX animation retargeting. */
const MIXAMO_TO_VRM_BONE: Record<string, VRMHumanBoneName> = {
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
};

function stripBonePrefix(rawName: string): string {
  const afterColon = rawName.includes(":") ? rawName.split(":").at(-1)! : rawName;
  return afterColon.replace(/^mixamorig\d*/i, "mixamorig");
}

function captureBoneState(THREE: ThreeAvatarModules["THREE"], bone: ThreeTypes.Object3D): FbxBoneState {
  const restWorldQuat = new THREE.Quaternion();
  const parentInvWorldQuat = new THREE.Quaternion();
  bone.getWorldQuaternion(restWorldQuat);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(parentInvWorldQuat).invert();
  } else {
    parentInvWorldQuat.identity();
  }
  return {
    bone,
    restLocalQuat: bone.quaternion.clone(),
    parentInvWorldQuat,
    restWorldQuat,
  };
}

function findAllFbxBones(
  THREE: ThreeAvatarModules["THREE"],
  root: ThreeTypes.Object3D,
  patternTiers: RegExp[][],
): FbxBoneState[] {
  for (const patterns of patternTiers) {
    const matches: FbxBoneState[] = [];
    root.traverse((node) => {
      if (!(node as ThreeTypes.Bone).isBone && node.type !== "Bone") return;
      const name = node.name.trim();
      if (patterns.some((pattern) => pattern.test(name))) {
        matches.push(captureBoneState(THREE, node));
      }
    });
    if (matches.length) return matches;
  }
  return [];
}

function discoverFbxRig(THREE: ThreeAvatarModules["THREE"], root: ThreeTypes.Object3D): FbxBoneRig {
  root.updateMatrixWorld(true);
  const rig: FbxBoneRig = {
    hips: findAllFbxBones(THREE, root, [
      [/^(?:mixamorig\d*)?hips?$/i, /(?:^|[:_\s])hips?$/i, /pelvis/i, /センター|腰/],
      [/^rootx$/i],
    ]),
    spine: findAllFbxBones(THREE, root, [
      [/^(?:mixamorig\d*)?spine(?:_?0?1)?$/i, /(?:^|[:_\s])spine(?:_?0?1)?$/i, /上半身$/],
      [/^spine_?0?1x$/i],
    ]),
    chest: findAllFbxBones(THREE, root, [
      [/^(?:mixamorig\d*)?(?:chest|spine_?0?2|upper_?chest)$/i, /(?:^|[:_\s])(?:chest|spine_?0?2|upper_?chest)$/i, /上半身2/],
      [/^spine_?0?2x$/i],
    ]),
    neck: findAllFbxBones(THREE, root, [
      [/^(?:mixamorig\d*)?neck$/i, /(?:^|[:_\s])neck$/i, /首/],
      [/^neckx$/i],
    ]),
    head: findAllFbxBones(THREE, root, [
      [/^(?:mixamorig\d*)?head$/i, /(?:^|[:_\s])head$/i, /頭/],
      [/^headx$/i],
    ]),
    jaw: findAllFbxBones(THREE, root, [
      [/^(?:mixamorig\d*)?jaw$/i, /(?:^|[:_\s])jaw$/i, /顎/],
    ]),
    leftShoulder: findAllFbxBones(THREE, root, [
      [/left[_\s-]*shoulder|shoulder[_\s-]*l$|^l[_\s-]*shoulder|左肩/i],
      [/^shoulderl$/i],
    ]),
    rightShoulder: findAllFbxBones(THREE, root, [
      [/right[_\s-]*shoulder|shoulder[_\s-]*r$|^r[_\s-]*shoulder|右肩/i],
      [/^shoulderr$/i],
    ]),
    leftUpperArm: findAllFbxBones(THREE, root, [
      [/left[_\s-]*(?:upper[_\s-]*arm|arm)$|upper[_\s-]*arm[_\s-]*l$|^l[_\s-]*(?:upper[_\s-]*arm|arm)$|左腕/i],
      [/^arm_?stretchl$/i],
      [/^arml$/i],
    ]),
    rightUpperArm: findAllFbxBones(THREE, root, [
      [/right[_\s-]*(?:upper[_\s-]*arm|arm)$|upper[_\s-]*arm[_\s-]*r$|^r[_\s-]*(?:upper[_\s-]*arm|arm)$|右腕/i],
      [/^arm_?stretchr$/i],
      [/^armr$/i],
    ]),
    leftLowerArm: findAllFbxBones(THREE, root, [
      [/left[_\s-]*(?:fore[_\s-]*arm|lower[_\s-]*arm|elbow)$|(?:fore[_\s-]*arm|elbow)[_\s-]*l$|^l[_\s-]*(?:fore[_\s-]*arm|elbow)$|左ひじ/i],
      [/^forearm_?stretchl$/i],
      [/^forearml$/i],
    ]),
    rightLowerArm: findAllFbxBones(THREE, root, [
      [/right[_\s-]*(?:fore[_\s-]*arm|lower[_\s-]*arm|elbow)$|(?:fore[_\s-]*arm|elbow)[_\s-]*r$|^r[_\s-]*(?:fore[_\s-]*arm|elbow)$|右ひじ/i],
      [/^forearm_?stretchr$/i],
      [/^forearmr$/i],
    ]),
    needsArmRelax: false,
  };

  // Detect whether the model's rest pose has outstretched T-pose / wide A-pose arms
  if (rig.leftUpperArm[0] && rig.leftLowerArm[0]) {
    const pArm = new THREE.Vector3();
    const pElbow = new THREE.Vector3();
    rig.leftUpperArm[0].bone.getWorldPosition(pArm);
    rig.leftLowerArm[0].bone.getWorldPosition(pElbow);
    const dir = pElbow.sub(pArm).normalize();
    if (Number.isFinite(dir.y) && dir.y > -0.45) {
      rig.needsArmRelax = true;
    }
  }
  return rig;
}

/** Retarget a Mixamo/humanoid FBX AnimationClip onto a VRM normalized humanoid rig. */
function retargetFbxClipToVrm(
  THREE: ThreeAvatarModules["THREE"],
  clip: ThreeTypes.AnimationClip,
  fbxAsset: ThreeTypes.Object3D,
  vrm: VrmInstance,
): ThreeTypes.AnimationClip | null {
  const tracks: ThreeTypes.KeyframeTrack[] = [];
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const isVrm0 = vrm.meta?.metaVersion === "0";

  fbxAsset.updateMatrixWorld(true);

  for (const track of clip.tracks) {
    const dotIndex = track.name.indexOf(".");
    if (dotIndex <= 0) continue;
    const rawBoneName = track.name.slice(0, dotIndex);
    const propertyName = track.name.slice(dotIndex + 1);
    const normalizedMixamo = stripBonePrefix(rawBoneName);
    const vrmBoneName = MIXAMO_TO_VRM_BONE[normalizedMixamo];
    if (!vrmBoneName) continue;

    const vrmNode = vrm.humanoid?.getNormalizedBoneNode(vrmBoneName);
    const mixamoNode = fbxAsset.getObjectByName(rawBoneName);
    if (!vrmNode || !mixamoNode) continue;

    mixamoNode.getWorldQuaternion(restRotationInverse).invert();
    if (mixamoNode.parent) {
      mixamoNode.parent.getWorldQuaternion(parentRestWorldRotation);
    } else {
      parentRestWorldRotation.identity();
    }

    if (track instanceof THREE.QuaternionKeyframeTrack && propertyName === "quaternion") {
      const values = Float32Array.from(track.values);
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i);
        q.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
        if (isVrm0) {
          values[i] = -q.x;
          values[i + 1] = q.y;
          values[i + 2] = -q.z;
          values[i + 3] = q.w;
        } else {
          values[i] = q.x;
          values[i + 1] = q.y;
          values[i + 2] = q.z;
          values[i + 3] = q.w;
        }
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${vrmNode.name}.quaternion`, track.times, values));
    }
  }

  if (!tracks.length) return null;
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

function disposeObject3D(root: ThreeTypes.Object3D): void {
  const disposedMats = new Set<ThreeTypes.Material>();
  const disposedTexs = new Set<ThreeTypes.Texture>();
  root.traverse((obj) => {
    const mesh = obj as ThreeTypes.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const mat of materials) {
      if (disposedMats.has(mat)) continue;
      disposedMats.add(mat);
      for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
        if (value && typeof value === "object" && "isTexture" in value && typeof (value as ThreeTypes.Texture).dispose === "function") {
          const tex = value as ThreeTypes.Texture;
          if (!disposedTexs.has(tex)) {
            disposedTexs.add(tex);
            tex.dispose();
          }
        }
      }
      mat.dispose();
    }
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export class Avatar3DStage {
  private readonly THREE: ThreeAvatarModules["THREE"];
  private readonly modules: ThreeAvatarModules;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: ThreeTypes.WebGLRenderer;
  private readonly scene: ThreeTypes.Scene;
  private readonly camera: ThreeTypes.PerspectiveCamera;
  private readonly isAppleMobile: boolean;

  // Lighting rig
  private lightingMode: LightingMode;
  private quality: "auto" | "original" = "auto";
  private readonly hemiLight: ThreeTypes.HemisphereLight;
  private readonly keyLight: ThreeTypes.DirectionalLight;
  private readonly fillLight: ThreeTypes.DirectionalLight;
  private readonly rimLight: ThreeTypes.DirectionalLight;
  private readonly shadowFloor: ThreeTypes.Mesh;
  private pmremGenerator: ThreeTypes.PMREMGenerator | null = null;
  private envRenderTarget: ThreeTypes.WebGLRenderTarget | null = null;

  // Active avatar state
  private avatar: LoadedAvatar | null = null;
  private transform: ModelTransform = { ...DEFAULT_MODEL_TRANSFORM };
  private stageWidth = 1;
  private stageHeight = 1;
  private baseCameraY = 1.25;
  private baseCameraZ = 2.6;
  private baseLookY = 1.15;

  // Autonomous living animation state
  private rafId: number | null = null;
  private running = false;
  private pausedByVisibility = false;
  private disposed = false;
  private readonly onVisibilityChange: (() => void) | null = null;
  private lastTimeMs = 0;
  private elapsedSec = 0;
  private nextBlinkAt = 2.8;
  private blinkProgress = 0;
  private isBlinking = false;
  private pendingDoubleBlink = false;

  // Reusable scratch objects (zero per-frame GC allocations in animation loop)
  private readonly _tmpEuler: ThreeTypes.Euler;
  private readonly _tmpWorldDelta: ThreeTypes.Quaternion;
  private readonly _tmpTargetWorld: ThreeTypes.Quaternion;
  private readonly _desiredExprs = new Map<string, number>();

  // Look-at target (normalized screen coordinates [-1, 1])
  private pointerTargetX = 0;
  private pointerTargetY = 0;
  private pointerSmoothX = 0;
  private pointerSmoothY = 0;
  private pointerLastMovedAt = 0;

  // Expressions, lip-sync & procedural emotion / full-body mocap state
  private mouthTarget = 0;
  private mouthCurrent = 0;
  private speechActivity = 0;
  private savedExpressions: string[] = [];
  private activeEmotion: AvatarEmotion | null = null;
  private activeEmotionExpression: { name: string; weight: number } | null = null;
  private activeFbxEmotionWeights: Record<string, number> = {};
  private expressionWeights = new Map<string, number>();
  private reactionEmotion: AvatarEmotion | null = null;
  private reactionStartedAt = 0;
  private reactionDuration = 0;
  private reactionIntensity = 1;
  private activeVrmGesture: VrmGestureId | null = null;
  private activeVrmGestureExpireAt: number | null = null;
  private vrmGestureWeight = 0;
  private vrmGestureStartedAt = 0;
  private readonly _mocapState: VrmMocapState = {
    elapsedSec: 0,
    dt: 0.016,
    hipsRestPos: null,
    pointerSmoothX: 0,
    pointerSmoothY: 0,
    mouthCurrent: 0,
    speechActivity: 0,
    gestureId: null,
    gestureWeight: 0,
    gestureAgeSec: 0,
    reactHeadPitch: 0,
    reactHeadYaw: 0,
    reactHeadRoll: 0,
    reactSpinePitch: 0,
  };

  constructor(
    canvas: HTMLCanvasElement,
    modules: ThreeAvatarModules,
    options?: { lightingMode?: LightingMode; quality?: "auto" | "original" },
  ) {
    this.canvas = canvas;
    this.modules = modules;
    this.THREE = modules.THREE;
    this.lightingMode = options?.lightingMode ?? "anime";
    this.quality = options?.quality ?? "auto";

    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    this.isAppleMobile = Boolean(
      nav && (/iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)),
    );

    const THREE = this.THREE;
    this._tmpEuler = new THREE.Euler(0, 0, 0, "YXZ");
    this._tmpWorldDelta = new THREE.Quaternion();
    this._tmpTargetWorld = new THREE.Quaternion();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: !this.isAppleMobile,
      powerPreference: this.isAppleMobile ? "low-power" : "high-performance",
      // False avoids a full-screen framebuffer copy every frame on iOS/Android TBDR GPUs.
      // captureFaceSnapshot() renders synchronously right before reading the canvas.
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.1, 40);
    this.camera.position.set(0, this.baseCameraY, this.baseCameraZ);
    this.camera.lookAt(0, this.baseLookY, 0);

    // Three-point + hemisphere companion lighting rig
    this.hemiLight = new THREE.HemisphereLight(0xf6f0ff, 0x8e7aa8, 1.35);
    this.scene.add(this.hemiLight);

    this.keyLight = new THREE.DirectionalLight(0xfff9f5, 1.15);
    this.keyLight.position.set(1.4, 2.4, 2.6);
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 10;
    const shadowBound = 2.2;
    this.keyLight.shadow.camera.left = -shadowBound;
    this.keyLight.shadow.camera.right = shadowBound;
    this.keyLight.shadow.camera.top = shadowBound;
    this.keyLight.shadow.camera.bottom = -shadowBound;
    this.scene.add(this.keyLight);

    this.fillLight = new THREE.DirectionalLight(0xe5dbff, 0.55);
    this.fillLight.position.set(-1.8, 1.5, 1.8);
    this.scene.add(this.fillLight);

    this.rimLight = new THREE.DirectionalLight(0xdcc8ff, 0.45);
    this.rimLight.position.set(0.0, 2.2, -2.4);
    this.scene.add(this.rimLight);

    // Soft shadow-catching floor plane (visible only in "realistic" lighting mode)
    const floorGeo = new THREE.PlaneGeometry(6, 6);
    const floorMat = new THREE.ShadowMaterial({ opacity: 0.24 });
    this.shadowFloor = new THREE.Mesh(floorGeo, floorMat);
    this.shadowFloor.rotation.x = -Math.PI / 2;
    this.shadowFloor.position.y = 0;
    this.shadowFloor.receiveShadow = true;
    this.shadowFloor.visible = false;
    this.scene.add(this.shadowFloor);

    this.applyLightingMode(this.lightingMode);
    this.syncRendererResolution();

    if (typeof document !== "undefined") {
      this.onVisibilityChange = () => {
        if (this.disposed) return;
        if (document.hidden) {
          if (this.running) {
            this.pausedByVisibility = true;
            this.pause();
          }
        } else if (this.pausedByVisibility) {
          this.pausedByVisibility = false;
          this.start();
        }
      };
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }

    if (typeof document === "undefined" || !document.hidden) {
      this.start();
    } else {
      this.pausedByVisibility = true;
    }
  }

  getMaxTextureSize(): number {
    return this.renderer.capabilities.maxTextureSize;
  }

  isContextLost(): boolean {
    return this.renderer.getContext().isContextLost();
  }

  setQuality(quality: "auto" | "original"): void {
    this.quality = quality;
    this.syncRendererResolution();
  }

  setLightingMode(mode: LightingMode): void {
    this.lightingMode = mode;
    this.applyLightingMode(mode);
  }

  getLightingMode(): LightingMode {
    return this.lightingMode;
  }

  private applyLightingMode(mode: LightingMode): void {
    const THREE = this.THREE;
    if (mode === "realistic") {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.08;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      this.hemiLight.color.setHex(0xeef2ff);
      this.hemiLight.groundColor.setHex(0x6d5a7c);
      this.hemiLight.intensity = 0.85;

      this.keyLight.color.setHex(0xfff4e8);
      this.keyLight.intensity = 1.85;
      this.keyLight.castShadow = true;

      this.fillLight.color.setHex(0xd6e4ff);
      this.fillLight.intensity = 0.65;

      this.rimLight.color.setHex(0xebd8ff);
      this.rimLight.intensity = 0.9;

      this.shadowFloor.visible = true;

      if (!this.envRenderTarget) {
        try {
          this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
          const room = new this.modules.RoomEnvironment();
          this.envRenderTarget = this.pmremGenerator.fromScene(room, 0.04);
          room.dispose();
        } catch {
          /* Environment map is best-effort on low-memory WebGL contexts. */
        }
      }
      this.scene.environment = this.envRenderTarget?.texture ?? null;
    } else {
      // "anime" — clean, bright, flattering lighting ideal for VRM MToon & anime FBX over 2D scenes
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.toneMappingExposure = 1.0;
      this.renderer.shadowMap.enabled = false;

      this.hemiLight.color.setHex(0xf8f4ff);
      this.hemiLight.groundColor.setHex(0xa896be);
      this.hemiLight.intensity = 1.45;

      this.keyLight.color.setHex(0xffffff);
      this.keyLight.intensity = 1.15;
      this.keyLight.castShadow = false;

      this.fillLight.color.setHex(0xebe3ff);
      this.fillLight.intensity = 0.6;

      this.rimLight.color.setHex(0xe5d6ff);
      this.rimLight.intensity = 0.4;

      this.shadowFloor.visible = false;
      this.scene.environment = null;
    }
    this.syncAvatarShadows();
  }

  private syncAvatarShadows(): void {
    if (!this.avatar) return;
    const realistic = this.lightingMode === "realistic";

    // Count visible vertices so ultra-dense Blender sculpts (>500K verts) skip the
    // redundant full-geometry shadow-map pass while keeping ACES + IBL + PBR lighting.
    let visibleVertices = 0;
    this.avatar.content.traverseVisible((node) => {
      const mesh = node as ThreeTypes.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry?.getAttribute("position");
      if (pos) visibleVertices += pos.count;
    });
    const allowShadows = realistic && visibleVertices <= 500_000;
    this.renderer.shadowMap.enabled = allowShadows;
    this.keyLight.castShadow = allowShadows;
    this.shadowFloor.visible = allowShadows;

    this.avatar.content.traverse((node) => {
      const mesh = node as ThreeTypes.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.visible) {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        return;
      }
      mesh.castShadow = allowShadows;
      mesh.receiveShadow = allowShadows;
      if (this.avatar?.format === "fbx") {
        const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const mat of mats) {
          if (mat.userData.__vivianIsOutline) continue;
          const phong = mat as ThreeTypes.MeshPhongMaterial;
          if (phong.isMeshPhongMaterial) {
            if (!mat.userData.__vivianOrigShininess) {
              mat.userData.__vivianOrigShininess = phong.shininess;
              mat.userData.__vivianOrigSpecular = phong.specular.getHex();
            }
            if (realistic) {
              phong.shininess = Math.min(Number(mat.userData.__vivianOrigShininess) || 20, 22);
              phong.specular.setHex(0x2e2a35);
            } else {
              // Soft matte anime look instead of plastic Phong glare
              phong.shininess = 6;
              phong.specular.setHex(0x0e0c12);
            }
          }
        }
      }
    });
  }

  private countAvatarStats(root: ThreeTypes.Object3D): { vertexCount: number; drawCalls: number } {
    let vertexCount = 0;
    let drawCalls = 0;
    root.traverseVisible((node) => {
      const mesh = node as ThreeTypes.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const pos = mesh.geometry.getAttribute("position");
      if (pos) vertexCount += pos.count;
      const groups = mesh.geometry.groups;
      drawCalls += groups && groups.length > 0 ? groups.length : 1;
    });
    return { vertexCount, drawCalls };
  }

  /**
   * Downscale oversized 4K/8K textures before WebGL upload when quality is
   * "auto" to keep VRAM safe and FPS high, and enable crisp anisotropic filtering.
   */
  private optimizeAvatarTextures(root: ThreeTypes.Object3D, vertexCount = 0): void {
    if (typeof document === "undefined") return;
    const gpuMax = Math.max(1024, this.getMaxTextureSize() || 4096);
    const maxAniso = Math.min(4, this.renderer.capabilities.getMaxAnisotropy?.() || 1);

    const uniqueTextures: ThreeTypes.Texture[] = [];
    const seen = new Set<ThreeTypes.Texture>();
    let largeTextureCount = 0;

    root.traverseVisible((node) => {
      const mesh = node as ThreeTypes.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const mat of mats) {
        for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
          if (!value || typeof value !== "object" || !("isTexture" in value)) continue;
          const tex = value as ThreeTypes.Texture;
          if (seen.has(tex)) continue;
          seen.add(tex);
          uniqueTextures.push(tex);
          const img = tex.image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | undefined;
          const w = img?.naturalWidth || img?.width || 0;
          const h = img?.naturalHeight || img?.height || 0;
          if (Math.max(w, h) > 2048) largeTextureCount++;
        }
      }
    });

    const autoCap = this.isAppleMobile
      ? 1024
      : (vertexCount > 400_000 && largeTextureCount > 5 ? 1536 : 2048);
    const maxDim = this.quality === "original" ? gpuMax : Math.min(gpuMax, autoCap);

    for (const tex of uniqueTextures) {
      if (maxAniso > 1 && tex.anisotropy < maxAniso) {
        tex.anisotropy = maxAniso;
      }
      const img = tex.image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | undefined;
      const w = img?.naturalWidth || img?.width || 0;
      const h = img?.naturalHeight || img?.height || 0;
      if (!w || !h || (w <= maxDim && h <= maxDim)) continue;
      const scale = maxDim / Math.max(w, h);
      const targetW = Math.max(1, Math.round(w * scale));
      const targetH = Math.max(1, Math.round(h * scale));
      try {
        const canvas = document.createElement("canvas");
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img as CanvasImageSource, 0, 0, targetW, targetH);
        tex.image = canvas;
        tex.needsUpdate = true;
      } catch {
        /* Keep original texture if browser disallows canvas copy. */
      }
    }
  }

  private syncRendererResolution(): void {
    const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
    const denseModel = (this.avatar?.vertexCount ?? 0) > 400_000;
    const cap = this.quality === "original"
      ? (this.isAppleMobile ? 2 : Math.min(dpr, 2.5))
      : denseModel
        ? (this.isAppleMobile ? 1 : 1.25)
        : (this.isAppleMobile ? 1.5 : 2);
    this.renderer.setPixelRatio(Math.min(Math.max(dpr, 1), cap));
  }

  resize(width: number, height: number): void {
    const safeW = Math.max(1, Math.round(width));
    const safeH = Math.max(1, Math.round(height));
    this.stageWidth = safeW;
    this.stageHeight = safeH;
    this.syncRendererResolution();
    this.renderer.setSize(safeW, safeH, false);
    this.camera.aspect = safeW / safeH;
    this.recomputeFraming();
    this.camera.updateProjectionMatrix();
    this.applyTransformToAvatar();
  }

  private recomputeFraming(): void {
    const aspect = this.stageWidth / Math.max(1, this.stageHeight);
    const height = this.avatar?.avatarHeight ?? TARGET_AVATAR_HEIGHT;
    const isLandscape = aspect > 1.05;
    // Frame from knees/waist up on mobile portrait and graceful full/3-quarter view on desktop
    // while keeping space at the bottom for Vivian's glass composer bar.
    const visibleHeight = isLandscape ? height * 1.16 : height * 1.08;
    const fovRad = (CAMERA_FOV_DEG * Math.PI) / 180;
    const distance = (visibleHeight / 2) / Math.tan(fovRad / 2);
    this.baseCameraZ = clamp(distance, 1.85, 4.4);
    this.baseLookY = height * (isLandscape ? 0.56 : 0.60);
    this.baseCameraY = this.baseLookY + 0.04;
    this.camera.position.set(0, this.baseCameraY, this.baseCameraZ);
    this.camera.lookAt(0, this.baseLookY, 0);
  }

  /**
   * Apply user drag & zoom transform (position + scale ONLY — no rotation).
   * Pixel deltas map 1:1 to world units at the avatar plane.
   */
  setTransform(transform: ModelTransform): void {
    this.transform = clampModelTransform(transform, this.stageWidth, this.stageHeight);
    this.applyTransformToAvatar();
  }

  private applyTransformToAvatar(): void {
    if (!this.avatar) return;
    const fovRad = (CAMERA_FOV_DEG * Math.PI) / 180;
    const worldHeightAtPlane = 2 * this.baseCameraZ * Math.tan(fovRad / 2);
    const worldPerPixel = worldHeightAtPlane / Math.max(1, this.stageHeight);

    const s = this.transform.scale;
    this.avatar.root.scale.setScalar(s);
    // Keep anchor around upper-center so zooming focuses smoothly on face & torso
    const anchorY = this.baseLookY;
    const offsetX = this.transform.x * worldPerPixel;
    const offsetY = -this.transform.y * worldPerPixel + anchorY * (1 - s);
    this.avatar.root.position.set(offsetX, offsetY, 0);
  }

  setPointerLookTarget(normalizedX: number, normalizedY: number): void {
    this.pointerTargetX = clamp(normalizedX, -1, 1);
    this.pointerTargetY = clamp(normalizedY, -1, 1);
    this.pointerLastMovedAt = performance.now();
  }

  setMouthOpen(value: number): void {
    this.mouthTarget = clamp(value, 0, 1);
  }

  setSavedExpressions(names: readonly string[]): void {
    this.savedExpressions = [...new Set(names)];
  }

  setActiveExpression(name: string | null): void {
    if (!name) {
      this.activeEmotion = null;
      this.activeEmotionExpression = null;
      this.activeFbxEmotionWeights = {};
      return;
    }
    this.activeEmotionExpression = { name, weight: 0.9 };
    this.activeFbxEmotionWeights = { [name]: 0.9 };
  }

  clearReaction(): void {
    this.activeEmotion = null;
    this.activeEmotionExpression = null;
    this.activeFbxEmotionWeights = {};
    this.reactionEmotion = null;
    this.activeVrmGesture = null;
    this.activeVrmGestureExpireAt = null;
  }

  /**
   * Apply an AI-detected emotion: updates target facial expression + triggers
   * a smooth full-body procedural mocap gesture + optional matching clip.
   */
  playEmotionReaction(emotion: AvatarEmotion, intensity = 55): { expression: string | null; motion: string | null } {
    if (!this.avatar) return { expression: null, motion: null };
    this.activeEmotion = emotion;

    let appliedExpression: string | null = null;
    if (this.avatar.format === "vrm") {
      const resolved = resolve3DExpression(emotion, this.avatar.expressions);
      this.activeEmotionExpression = resolved;
      appliedExpression = resolved?.name ?? null;
    } else {
      const weights = resolveFbxMorphWeights(emotion, this.avatar.expressions);
      this.activeFbxEmotionWeights = weights;
      appliedExpression = Object.keys(weights)[0] ?? null;
    }

    const pose = PROCEDURAL_EMOTION_POSE[emotion];
    this.reactionEmotion = emotion;
    this.reactionStartedAt = this.elapsedSec;
    this.reactionDuration = pose.durationSec;
    this.reactionIntensity = intensity >= 70 ? 1.25 : 0.95;

    let appliedMotion: string | null = null;
    // Prefer external .vrma/.fbx clips if the model ships with a matching clip
    const externalMotions = this.avatar.motionList.filter((m) => m.group !== BUILT_IN_VRM_MOCAP_GROUP);
    const clipNames = externalMotions.map((m) => m.name);
    const matched = resolve3DMotion(emotion, clipNames);
    if (matched) {
      const motion = externalMotions.find((m) => m.name === matched);
      if (motion) {
        this.playMotion(motion, { loopOnce: !/idle|stand|breath|wait/i.test(motion.name) });
        appliedMotion = motion.name;
      }
    } else if (this.avatar.format === "vrm" && !this.avatar.activeAction) {
      // Trigger built-in full-body VRM mocap gesture matching Vivian's emotion
      const gestureId = emotionToBuiltInGesture(emotion);
      if (gestureId) {
        const gestureDef = BUILT_IN_VRM_GESTURES.find((g) => g.id === gestureId);
        if (gestureDef) {
          this.activeVrmGesture = gestureDef.id;
          this.vrmGestureStartedAt = this.elapsedSec;
          this.activeVrmGestureExpireAt = this.elapsedSec + gestureDef.durationSec;
          appliedMotion = gestureDef.label;
        }
      }
    }

    return { expression: appliedExpression, motion: appliedMotion };
  }

  playMotion(motion: ModelMotion | null, options?: { loopOnce?: boolean }): boolean {
    if (!this.avatar) return false;
    const { mixer, clips } = this.avatar;
    if (!motion) {
      if (this.avatar.activeAction) {
        this.avatar.activeAction.fadeOut(0.25);
        this.avatar.activeAction = null;
      }
      this.avatar.activeMotionKey = null;
      this.activeVrmGesture = null;
      this.activeVrmGestureExpireAt = null;
      return true;
    }

    // Handle built-in full-body VRM procedural mocap gestures
    if (motion.group === BUILT_IN_VRM_MOCAP_GROUP) {
      const gestureDef = BUILT_IN_VRM_GESTURES[motion.index] ?? BUILT_IN_VRM_GESTURES.find((g) => g.label === motion.name);
      if (!gestureDef) return false;
      if (this.avatar.activeAction) {
        this.avatar.activeAction.fadeOut(0.25);
        this.avatar.activeAction = null;
      }
      this.activeVrmGesture = gestureDef.id;
      this.vrmGestureStartedAt = this.elapsedSec;
      this.activeVrmGestureExpireAt = options?.loopOnce ? this.elapsedSec + gestureDef.durationSec : null;
      this.avatar.activeMotionKey = `${motion.group}:${motion.index}`;
      return true;
    }

    const key = `${motion.group}:${motion.index}`;
    const clip = clips.get(key) ?? clips.get(motion.name);
    if (!clip) return false;

    // External mocap clip overrides procedural gesture cleanly
    this.activeVrmGesture = null;
    this.activeVrmGestureExpireAt = null;

    const nextAction = mixer.clipAction(clip);
    nextAction.reset();
    if (options?.loopOnce) {
      nextAction.setLoop(this.THREE.LoopOnce, 1);
      nextAction.clampWhenFinished = false;
    } else {
      nextAction.setLoop(this.THREE.LoopRepeat, Infinity);
    }
    nextAction.fadeIn(0.25).play();

    if (this.avatar.activeAction && this.avatar.activeAction !== nextAction) {
      this.avatar.activeAction.fadeOut(0.25);
    }
    this.avatar.activeAction = nextAction;
    this.avatar.activeMotionKey = key;
    return true;
  }

  hasAvatar(): boolean {
    return this.avatar !== null;
  }

  /**
   * Load a VRM or FBX model from scoped Blob URLs. The previous avatar stays
   * visible until the new one is completely loaded and normalized (seamless swap).
   */
  async loadModel(
    resources: Model3DResources,
    signal?: AbortSignal,
  ): Promise<Avatar3DRuntimeInfo> {
    signal?.throwIfAborted();
    const THREE = this.THREE;

    const manager = new THREE.LoadingManager();
    let managerPending = 0;
    let resolveManagerIdle: (() => void) | null = null;
    manager.onStart = (_url, loaded, total) => { managerPending = Math.max(0, total - loaded); };
    manager.onProgress = (_url, loaded, total) => { managerPending = Math.max(0, total - loaded); };
    manager.onLoad = () => {
      managerPending = 0;
      resolveManagerIdle?.();
      resolveManagerIdle = null;
    };
    manager.setURLModifier((url) => resources.resolveAssetUrl(url) ?? url);

    const loaded = resources.format === "vrm"
      ? await this.loadVrmAvatar(resources, manager, signal)
      : await this.loadFbxAvatar(resources, manager, signal);

    // Wait for async external FBX/VRM textures to finish decoding so the first frame and thumbnail are textured
    if (managerPending > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 12_000);
        resolveManagerIdle = () => { window.clearTimeout(timer); resolve(); };
      });
    }

    if (signal?.aborted || this.disposed) {
      loaded.dispose();
      throw new DOMException("Aborted", "AbortError");
    }

    this.optimizeAvatarTextures(loaded.content, loaded.vertexCount);

    // Swap cleanly on stage
    const previous = this.avatar;
    this.avatar = loaded;
    this.scene.add(loaded.root);
    this.syncRendererResolution();
    this.syncAvatarShadows();
    this.recomputeFraming();
    this.applyTransformToAvatar();
    this.expressionWeights.clear();
    this.activeEmotion = null;
    this.activeEmotionExpression = null;
    this.activeFbxEmotionWeights = {};
    this.reactionEmotion = null;
    this.activeVrmGesture = null;
    this.activeVrmGestureExpireAt = null;
    this.vrmGestureWeight = 0;

    if (previous) {
      this.scene.remove(previous.root);
      previous.dispose();
    }

    // Render one immediate frame so startup/first-frame metrics fire right away
    this.step(0.016);
    this.renderer.render(this.scene, this.camera);

    return {
      format: loaded.format,
      expressions: [...loaded.expressions],
      motions: [...loaded.motionList],
      vertexCount: loaded.vertexCount,
      drawCalls: loaded.drawCalls,
    };
  }

  unloadAvatar(): void {
    if (!this.avatar) return;
    this.scene.remove(this.avatar.root);
    this.avatar.dispose();
    this.avatar = null;
    this.expressionWeights.clear();
    this.renderer.clear();
  }

  private async loadVrmAvatar(
    resources: Model3DResources,
    manager: ThreeTypes.LoadingManager,
    signal?: AbortSignal,
  ): Promise<LoadedAvatar> {
    const THREE = this.THREE;
    const { GLTFLoader, FBXLoader, VRM } = this.modules;
    const loader = new GLTFLoader(manager);
    loader.register((parser) => new VRM.VRMLoaderPlugin(parser));

    const gltf = await loader.loadAsync(resources.entryUrl);
    signal?.throwIfAborted();

    const vrm = gltf.userData.vrm as VrmInstance | undefined;
    if (!vrm) {
      disposeObject3D(gltf.scene);
      throw new Error("ไฟล์ VRM นี้ไม่มีข้อมูล VRM avatar ที่สมบูรณ์");
    }

    VRM.VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRM.VRMUtils.combineSkeletons(gltf.scene);
    VRM.VRMUtils.rotateVRM0(vrm);

    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });

    const root = new THREE.Group();
    const content = vrm.scene;
    root.add(content);

    // Normalize scale & ground feet at y = 0
    const { avatarHeight, headWorldY } = this.normalizeBounds(content, vrm);

    // LookAt target anchored in front of face
    const lookAtTarget = new THREE.Object3D();
    lookAtTarget.position.set(0, headWorldY, 2.2);
    root.add(lookAtTarget);
    if (vrm.lookAt) {
      vrm.lookAt.target = lookAtTarget;
    }

    // Discover expressions (exclude lip-sync / blink / lookAt channels)
    const expressions: string[] = [];
    for (const expr of vrm.expressionManager?.expressions ?? []) {
      const name = expr.expressionName;
      if (name && !isSystemExpressionName(name) && !expressions.includes(name)) {
        expressions.push(name);
      }
    }

    // Capture normalized hips rest position for grounded contrapposto weight shifting
    const hipsNode = vrm.humanoid?.getNormalizedBoneNode("hips");
    const hipsRestPos = hipsNode
      ? { x: hipsNode.position.x, y: hipsNode.position.y, z: hipsNode.position.z }
      : null;

    // Load companion .vrma (native VRM Animation) and .fbx (Mixamo retargeted) mocap clips
    const mixer = new THREE.AnimationMixer(vrm.scene);
    const clips = new Map<string, ThreeTypes.AnimationClip>();
    const motionList: ModelMotion[] = [];

    // Register built-in full-body procedural mocap gestures (work on every VRM out of the box)
    for (const [index, gesture] of BUILT_IN_VRM_GESTURES.entries()) {
      motionList.push({ group: BUILT_IN_VRM_MOCAP_GROUP, index, name: gesture.label });
    }

    if (resources.companionMotionUrls.length) {
      const { VRMAnimation } = this.modules;
      let fbxLoader: InstanceType<ThreeAvatarModules["FBXLoader"]> | null = null;
      let vrmaLoader: InstanceType<ThreeAvatarModules["GLTFLoader"]> | null = null;

      for (const motion of resources.companionMotionUrls) {
        if (signal?.aborted) break;
        try {
          if (isVrmaPath(motion.path)) {
            if (!vrmaLoader) {
              vrmaLoader = new GLTFLoader(manager);
              vrmaLoader.register((parser) => new VRMAnimation.VRMAnimationLoaderPlugin(parser));
            }
            const gltfAnim = await vrmaLoader.loadAsync(motion.url);
            const vrmAnimations = (gltfAnim.userData.vrmAnimations ?? []) as Array<import("@pixiv/three-vrm-animation").VRMAnimation>;
            for (const [clipIdx, vrmAnim] of vrmAnimations.entries()) {
              const clip = VRMAnimation.createVRMAnimationClip(vrmAnim, vrm);
              if (!clip) continue;
              const label = vrmAnimations.length > 1 ? `${motion.name} (${clipIdx + 1})` : motion.name;
              const entry: ModelMotion = { group: motion.group, index: motionList.length, name: label, path: motion.path };
              motionList.push(entry);
              clips.set(`${entry.group}:${entry.index}`, clip);
              clips.set(entry.name, clip);
            }
          } else {
            fbxLoader ??= new FBXLoader(manager);
            const animFbx = await fbxLoader.loadAsync(motion.url);
            const sourceClip = animFbx.animations[0];
            if (sourceClip) {
              const retargeted = retargetFbxClipToVrm(THREE, sourceClip, animFbx, vrm);
              if (retargeted) {
                const entry: ModelMotion = { group: motion.group, index: motionList.length, name: motion.name, path: motion.path };
                motionList.push(entry);
                clips.set(`${entry.group}:${entry.index}`, retargeted);
                clips.set(entry.name, retargeted);
              }
            }
            disposeObject3D(animFbx);
          }
        } catch {
          /* Skip incompatible companion motion clips without failing avatar load. */
        }
      }
    }

    // Apply initial full-body relaxed contrapposto standing pose before first render
    this._mocapState.elapsedSec = 0;
    this._mocapState.dt = 0.016;
    this._mocapState.hipsRestPos = hipsRestPos;
    this._mocapState.pointerSmoothX = 0;
    this._mocapState.pointerSmoothY = 0;
    this._mocapState.mouthCurrent = 0;
    this._mocapState.speechActivity = 0;
    this._mocapState.gestureId = null;
    this._mocapState.gestureWeight = 0;
    this._mocapState.gestureAgeSec = 0;
    this._mocapState.reactHeadPitch = 0;
    this._mocapState.reactHeadYaw = 0;
    this._mocapState.reactHeadRoll = 0;
    this._mocapState.reactSpinePitch = 0;
    applyVrmFullBodyMocap(vrm, this._mocapState);
    vrm.update(0.016);
    const stats = this.countAvatarStats(content);

    return {
      format: "vrm",
      root,
      content,
      vrm,
      mixer,
      clips,
      motionList,
      activeAction: null,
      activeMotionKey: null,
      expressions,
      morphBindings: new Map(),
      mouthMorphNames: [],
      blinkMorphNames: [],
      hipsRestPos,
      headWorldY,
      avatarHeight,
      vertexCount: stats.vertexCount,
      drawCalls: stats.drawCalls,
      lookAtTarget,
      dispose: () => {
        mixer.stopAllAction();
        VRM.VRMUtils.deepDispose(vrm.scene);
      },
    };
  }

  private async loadFbxAvatar(
    resources: Model3DResources,
    manager: ThreeTypes.LoadingManager,
    signal?: AbortSignal,
  ): Promise<LoadedAvatar> {
    const THREE = this.THREE;
    const { FBXLoader } = this.modules;
    const fbxLoader = new FBXLoader(manager);

    const fbx = await fbxLoader.loadAsync(resources.entryUrl);
    signal?.throwIfAborted();

    const WIDGET_MESH_NAME = /^(?:wgt|cs)[-_]/i;
    const WIDGET_MAT_NAME = /^cs_/i;
    const BACKDROP_MESH_NAME = /^(?:coast|skybox|sky_?dome|sky|dome|backdrop|background|env(?:ironment)?|world|floor|ground|stage|plane(?:_\d+)?|camera|light)$/i;
    const OUTLINE_MAT_NAME = /(?:^|[_\-\s])ol$|outline/i;

    // Pass 1: Hide Rigify / Auto-Rig Pro control widget meshes before measuring character bounds
    fbx.updateMatrixWorld(true);
    fbx.traverse((obj) => {
      obj.frustumCulled = false;
      const mesh = obj as ThreeTypes.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      const isWidgetMat = mats.length > 0 && mats.every((m) => WIDGET_MAT_NAME.test(m.name));
      if (WIDGET_MESH_NAME.test(mesh.name) || isWidgetMat) {
        mesh.visible = false;
      }
    });

    // Pass 2: Hide giant unskinned skyboxes / environment backdrops that would shrink the character
    const skinnedBox = this.computeVisibleBounds(fbx, true);
    const skinnedSize = new THREE.Vector3();
    const skinnedHeight = skinnedBox.isEmpty() ? 0 : skinnedBox.getSize(skinnedSize).y;
    const meshBox = new THREE.Box3();
    const meshSize = new THREE.Vector3();

    fbx.traverse((obj) => {
      const mesh = obj as ThreeTypes.Mesh;
      if (!mesh.isMesh || !mesh.visible || (mesh as ThreeTypes.SkinnedMesh).isSkinnedMesh) return;
      if (BACKDROP_MESH_NAME.test(mesh.name.trim())) {
        mesh.visible = false;
        return;
      }
      if (skinnedHeight > 0.01 && mesh.geometry) {
        mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingBox) {
          meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
          meshBox.getSize(meshSize);
          const maxDim = Math.max(meshSize.x, meshSize.y, meshSize.z);
          if (maxDim > skinnedHeight * 3.5) {
            mesh.visible = false;
          }
        }
      }
    });

    // Pass 2.5: Share identical Skeleton instances across SkinnedMeshes (e.g. 120 meshes × 600 bones → 1 skeleton)
    const canonicalSkeletons = new Map<string, ThreeTypes.Skeleton[]>();
    fbx.traverseVisible((obj) => {
      const skinned = obj as ThreeTypes.SkinnedMesh;
      if (!skinned.isSkinnedMesh || !skinned.skeleton || !skinned.skeleton.bones.length) return;
      const skel = skinned.skeleton;
      const key = `${skel.bones.length}:${skel.bones.map((b) => b.uuid).join(",")}`;
      const bucket = canonicalSkeletons.get(key) ?? [];
      const match = bucket.find((existing) =>
        existing.boneInverses.length === skel.boneInverses.length
        && existing.boneInverses.every((inv, idx) => inv.equals(skel.boneInverses[idx])),
      );
      if (match) {
        const oldSkel = skel;
        skinned.bind(match, skinned.bindMatrix);
        if (oldSkel !== match) oldSkel.dispose();
      } else {
        bucket.push(skel);
        canonicalSkeletons.set(key, bucket);
      }
    });

    const morphBindings = new Map<string, MorphBinding[]>();
    const expressions: string[] = [];
    const mouthMorphNames: string[] = [];
    const blinkMorphNames: string[] = [];
    const fallbackTexLoader = new THREE.TextureLoader(manager);
    const sharedFallbackTextures = new Map<string, ThreeTypes.Texture>();
    const processedMaterials = new Set<ThreeTypes.Material>();
    let skinOutlineMat: ThreeTypes.MeshBasicMaterial | null = null;
    let darkOutlineMat: ThreeTypes.MeshBasicMaterial | null = null;
    const retiredOutlineMats = new Set<ThreeTypes.Material>();

    const getOutlineMaterial = (name: string): ThreeTypes.MeshBasicMaterial => {
      if (/body|skin|face|ear/i.test(name)) {
        if (!skinOutlineMat) {
          skinOutlineMat = new THREE.MeshBasicMaterial({ color: 0x4e3533, side: THREE.FrontSide });
          skinOutlineMat.name = "__vivian_skin_outline";
          skinOutlineMat.userData.__vivianIsOutline = true;
        }
        return skinOutlineMat;
      }
      if (!darkOutlineMat) {
        darkOutlineMat = new THREE.MeshBasicMaterial({ color: 0x241e2e, side: THREE.FrontSide });
        darkOutlineMat.name = "__vivian_dark_outline";
        darkOutlineMat.userData.__vivianIsOutline = true;
      }
      return darkOutlineMat;
    };

    // Pass 3: Tune materials, auto-bind unmapped Blender/Sketchfab textures, and discover morph targets
    fbx.traverse((obj) => {
      const mesh = obj as ThreeTypes.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;

      const isArrayMat = Array.isArray(mesh.material);
      const mats: ThreeTypes.Material[] = Array.isArray(mesh.material)
        ? [...mesh.material]
        : mesh.material
          ? [mesh.material]
          : [];
      let replacedAnyMat = false;
      for (let mIdx = 0; mIdx < mats.length; mIdx++) {
        const mat = mats[mIdx];
        if (!mat) continue;

        if (OUTLINE_MAT_NAME.test(mat.name)) {
          // Blender Solidify inverted-hull anime outline shell (flat unlit MeshBasicMaterial = crisp & cheap)
          retiredOutlineMats.add(mat);
          mats[mIdx] = getOutlineMaterial(mat.name);
          replacedAnyMat = true;
          continue;
        }

        if (!processedMaterials.has(mat)) {
          processedMaterials.add(mat);
          const phong = mat as ThreeTypes.MeshPhongMaterial;

          const hasMap = "map" in mat && Boolean((mat as ThreeTypes.MeshStandardMaterial).map);
          if (!hasMap && "map" in mat) {
            const matchedUrl = resources.findTextureForMaterial(mat.name);
            if (matchedUrl) {
              let tex = sharedFallbackTextures.get(matchedUrl);
              if (!tex) {
                tex = fallbackTexLoader.load(matchedUrl);
                tex.colorSpace = THREE.SRGBColorSpace;
                sharedFallbackTextures.set(matchedUrl, tex);
              }
              (mat as ThreeTypes.MeshStandardMaterial).map = tex;
              if ("color" in phong && phong.color) phong.color.setHex(0xffffff);
              mat.needsUpdate = true;
            }
          } else if (hasMap) {
            (mat as ThreeTypes.MeshStandardMaterial).map!.colorSpace = THREE.SRGBColorSpace;
          }

          if (mat.transparent && mat.opacity >= 0.99) {
            mat.alphaTest = Math.max(mat.alphaTest, 0.2);
            mat.side = THREE.DoubleSide;
          }
        }
      }
      if (replacedAnyMat) {
        mesh.material = isArrayMat ? mats : mats[0];
      }

      const dict = mesh.morphTargetDictionary;
      if (dict && mesh.morphTargetInfluences) {
        for (const [rawName, index] of Object.entries(dict)) {
          const name = rawName.trim();
          if (!name) continue;
          const list = morphBindings.get(name) ?? [];
          list.push({ mesh, index, name });
          morphBindings.set(name, list);

          if (/^(?:jawopen|mouthopen|viseme_aa|vrc\.v_aa|aa|a|あ|口あ)$/i.test(name) || /jaw_?open|mouth_?open/i.test(name)) {
            if (!mouthMorphNames.includes(name)) mouthMorphNames.push(name);
          } else if (/^(?:eyeblink(?:left|right)?|blink(?:_?[lr])?|まばたき|ウィンク)$/i.test(name) || /eye_?blink/i.test(name)) {
            if (!blinkMorphNames.includes(name)) blinkMorphNames.push(name);
          } else if (!isSystemExpressionName(name) && !expressions.includes(name)) {
            expressions.push(name);
          }
        }
      }
    });
    for (const oldMat of retiredOutlineMats) oldMat.dispose();

    // Pass 4: Batch compatible multi-mesh FBX SkinnedMeshes by (parent, skeleton, transform, material)
    // Cuts draw calls dramatically on multi-part Blender exports (e.g. 240 draw calls → ~11 draw calls).
    this.mergeCompatibleFbxSkinnedMeshes(fbx);

    const root = new THREE.Group();
    root.add(fbx);

    // Ensure FBX faces camera (+Z) if facial bones indicate it was exported facing -Z
    fbx.updateMatrixWorld(true);
    const headBone = fbx.getObjectByName("Head") ?? fbx.getObjectByName("head") ?? fbx.getObjectByName("headx");
    const frontBone = fbx.getObjectByName("Nose") ?? fbx.getObjectByName("Jaw") ?? fbx.getObjectByName("Eye_L");
    if (headBone && frontBone) {
      const hp = new THREE.Vector3();
      const fp = new THREE.Vector3();
      headBone.getWorldPosition(hp);
      frontBone.getWorldPosition(fp);
      if (fp.z < hp.z - 0.01) {
        fbx.rotation.y += Math.PI;
        fbx.updateMatrixWorld(true);
      }
    }

    const { avatarHeight, headWorldY } = this.normalizeBounds(fbx);
    const fbxRig = discoverFbxRig(THREE, fbx);
    const lookAtTarget = new THREE.Object3D();
    lookAtTarget.position.set(0, headWorldY, 2.2);
    root.add(lookAtTarget);

    const mixer = new THREE.AnimationMixer(fbx);
    const clips = new Map<string, ThreeTypes.AnimationClip>();
    const motionList: ModelMotion[] = [];

    // Register embedded FBX animations (skip 1-frame dummy Blender actions if real clips exist)
    const hasSubstantialClip = fbx.animations.some((clip) => clip.duration > 0.12);
    for (const [index, clip] of fbx.animations.entries()) {
      if (hasSubstantialClip && clip.duration <= 0.08) continue;
      const cleanName = (clip.name || `Clip ${index + 1}`).replace(/^mixamo\.com\|?/i, "").trim() || `Clip ${index + 1}`;
      const entry: ModelMotion = { group: "Embedded", index: motionList.length, name: cleanName };
      motionList.push(entry);
      clips.set(`${entry.group}:${entry.index}`, clip);
      clips.set(entry.name, clip);
    }

    // Load companion FBX animations in the same package
    for (const motion of resources.companionMotionUrls) {
      if (signal?.aborted) break;
      try {
        const animFbx = await fbxLoader.loadAsync(motion.url);
        const sourceClip = animFbx.animations[0];
        if (sourceClip) {
          const entry: ModelMotion = { group: motion.group, index: motionList.length, name: motion.name, path: motion.path };
          motionList.push(entry);
          clips.set(`${entry.group}:${entry.index}`, sourceClip);
          clips.set(entry.name, sourceClip);
        }
        disposeObject3D(animFbx);
      } catch {
        /* Skip unreadable companion clips. */
      }
    }

    // Auto-start an Idle animation if the FBX ships with one
    const idleMotion = motionList.find((m) => /idle|stand|breath|wait/i.test(m.name));
    let activeAction: ThreeTypes.AnimationAction | null = null;
    let activeMotionKey: string | null = null;
    if (idleMotion) {
      const clip = clips.get(`${idleMotion.group}:${idleMotion.index}`);
      if (clip) {
        activeAction = mixer.clipAction(clip);
        activeAction.setLoop(THREE.LoopRepeat, Infinity).play();
        activeMotionKey = `${idleMotion.group}:${idleMotion.index}`;
      }
    }

    const stats = this.countAvatarStats(fbx);

    return {
      format: "fbx",
      root,
      content: fbx,
      mixer,
      clips,
      motionList,
      activeAction,
      activeMotionKey,
      expressions,
      morphBindings,
      mouthMorphNames,
      blinkMorphNames,
      fbxRig,
      headWorldY,
      avatarHeight,
      vertexCount: stats.vertexCount,
      drawCalls: stats.drawCalls,
      lookAtTarget,
      dispose: () => {
        mixer.stopAllAction();
        disposeObject3D(fbx);
      },
    };
  }

  /**
   * Merge non-indexed FBX SkinnedMeshes that share the exact same parent,
   * skeleton, bindMatrix, transform, attribute layout, and material into
   * single-material SkinnedMeshes to slash WebGL draw calls without altering
   * skinning math or morph-targeted meshes.
   */
  private mergeCompatibleFbxSkinnedMeshes(fbx: ThreeTypes.Group): void {
    const THREE = this.THREE;
    const animatedNodeNames = new Set<string>();
    for (const clip of fbx.animations) {
      for (const track of clip.tracks) {
        const dot = track.name.indexOf(".");
        if (dot > 0) animatedNodeNames.add(track.name.slice(0, dot));
      }
    }

    const eligible: ThreeTypes.SkinnedMesh[] = [];
    fbx.updateMatrixWorld(true);
    fbx.traverseVisible((obj) => {
      const mesh = obj as ThreeTypes.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !mesh.skeleton || !mesh.parent || !mesh.geometry) return;
      if (mesh.geometry.index) return;
      if (mesh.morphTargetDictionary && Object.keys(mesh.morphTargetDictionary).length > 0) return;
      if (mesh.name && animatedNodeNames.has(mesh.name)) return;
      const attrs = mesh.geometry.attributes;
      if (!attrs.position || !attrs.skinIndex || !attrs.skinWeight) return;
      eligible.push(mesh);
    });
    if (eligible.length < 8) return;

    interface MeshSlice {
      mesh: ThreeTypes.SkinnedMesh;
      start: number;
      count: number;
    }
    interface MergeBucket {
      parent: ThreeTypes.Object3D;
      skeleton: ThreeTypes.Skeleton;
      template: ThreeTypes.SkinnedMesh;
      material: ThreeTypes.Material;
      attrNames: string[];
      slices: MeshSlice[];
      totalVerts: number;
    }

    const skeletonIds = new WeakMap<ThreeTypes.Skeleton, number>();
    let nextSkelId = 1;
    const buckets = new Map<string, MergeBucket>();
    let totalSlices = 0;

    for (const mesh of eligible) {
      const pos = mesh.geometry.getAttribute("position");
      if (!pos || pos.count <= 0) continue;

      let skelId = skeletonIds.get(mesh.skeleton);
      if (!skelId) {
        skelId = nextSkelId++;
        skeletonIds.set(mesh.skeleton, skelId);
      }
      const attrNames = Object.keys(mesh.geometry.attributes).sort();
      const attrSig = attrNames
        .map((n) => {
          const a = mesh.geometry.attributes[n];
          return `${n}:${a.itemSize}:${a.array.constructor.name}:${a.normalized ? 1 : 0}`;
        })
        .join("|");
      const bindSig = mesh.bindMatrix.elements.map((n) => Math.round(n * 1000)).join(",");
      const worldSig = mesh.matrixWorld.elements.map((n) => Math.round(n * 1000)).join(",");

      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const groups = mesh.geometry.groups.length > 0
        ? mesh.geometry.groups
        : [{ start: 0, count: pos.count, materialIndex: 0 }];

      for (const grp of groups) {
        if (grp.count <= 0) continue;
        const mat = mats[grp.materialIndex ?? 0];
        if (!mat) continue;
        const key = `${mesh.parent!.uuid}|${skelId}|${bindSig}|${worldSig}|${attrSig}|${mat.uuid}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            parent: mesh.parent!,
            skeleton: mesh.skeleton,
            template: mesh,
            material: mat,
            attrNames,
            slices: [],
            totalVerts: 0,
          };
          buckets.set(key, bucket);
        }
        bucket.slices.push({ mesh, start: grp.start, count: grp.count });
        bucket.totalVerts += grp.count;
        totalSlices++;
      }
    }

    // Only replace meshes when batching meaningfully cuts draw calls
    if (buckets.size >= totalSlices) return;

    const mergedMeshes: Array<{ parent: ThreeTypes.Object3D; mesh: ThreeTypes.SkinnedMesh }> = [];
    for (const bucket of buckets.values()) {
      if (bucket.totalVerts <= 0) continue;
      const mergedGeo = new THREE.BufferGeometry();
      const firstGeo = bucket.template.geometry;

      for (const attrName of bucket.attrNames) {
        const refAttr = firstGeo.attributes[attrName] as ThreeTypes.BufferAttribute;
        const itemSize = refAttr.itemSize;
        const TypedArrayCtor = refAttr.array.constructor as new (len: number) => Float32Array | Uint16Array | Uint8Array | Uint32Array | Int16Array;
        const mergedArray = new TypedArrayCtor(bucket.totalVerts * itemSize);
        let vertOffset = 0;
        for (const slice of bucket.slices) {
          const srcAttr = slice.mesh.geometry.attributes[attrName] as ThreeTypes.BufferAttribute;
          const srcArr = srcAttr.array as Float32Array;
          const srcStart = slice.start * itemSize;
          const srcEnd = (slice.start + slice.count) * itemSize;
          mergedArray.set(srcArr.subarray(srcStart, srcEnd), vertOffset * itemSize);
          vertOffset += slice.count;
        }
        mergedGeo.setAttribute(attrName, new THREE.BufferAttribute(mergedArray, itemSize, refAttr.normalized));
      }
      mergedGeo.computeBoundingBox();
      mergedGeo.computeBoundingSphere();

      const merged = new THREE.SkinnedMesh(mergedGeo, bucket.material);
      merged.name = `Batched_${bucket.material.name || "Mesh"}`;
      merged.position.copy(bucket.template.position);
      merged.quaternion.copy(bucket.template.quaternion);
      merged.scale.copy(bucket.template.scale);
      merged.frustumCulled = false;
      merged.bind(bucket.skeleton, bucket.template.bindMatrix.clone());
      mergedMeshes.push({ parent: bucket.parent, mesh: merged });
    }

    // Remove and dispose replaced source SkinnedMeshes, then mount batched replacements
    for (const mesh of eligible) {
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
    }
    for (const { parent, mesh } of mergedMeshes) {
      parent.add(mesh);
    }
  }

  /**
   * Compute world bounding box strictly from visible meshes (unlike Three.js
   * `Box3.setFromObject`, which also measures hidden skyboxes & rig widgets).
   */
  private computeVisibleBounds(root: ThreeTypes.Object3D, skinnedOnly: boolean): ThreeTypes.Box3 {
    const THREE = this.THREE;
    const box = new THREE.Box3();
    const meshBox = new THREE.Box3();
    root.updateMatrixWorld(true);
    root.traverseVisible((obj) => {
      const mesh = obj as ThreeTypes.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (skinnedOnly && !(mesh as ThreeTypes.SkinnedMesh).isSkinnedMesh) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) return;
      meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      box.union(meshBox);
    });
    return box;
  }

  private normalizeBounds(content: ThreeTypes.Object3D, vrm?: VrmInstance): { avatarHeight: number; headWorldY: number } {
    const THREE = this.THREE;
    content.updateMatrixWorld(true);
    let box = this.computeVisibleBounds(content, true);
    if (box.isEmpty()) box = this.computeVisibleBounds(content, false);
    if (box.isEmpty()) box = new THREE.Box3().setFromObject(content);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const rawHeight = Number.isFinite(size.y) && size.y > 0.001 ? size.y : TARGET_AVATAR_HEIGHT;
    const scaleFactor = TARGET_AVATAR_HEIGHT / rawHeight;
    content.scale.multiplyScalar(scaleFactor);
    content.updateMatrixWorld(true);

    let scaledBox = this.computeVisibleBounds(content, true);
    if (scaledBox.isEmpty()) scaledBox = this.computeVisibleBounds(content, false);
    if (scaledBox.isEmpty()) scaledBox = new THREE.Box3().setFromObject(content);
    const scaledCenter = new THREE.Vector3();
    const scaledSize = new THREE.Vector3();
    scaledBox.getCenter(scaledCenter);
    scaledBox.getSize(scaledSize);

    content.position.x -= scaledCenter.x;
    content.position.y -= scaledBox.min.y;
    content.position.z -= scaledCenter.z;
    content.updateMatrixWorld(true);

    const avatarHeight = Number.isFinite(scaledSize.y) && scaledSize.y > 0.2 ? scaledSize.y : TARGET_AVATAR_HEIGHT;
    let headWorldY = avatarHeight * 0.87;
    if (vrm?.humanoid) {
      const headNode = vrm.humanoid.getNormalizedBoneNode("head");
      if (headNode) {
        const pos = new THREE.Vector3();
        headNode.getWorldPosition(pos);
        if (Number.isFinite(pos.y) && pos.y > 0.2) headWorldY = pos.y;
      }
    }
    return { avatarHeight, headWorldY };
  }

  /** Full-body procedural mocap for VRM 0.x & 1.0 (weight shift, legs, fingers, speech & emotion gestures). */
  private updateVrmFullBodyMocap(vrm: VrmInstance, avatar: LoadedAvatar, dt: number): void {
    // Smooth speech activity envelope for natural talking hand gestures
    const speechTarget = this.mouthCurrent > 0.04 ? clamp(this.mouthCurrent * 1.6, 0, 1) : 0;
    this.speechActivity = damp(this.speechActivity, speechTarget, speechTarget > this.speechActivity ? 7 : 3.5, dt);

    // Smoothly crossfade built-in expressive gestures in and out of the living idle stance
    const gestureActive = this.activeVrmGesture !== null
      && (this.activeVrmGestureExpireAt === null || this.elapsedSec < this.activeVrmGestureExpireAt);
    const weightTarget = gestureActive ? 1 : 0;
    this.vrmGestureWeight = damp(this.vrmGestureWeight, weightTarget, gestureActive ? 6.5 : 4.5, dt);
    if (!gestureActive && this.vrmGestureWeight < 0.005) {
      this.vrmGestureWeight = 0;
      this.activeVrmGesture = null;
      this.activeVrmGestureExpireAt = null;
    }

    // Procedural emotion reaction envelope (smooth ease in & out)
    let reactHeadPitch = 0;
    let reactHeadYaw = 0;
    let reactHeadRoll = 0;
    let reactSpinePitch = 0;
    if (this.reactionEmotion && this.reactionDuration > 0) {
      const age = this.elapsedSec - this.reactionStartedAt;
      if (age >= 0 && age < this.reactionDuration) {
        const pose = PROCEDURAL_EMOTION_POSE[this.reactionEmotion];
        const env = Math.sin((age / this.reactionDuration) * Math.PI) * this.reactionIntensity;
        reactHeadPitch = pose.headPitch * env;
        reactHeadYaw = pose.headYaw * env;
        reactHeadRoll = pose.headRoll * env;
        reactSpinePitch = pose.spinePitch * env;
      } else if (age >= this.reactionDuration) {
        this.reactionEmotion = null;
      }
    }

    const s = this._mocapState;
    s.elapsedSec = this.elapsedSec;
    s.dt = dt;
    s.hipsRestPos = avatar.hipsRestPos ?? null;
    s.pointerSmoothX = this.pointerSmoothX;
    s.pointerSmoothY = this.pointerSmoothY;
    s.mouthCurrent = this.mouthCurrent;
    s.speechActivity = this.speechActivity;
    s.gestureId = this.activeVrmGesture;
    s.gestureWeight = this.vrmGestureWeight;
    s.gestureAgeSec = Math.max(0, this.elapsedSec - this.vrmGestureStartedAt);
    s.reactHeadPitch = reactHeadPitch;
    s.reactHeadYaw = reactHeadYaw;
    s.reactHeadRoll = reactHeadRoll;
    s.reactSpinePitch = reactSpinePitch;

    applyVrmFullBodyMocap(vrm, s);
  }

  /** Apply a world-space Euler rotation delta to every copy of an FBX bone (independent of local bone roll). */
  private applyWorldEulerToBones(states: readonly FbxBoneState[], wx: number, wy: number, wz: number): void {
    if (!states.length) return;
    this._tmpEuler.set(wx, wy, wz, "YXZ");
    this._tmpWorldDelta.setFromEuler(this._tmpEuler);
    for (const state of states) {
      this._tmpTargetWorld.copy(this._tmpWorldDelta).multiply(state.restWorldQuat);
      state.bone.quaternion.copy(state.parentInvWorldQuat).multiply(this._tmpTargetWorld);
    }
  }

  /** Autonomous breathing, subtle sway, relaxed arms, and emotion head pose for FBX rigs. */
  private applyFbxProceduralPose(rig: FbxBoneRig, t: number): void {
    const breath = Math.sin(t * 1.45);
    const sway = Math.sin(t * 0.65);

    let reactHeadPitch = 0;
    let reactHeadYaw = 0;
    let reactHeadRoll = 0;
    let reactSpinePitch = 0;
    if (this.reactionEmotion && this.reactionDuration > 0) {
      const age = this.elapsedSec - this.reactionStartedAt;
      if (age >= 0 && age < this.reactionDuration) {
        const pose = PROCEDURAL_EMOTION_POSE[this.reactionEmotion];
        const env = Math.sin((age / this.reactionDuration) * Math.PI) * this.reactionIntensity;
        reactHeadPitch = pose.headPitch * env;
        reactHeadYaw = pose.headYaw * env;
        reactHeadRoll = pose.headRoll * env;
        reactSpinePitch = pose.spinePitch * env;
      } else if (age >= this.reactionDuration) {
        this.reactionEmotion = null;
      }
    }

    this.applyWorldEulerToBones(rig.spine, breath * 0.014 + reactSpinePitch * 0.5, 0, sway * 0.012);
    this.applyWorldEulerToBones(rig.chest, breath * 0.018 + reactSpinePitch * 0.5, sway * 0.015, 0);
    this.applyWorldEulerToBones(rig.leftShoulder, 0, 0, breath * 0.012);
    this.applyWorldEulerToBones(rig.rightShoulder, 0, 0, -breath * 0.012);

    if (rig.needsArmRelax) {
      // Swing outstretched T-pose arms down naturally along the body in world space
      this.applyWorldEulerToBones(rig.leftUpperArm, 0.06, 0.05, -1.16 + breath * 0.015);
      this.applyWorldEulerToBones(rig.rightUpperArm, 0.06, -0.05, 1.16 - breath * 0.015);
      this.applyWorldEulerToBones(rig.leftLowerArm, -0.08, 0.14, -0.1);
      this.applyWorldEulerToBones(rig.rightLowerArm, -0.08, -0.14, 0.1);
    }

    this.applyWorldEulerToBones(
      rig.neck,
      -this.pointerSmoothY * 0.07 + reactHeadPitch * 0.4,
      this.pointerSmoothX * 0.12 + reactHeadYaw * 0.4,
      0,
    );
    this.applyWorldEulerToBones(
      rig.head,
      -this.pointerSmoothY * 0.09 + breath * 0.01 + reactHeadPitch * 0.6,
      this.pointerSmoothX * 0.16 + sway * 0.02 + reactHeadYaw * 0.6,
      sway * 0.014 + reactHeadRoll,
    );
  }

  private updateBlink(dt: number): number {
    // Suppress automatic blink when a closed-eye expression is strongly active
    const suppress = this.activeEmotion === "laugh" || (this.activeEmotion === "happy" && (this.activeEmotionExpression?.weight ?? 0) > 0.75);
    if (suppress) {
      this.isBlinking = false;
      this.blinkProgress = 0;
      return 0;
    }
    if (!this.isBlinking && this.elapsedSec >= this.nextBlinkAt) {
      this.isBlinking = true;
      this.blinkProgress = 0;
    }
    if (!this.isBlinking) return 0;
    this.blinkProgress += dt / 0.16;
    if (this.blinkProgress >= 1) {
      this.isBlinking = false;
      this.blinkProgress = 0;
      if (this.pendingDoubleBlink) {
        this.pendingDoubleBlink = false;
        this.nextBlinkAt = this.elapsedSec + 0.14;
      } else {
        this.pendingDoubleBlink = Math.random() < 0.22;
        this.nextBlinkAt = this.elapsedSec + 2.4 + Math.random() * 3.4;
      }
      return 0;
    }
    return Math.sin(this.blinkProgress * Math.PI);
  }

  private step(dt: number): void {
    const avatar = this.avatar;
    if (!avatar) return;

    this.elapsedSec += dt;

    // Gentle decay of pointer look-at back toward camera when user stops moving cursor/finger
    const idleMs = performance.now() - this.pointerLastMovedAt;
    const targetX = idleMs > 4500 ? Math.sin(this.elapsedSec * 0.35) * 0.08 : this.pointerTargetX;
    const targetY = idleMs > 4500 ? Math.cos(this.elapsedSec * 0.28) * 0.04 : this.pointerTargetY;
    this.pointerSmoothX = damp(this.pointerSmoothX, targetX, 5, dt);
    this.pointerSmoothY = damp(this.pointerSmoothY, targetY, 5, dt);

    // Smooth mouth lip-sync envelope
    this.mouthCurrent = damp(this.mouthCurrent, this.mouthTarget, this.mouthTarget > this.mouthCurrent ? 28 : 16, dt);
    const blinkValue = this.updateBlink(dt);

    // Update lookAt world target
    avatar.lookAtTarget.position.set(
      this.pointerSmoothX * 0.9,
      avatar.headWorldY + this.pointerSmoothY * 0.5,
      2.2,
    );

    if (avatar.activeAction) {
      avatar.mixer.update(dt);
    }

    if (avatar.format === "vrm" && avatar.vrm) {
      const vrm = avatar.vrm;
      if (!avatar.activeAction) {
        this.updateVrmFullBodyMocap(vrm, avatar, dt);
      }

      // Apply subtle breeze to VRM SpringBones so hair & clothing sway gently
      if (vrm.springBoneManager) {
        const windX = Math.sin(this.elapsedSec * 0.9) * 0.05 + Math.sin(this.elapsedSec * 2.1) * 0.025;
        for (const joint of vrm.springBoneManager.joints) {
          joint.settings.gravityDir.set(windX, -1, 0.04).normalize();
        }
      }

      // Smoothly blend facial expressions + blink + lip-sync
      const mgr = vrm.expressionManager;
      if (mgr) {
        const desired = this._desiredExprs;
        desired.clear();
        for (const name of avatar.expressions) desired.set(name, 0);
        for (const name of this.savedExpressions) desired.set(name, 0.9);
        if (this.activeEmotionExpression) {
          desired.set(this.activeEmotionExpression.name, this.activeEmotionExpression.weight);
        }
        for (const [name, target] of desired) {
          const prev = this.expressionWeights.get(name) ?? 0;
          if (prev === 0 && target === 0) continue;
          const rawNext = damp(prev, target, 10, dt);
          const next = rawNext < 0.0005 && target === 0 ? 0 : rawNext;
          this.expressionWeights.set(name, next);
          mgr.setValue(name, next);
        }

        // Natural blink
        mgr.setValue("blink", blinkValue);

        // Real-time lip-sync with subtle vowel shaping
        const open = this.mouthCurrent;
        mgr.setValue("aa", clamp(open * 0.92, 0, 1));
        mgr.setValue("ih", clamp(open * 0.24 * (0.5 + 0.5 * Math.sin(this.elapsedSec * 14)), 0, 0.45));
        mgr.setValue("oh", clamp(open * 0.28 * (0.5 + 0.5 * Math.cos(this.elapsedSec * 11)), 0, 0.45));
      }

      vrm.update(dt);
    } else {
      // FBX procedural pose + morph targets + jaw fallback
      if (!avatar.activeAction && avatar.fbxRig) {
        this.applyFbxProceduralPose(avatar.fbxRig, this.elapsedSec);
      }

      if (avatar.expressions.length || this.savedExpressions.length || Object.keys(this.activeFbxEmotionWeights).length) {
        const desired = this._desiredExprs;
        desired.clear();
        for (const name of avatar.expressions) desired.set(name, 0);
        for (const name of this.savedExpressions) desired.set(name, 0.9);
        for (const [name, weight] of Object.entries(this.activeFbxEmotionWeights)) {
          desired.set(name, Math.max(desired.get(name) ?? 0, weight));
        }

        for (const [name, target] of desired) {
          const prev = this.expressionWeights.get(name) ?? 0;
          if (prev === 0 && target === 0) continue;
          const rawNext = damp(prev, target, 10, dt);
          const next = rawNext < 0.0005 && target === 0 ? 0 : rawNext;
          this.expressionWeights.set(name, next);
          const bindings = avatar.morphBindings.get(name);
          if (bindings) {
            for (const binding of bindings) {
              if (binding.mesh.morphTargetInfluences) binding.mesh.morphTargetInfluences[binding.index] = next;
            }
          }
        }
      }

      for (const name of avatar.blinkMorphNames) {
        const bindings = avatar.morphBindings.get(name);
        if (bindings) {
          for (const binding of bindings) {
            if (binding.mesh.morphTargetInfluences) binding.mesh.morphTargetInfluences[binding.index] = blinkValue;
          }
        }
      }

      if (avatar.mouthMorphNames.length) {
        for (const name of avatar.mouthMorphNames) {
          const bindings = avatar.morphBindings.get(name);
          if (bindings) {
            for (const binding of bindings) {
              if (binding.mesh.morphTargetInfluences) {
                binding.mesh.morphTargetInfluences[binding.index] = clamp(this.mouthCurrent * 0.9, 0, 1);
              }
            }
          }
        }
      } else if (avatar.fbxRig?.jaw.length) {
        this.applyWorldEulerToBones(avatar.fbxRig.jaw, this.mouthCurrent * 0.24, 0, 0);
      }
    }
  }

  /** Capture a face-focused JPEG thumbnail from the live 3D WebGL render. */
  async captureFaceSnapshot(): Promise<Blob | null> {
    if (!this.avatar || this.isContextLost()) return null;
    this.renderer.render(this.scene, this.camera);
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (!cw || !ch) return null;

    const THREE = this.THREE;
    let box = this.computeVisibleBounds(this.avatar.root, true);
    if (box.isEmpty()) box = this.computeVisibleBounds(this.avatar.root, false);
    if (box.isEmpty()) return snapshotToBlob(this.canvas, 360, 0.72);

    const corners = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      new THREE.Vector3(box.min.x, box.max.y, box.min.z),
      new THREE.Vector3(box.max.x, box.max.y, box.min.z),
      new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      new THREE.Vector3(box.min.x, box.max.y, box.max.z),
      new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ];

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pt of corners) {
      pt.project(this.camera);
      const sx = (pt.x * 0.5 + 0.5) * cw;
      const sy = (-pt.y * 0.5 + 0.5) * ch;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }

    const padX = Math.max(16, (maxX - minX) * 0.12);
    const bounds = {
      x: Math.max(0, minX - padX),
      y: Math.max(0, minY - 12),
      width: Math.min(cw, maxX - minX + padX * 2),
      height: Math.min(ch, maxY - minY + 24),
    };
    const crop = faceCrop(bounds, cw, ch);
    // Re-render synchronously right before canvas readback because preserveDrawingBuffer is false
    this.renderer.render(this.scene, this.camera);
    return snapshotToBlob(this.canvas, 360, 0.72, crop ?? undefined);
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.pausedByVisibility = false;
    this.lastTimeMs = performance.now();
    const tick = (now: number) => {
      if (!this.running || this.disposed) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTimeMs) / 1000));
      this.lastTimeMs = now;
      if (this.avatar && !this.isContextLost()) {
        this.step(dt);
        this.renderer.render(this.scene, this.camera);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  pause(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    if (typeof document !== "undefined" && this.onVisibilityChange) {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.unloadAvatar();
    this.shadowFloor.geometry.dispose();
    (this.shadowFloor.material as ThreeTypes.Material).dispose();
    this.envRenderTarget?.dispose();
    this.envRenderTarget = null;
    this.pmremGenerator?.dispose();
    this.pmremGenerator = null;
    this.renderer.dispose();
  }
}
