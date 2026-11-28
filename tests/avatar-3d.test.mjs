import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectAvatarEmotion,
  resolve3DExpression,
  resolveFbxMorphWeights,
  resolve3DMotion,
  PROCEDURAL_EMOTION_POSE,
} from "../lib/avatar-emotion.ts";
import {
  inspectVrmBuffer,
  isFbxBuffer,
  isCompanionMotionFbx,
  modelFormatFromPath,
} from "../lib/vrm-metadata.ts";
import { clampModelTransform } from "../lib/model-position.ts";

function makeGlb(json) {
  const raw = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (raw.byteLength % 4)) % 4;
  const chunkLen = raw.byteLength + pad;
  const out = new Uint8Array(20 + chunkLen);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, chunkLen, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(raw, 20);
  for (let i = 0; i < pad; i++) out[20 + raw.byteLength + i] = 0x20;
  return out;
}

test("inspectVrmBuffer supports VRM 0.x blendShapeMaster and rejects invalid binaries", () => {
  const vrm0 = makeGlb({
    asset: { version: "2.0" },
    extensions: {
      VRM: {
        meta: { title: "Vivian VRM0" },
        blendShapeMaster: {
          blendShapeGroups: [
            { name: "Joy", presetName: "joy" },
            { name: "Angry", presetName: "angry" },
            { name: "A", presetName: "a" },
            { name: "Blink", presetName: "blink" },
            { name: "Blush", presetName: "unknown" },
          ],
        },
      },
    },
  });
  const meta = inspectVrmBuffer(vrm0);
  assert.equal(meta.version, "0.x");
  assert.equal(meta.name, "Vivian VRM0");
  assert.deepEqual(meta.expressions, ["joy", "angry", "Blush"]);

  assert.throws(() => inspectVrmBuffer(new Uint8Array([1, 2, 3, 4])));
  assert.throws(() => inspectVrmBuffer(new Uint8Array(64)));
});

test("isFbxBuffer recognizes Binary and ASCII FBX headers and rejects random bytes", () => {
  assert.equal(isFbxBuffer(new TextEncoder().encode("Kaydara FBX Binary  \0\x1a\x00")), true);
  assert.equal(isFbxBuffer(new TextEncoder().encode("; FBX 7.4.0 project file\nFBXHeaderExtension: {}")), true);
  assert.equal(isFbxBuffer(new TextEncoder().encode("not an fbx file at all")), false);
});

test("isCompanionMotionFbx distinguishes animation clips from standalone avatars", () => {
  assert.equal(isCompanionMotionFbx("motions/Wave.fbx", ["vivian.vrm", "motions/Wave.fbx"]), true);
  assert.equal(isCompanionMotionFbx("Idle.fbx", ["vivian.vrm", "Idle.fbx"]), true);
  assert.equal(isCompanionMotionFbx("Malfoy.fbx", ["Malfoy.fbx"]), false);
  assert.equal(modelFormatFromPath("a/b/Vivian.VRM"), "vrm");
  assert.equal(modelFormatFromPath("a/b/Hero.fbx"), "fbx");
  assert.equal(modelFormatFromPath("a/b/model.obj"), null);
});

test("3D emotion engine maps ElevenLabs tags and mood to VRM 1.0, VRM 0.x, FBX ARKit morphs, and procedural poses", () => {
  const emotion = detectAvatarEmotion({
    reply: "[playful] หึ ใครบอกว่าฉันรอเธออยู่กันล่ะ...",
    userText: "รอนานไหม",
    mood: "warm",
    intensity: 60,
  });
  assert.equal(emotion, "tease");

  const vrm1Expr = resolve3DExpression("happy", ["neutral", "happy", "angry", "sad", "relaxed", "surprised"]);
  assert.equal(vrm1Expr?.name, "happy");

  const vrm0Expr = resolve3DExpression("sad", ["neutral", "joy", "angry", "sorrow", "fun"]);
  assert.equal(vrm0Expr?.name, "sorrow");

  const fbxWeights = resolveFbxMorphWeights("happy", ["mouthSmileLeft", "mouthSmileRight", "cheekSquintLeft", "browDownLeft"]);
  assert.ok(fbxWeights.mouthSmileLeft > 0.5);
  assert.ok(fbxWeights.mouthSmileRight > 0.5);
  assert.equal(fbxWeights.browDownLeft, undefined);

  assert.equal(resolve3DMotion("happy", ["Idle", "WaveHappy", "SadWalk"]), "WaveHappy");
  assert.equal(resolve3DMotion("eyes", ["Idle", "Dance"]), "Idle");
  assert.ok(PROCEDURAL_EMOTION_POSE.blush.headYaw !== 0);
});

import {
  applyVrmFullBodyMocap,
  BUILT_IN_VRM_GESTURES,
  emotionToBuiltInGesture,
} from "../lib/vrm-procedural-mocap.ts";

test("clampModelTransform bounds move/zoom cleanly without allowing out-of-stage loss", () => {
  const clamped = clampModelTransform({ x: 9999, y: -9999, scale: 99 }, 1000, 800);
  assert.equal(clamped.x, 750);
  assert.equal(clamped.y, -600);
  assert.equal(clamped.scale, 2.5);
});

test("applyVrmFullBodyMocap articulates hips, legs, arms, fingers, and gestures with opposite X/Z sign for VRM 0.x vs 1.0", () => {
  const makeMockVrm = (metaVersion) => {
    const bones = new Map();
    return {
      meta: { metaVersion },
      bones,
      humanoid: {
        getNormalizedBoneNode(name) {
          if (!bones.has(name)) {
            bones.set(name, {
              position: { x: 0, y: 0.9, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
              rotation: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
            });
          }
          return bones.get(name);
        },
      },
    };
  };

  const vrm0 = makeMockVrm("0");
  const vrm1 = makeMockVrm("1");
  const state = {
    elapsedSec: 1.8,
    dt: 0.016,
    hipsRestPos: { x: 0, y: 0.9, z: 0 },
    pointerSmoothX: 0.2,
    pointerSmoothY: -0.1,
    mouthCurrent: 0.6,
    speechActivity: 0.8,
    gestureId: "greeting_wave",
    gestureWeight: 1,
    gestureAgeSec: 0.7,
    reactHeadPitch: 0,
    reactHeadYaw: 0,
    reactHeadRoll: 0,
    reactSpinePitch: 0,
  };

  applyVrmFullBodyMocap(vrm0, state);
  applyVrmFullBodyMocap(vrm1, state);

  // VRM 0.x and VRM 1.0 have mirrored Z rotation on arms & legs, identical Y yaw
  assert.ok(vrm0.bones.get("leftUpperArm").rotation.z > 0.5, "VRM 0.x leftUpperArm should lower (+Z)");
  assert.ok(vrm1.bones.get("leftUpperArm").rotation.z < -0.5, "VRM 1.0 leftUpperArm should lower (-Z)");
  assert.ok(Math.abs(vrm0.bones.get("leftLowerLeg").rotation.x) > 0.02, "Legs/knees must articulate");
  assert.ok(Math.abs(vrm0.bones.get("leftIndexProximal").rotation.z) > 0.05, "Fingers must curl naturally");
  assert.ok(Math.abs(vrm0.bones.get("hips").position.x) > 0.005, "Hips must shift weight");
  assert.equal(BUILT_IN_VRM_GESTURES.length, 6);
  assert.equal(emotionToBuiltInGesture("blush"), "shy_fidget");
  assert.equal(emotionToBuiltInGesture("angry"), "pout_hips");
});
