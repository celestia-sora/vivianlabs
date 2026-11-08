import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepSimulation, easeDisplayed, desiredUploadPercent, UPLOAD_SIMULATION_CAP } from '../lib/upload-progress.ts';

test('simulation rises fast then asymptotically approaches the cap without reaching 100%', () => {
  let sim = 0;
  sim = stepSimulation(sim, 16);
  assert.ok(sim > 0 && sim <= UPLOAD_SIMULATION_CAP);
  assert.equal(UPLOAD_SIMULATION_CAP, 95);
  let previous = sim;
  for (let i = 0; i < 600; i++) {
    sim = stepSimulation(sim, 16);
    assert.ok(sim >= previous && sim <= UPLOAD_SIMULATION_CAP);
    previous = sim;
  }
  // Early steps are larger than late steps (ease-out).
  let fast = 0;
  fast = stepSimulation(fast, 100);
  assert.ok(fast > 1);
  let slow = stepSimulation(UPLOAD_SIMULATION_CAP - 2, 100);
  assert.ok((slow - (UPLOAD_SIMULATION_CAP - 2)) < (fast - 0));
});

test('displayed easing never goes backward within a stage', () => {
  assert.equal(easeDisplayed(50, 30, 16), 50);
  const moved = easeDisplayed(0, 80, 16);
  assert.ok(moved > 0 && moved < 80);
});

test('desired percent tracks actual from above while capped', () => {
  assert.equal(desiredUploadPercent(20, null), 20);
  assert.equal(desiredUploadPercent(20, 80), 80);
  assert.equal(desiredUploadPercent(80, 20), 80);
  assert.equal(desiredUploadPercent(90, 100), 95);
  assert.ok(desiredUploadPercent(90, 100) < 100);
});
