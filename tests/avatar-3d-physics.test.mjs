import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import {
  Avatar3DPhysicsController,
  classifyPhysicsBoneName,
  computeFramerateIndependentParams,
  evaluateWindField,
  hashBonePhase,
  isSecondaryPhysicsBoneName,
} from "../lib/avatar-3d-physics.ts";

test("classifyPhysicsBoneName and isSecondaryPhysicsBoneName detect hair/cloth/ribbons and exclude core humanoid bones", () => {
  assert.equal(classifyPhysicsBoneName("Hair_Front_L_01"), "hair");
  assert.equal(classifyPhysicsBoneName("前髪_02"), "hair");
  assert.equal(classifyPhysicsBoneName("Skirt_Back_01"), "skirt");
  assert.equal(classifyPhysicsBoneName("Cape_L_03"), "skirt");
  assert.equal(classifyPhysicsBoneName("Ribbon_Neck_R"), "ribbon");
  assert.equal(classifyPhysicsBoneName("Cat_Ear_L"), "ear");
  assert.equal(classifyPhysicsBoneName("Tail_01"), "tail");
  assert.equal(classifyPhysicsBoneName("Breast_L"), "bust");

  assert.equal(isSecondaryPhysicsBoneName("Hair_Back_01"), true);
  assert.equal(isSecondaryPhysicsBoneName("Skirt_Front_02"), true);
  assert.equal(isSecondaryPhysicsBoneName("mixamorigHips"), false);
  assert.equal(isSecondaryPhysicsBoneName("Spine_01"), false);
  assert.equal(isSecondaryPhysicsBoneName("Head"), false);
  assert.equal(isSecondaryPhysicsBoneName("LeftUpperArm"), false);
  assert.equal(isSecondaryPhysicsBoneName("RightFoot"), false);
});

test("computeFramerateIndependentParams preserves damping time constant and equilibrium across 60Hz and 120Hz", () => {
  const baseStiffness = 0.9;
  const baseDrag = 0.4;
  const baseGravity = 0.3;

  const p60 = computeFramerateIndependentParams(baseStiffness, baseDrag, baseGravity, 1 / 60);
  const p120 = computeFramerateIndependentParams(baseStiffness, baseDrag, baseGravity, 1 / 120);

  // Exact match at 60Hz reference
  assert.ok(Math.abs(p60.stiffness - baseStiffness) < 1e-9);
  assert.ok(Math.abs(p60.dragForce - baseDrag) < 1e-9);
  assert.ok(Math.abs(p60.gravityPower - baseGravity) < 1e-9);

  // Two 120Hz steps equal one 60Hz step of drag decay: (1 - d120)^2 === (1 - d60)
  const decayTwo120 = (1 - p120.dragForce) ** 2;
  assert.ok(Math.abs(decayTwo120 - (1 - p60.dragForce)) < 1e-9);

  // Equilibrium gravity/stiffness ratio is invariant across framerates
  assert.ok(Math.abs(p120.gravityPower / p120.stiffness - p60.gravityPower / p60.stiffness) < 1e-9);
});

test("evaluateWindField produces distinct organic phase-offset wind per strand", () => {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  const phaseA = hashBonePhase("Hair_L_01", 0);
  const phaseB = hashBonePhase("Hair_R_01", 1);
  evaluateWindField(2.3, phaseA, -0.15, 1.4, a);
  evaluateWindField(2.3, phaseB, 0.15, 1.4, b);

  assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z));
  assert.ok(Math.abs(a.x - b.x) > 1e-4 || Math.abs(a.z - b.z) > 1e-4);
});

