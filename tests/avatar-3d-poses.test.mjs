import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isValidSemanticPoseId,
  resolveConversationPoseIntent,
  resolveSemanticPose,
  SEMANTIC_POSE_LIBRARY,
} from "../lib/avatar-3d-poses.ts";
import {
  applyVrmFullBodyMocap,
  BUILT_IN_VRM_GESTURES,
  getPoseGazeOffset,
} from "../lib/vrm-procedural-mocap.ts";

const EXPECTED_24_IDS = [
  "relaxed_idle",
  "weight_shifting",
  "natural_breathing",
  "looking_around",
  "explaining",
  "attentive_listening",
  "gentle_nodding",
  "thinking",
  "genuine_happiness",
  "shy_embarrassed",
  "confused",
  "sad_concerned",
  "surprised",
  "playful_teasing",
  "greeting_wave",
  "pointing",
  "arms_crossed",
  "casual_sitting",
  "leaning_forward",
  "stretching",
  "hair_adjustment",
  "natural_laughing",
  "goodbye",
  "phone_interaction",
];

test("SEMANTIC_POSE_LIBRARY contains all 24 required semantic pose IDs", () => {
  assert.equal(SEMANTIC_POSE_LIBRARY.length, 24);
  for (const id of EXPECTED_24_IDS) {
    assert.equal(isValidSemanticPoseId(id), true, `Missing semantic pose ID: ${id}`);
  }
});

test("resolveSemanticPose rejects invalid IDs and enforces prop-safe fallbacks", () => {
  const invalid = resolveSemanticPose({ pose_id: "backflip_360_invalid" });
  assert.equal(invalid.resolvedId, "relaxed_idle");
  assert.equal(invalid.usedFallback, true);

  const sittingNoChair = resolveSemanticPose({ pose_id: "casual_sitting" }, { hasSeatProp: false });
  assert.equal(sittingNoChair.resolvedId, "relaxed_idle");
  assert.equal(sittingNoChair.usedFallback, true);

  const sittingWithChair = resolveSemanticPose({ pose_id: "casual_sitting" }, { hasSeatProp: true });
  assert.equal(sittingWithChair.resolvedId, "casual_sitting");
  assert.equal(sittingWithChair.usedFallback, false);

  const phoneNoProp = resolveSemanticPose({ pose_id: "phone_interaction" }, { hasPhoneProp: false });
  assert.equal(phoneNoProp.resolvedId, "attentive_listening");
  assert.equal(phoneNoProp.usedFallback, true);
});

test("resolveSemanticPose enforces 5-tier priority & interruption rules", () => {
  // Background idle (priority 5) must NOT override an explicit user action (priority 2)
  const blocked = resolveSemanticPose(
    { pose_id: "weight_shifting" },
    { activePoseId: "greeting_wave", activePriority: 2 },
  );
  assert.equal(blocked.accepted, false);

  // Explicit user action (priority 2) CAN interrupt a conversation pose (priority 4)
  const allowed = resolveSemanticPose(
    { pose_id: "greeting_wave" },
    { activePoseId: "thinking", activePriority: 4 },
  );
  assert.equal(allowed.accepted, true);
});

test("resolveConversationPoseIntent maps greetings, goodbyes, explanations, and emotions deterministically", () => {
  assert.equal(
    resolveConversationPoseIntent({ emotion: "happy", userText: "สวัสดีวิเวียน" }).pose_id,
    "greeting_wave",
  );
  assert.equal(
    resolveConversationPoseIntent({ emotion: "happy", userText: "ฝันดีนะ ไปนอนก่อน" }).pose_id,
    "goodbye",
  );
  assert.equal(
    resolveConversationPoseIntent({ emotion: "happy", reply: "เพราะว่าขั้นตอนมันเป็นอย่างนี้..." }).pose_id,
    "explaining",
  );
  assert.equal(resolveConversationPoseIntent({ emotion: "laugh" }).pose_id, "natural_laughing");
  assert.equal(resolveConversationPoseIntent({ emotion: "surprised" }).pose_id, "surprised");
  assert.equal(resolveConversationPoseIntent({ emotion: "sad" }).pose_id, "sad_concerned");
  assert.equal(resolveConversationPoseIntent({ emotion: "blush" }).pose_id, "shy_embarrassed");
  assert.equal(resolveConversationPoseIntent({ emotion: "thinking" }).pose_id, "thinking");
});

test("all 24 semantic pose IDs execute safely within anatomical joint limits without NaN or elbow hyperextension", () => {
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

  const vrm1 = makeMockVrm("1");
  for (const id of EXPECTED_24_IDS) {
    applyVrmFullBodyMocap(vrm1, {
      elapsedSec: 2.0,
      dt: 1 / 60,
      hipsRestPos: { x: 0, y: 0.9, z: 0 },
      pointerSmoothX: 0,
      pointerSmoothY: 0,
      mouthCurrent: 0,
      speechActivity: 0,
      gestureId: id,
      gestureWeight: 1,
      gestureAgeSec: 1.0,
      reactHeadPitch: 0,
      reactHeadYaw: 0,
      reactHeadRoll: 0,
      reactSpinePitch: 0,
      snapImmediate: true,
    });

    const leftElbow = vrm1.bones.get("leftLowerArm").rotation;
    const rightElbow = vrm1.bones.get("rightLowerArm").rotation;
    assert.ok(Number.isFinite(leftElbow.y) && leftElbow.y <= 0, `${id}: left elbow must not hyperextend (${leftElbow.y})`);
    assert.ok(Number.isFinite(rightElbow.y) && rightElbow.y >= 0, `${id}: right elbow must not hyperextend (${rightElbow.y})`);
  }

  // Gaze offsets are non-zero for thinking/scan/shy modes
  assert.ok(Math.abs(getPoseGazeOffset("away_up", 1, 1, 1).y) > 0.1);
  assert.ok(Math.abs(getPoseGazeOffset("scan", 1, 1.2, 1).x) > 0.1);
  assert.ok(BUILT_IN_VRM_GESTURES.length >= 20, "Manual UI should expose curated non-prop poses");
});