test("Avatar3DPhysicsController discovers FBX secondary chains, collides with body, and responds to drag inertia", () => {
  const root = new THREE.Group();
  const fbx = new THREE.Group();
  root.add(fbx);

  const head = new THREE.Bone();
  head.name = "Head";
  head.position.set(0, 1.45, 0);
  fbx.add(head);

  const hairRoot = new THREE.Bone();
  hairRoot.name = "Hair_Back_01";
  hairRoot.position.set(0, 0.05, -0.12);
  head.add(hairRoot);

  const hairMid = new THREE.Bone();
  hairMid.name = "Hair_Back_02";
  hairMid.position.set(0, -0.14, 0);
  hairRoot.add(hairMid);

  const hairTip = new THREE.Bone();
  hairTip.name = "Hair_Back_03";
  hairTip.position.set(0, -0.14, 0);
  hairMid.add(hairTip);

  const controller = new Avatar3DPhysicsController({ THREE, VRM: {} });
  controller.attachFbx(fbx, root);

  const stats = controller.getStats();
  assert.equal(stats.mode, "fbx");
  assert.equal(stats.jointCount, 2, "Hair_Back_01 and Hair_Back_02 should be active Verlet joints");
  assert.equal(stats.colliderCount, 1, "Head bone should produce a body sphere collider");

  const initialQuat = hairRoot.quaternion.clone();

  // Simulate gentle drag movement + several physics frames
  for (let i = 0; i < 12; i++) {
    root.position.x += 0.015;
    controller.updateFbx(root, i * (1 / 60), 1 / 60);
  }

  const angleDelta = initialQuat.angleTo(hairRoot.quaternion);
  assert.ok(angleDelta > 0.005, `Expected hair to sway from wind & drag inertia, got ${angleDelta}`);
  assert.ok(angleDelta < 0.85, `Expected cone limit to keep hair angle bounded, got ${angleDelta}`);
});

test("Avatar3DPhysicsController preserves VRM authored gravityDir, substeps frame spikes, and adds fallback colliders", () => {
  const root = new THREE.Group();
  const headBone = new THREE.Bone();
  headBone.name = "Head";
  const bangBone = new THREE.Bone();
  bangBone.name = "Hair_Bang_01";
  headBone.add(bangBone);
  root.add(headBone);

  let updateCalls = 0;
  let lastDelta = 0;
  const joint = {
    bone: bangBone,
    colliderGroups: [],
    settings: {
      hitRadius: 0.02,
      stiffness: 1.0,
      gravityPower: 0.25,
      gravityDir: new THREE.Vector3(0, -0.8, -0.6).normalize(),
      dragForce: 0.4,
    },
  };

  const mockVrm = {
    humanoid: {
      update() {},
      getRawBoneNode(name) {
        return name === "head" ? headBone : null;
      },
    },
    lookAt: { update() {} },
    expressionManager: { update() {} },
    nodeConstraintManager: { update() {} },
    springBoneManager: {
      joints: new Set([joint]),
      colliders: [],
      update(dt) {
        updateCalls++;
        lastDelta = dt;
      },
    },
  };

  class MockSphere {
    constructor(opts) {
      this.offset = opts.offset;
      this.radius = opts.radius;
    }
  }
  class MockCollider extends THREE.Object3D {
    constructor(shape) {
      super();
      this.shape = shape;
    }
  }

  const controller = new Avatar3DPhysicsController({
    THREE,
    VRM: {
      VRMSpringBoneCollider: MockCollider,
      VRMSpringBoneColliderShapeSphere: MockSphere,
    },
  });

  controller.attachVrm(mockVrm, root);
  assert.equal(joint.colliderGroups.length, 1, "Fallback body collider group should be attached when VRM has none");

  // Trigger a 50ms frame spike -> should substep into 3 steps of ~16.6ms
  controller.updateVrm(mockVrm, root, 1.5, 0.05);
  assert.equal(updateCalls, 3);
  assert.ok(Math.abs(lastDelta - 0.05 / 3) < 1e-6);
  // Authored backward Z gravity component should remain negative (not overwritten with +0.04)
  assert.ok(joint.settings.gravityDir.z < 0, `Expected authored -Z gravityDir preserved, got z=${joint.settings.gravityDir.z}`);
});
