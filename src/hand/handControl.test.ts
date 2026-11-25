/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DwellFire,
  HAND_DWELL_SEC,
  HAND_TEST_POINTS,
  calibrationFromTest,
  edgeYawRate,
  edgeZone,
  handTipToNdc,
  newHandTestState,
  stepHandTest,
} from './handControl';
import { DEFAULT_CALIBRATION, OneEuroFilter, computeReachCalibration, imageToReach } from './handRules';

test('fingertip maps to screen NDC: mirrored right = +x, top = +y, clamped', () => {
  const cal = { ...DEFAULT_CALIBRATION };
  const right = handTipToNdc({ x: cal.midX + cal.halfX, y: cal.centerY }, cal);
  assert.ok(Math.abs(right.x - 1) < 1e-6);
  const top = handTipToNdc({ x: 0.5, y: cal.centerY - cal.halfY }, cal);
  assert.ok(Math.abs(top.y - 1) < 1e-6);
  const far = handTipToNdc({ x: 1.2, y: 1.2 }, cal);
  assert.equal(far.x, 1);
  assert.equal(far.y, -1);
});

test('edge rotation: none in the middle, turns toward the edge, faster deeper', () => {
  assert.equal(edgeYawRate(0), 0);
  assert.equal(edgeYawRate(0.7), 0);
  assert.ok(edgeYawRate(-0.9) > 0, 'left edge turns left (+yaw)');
  assert.ok(edgeYawRate(0.9) < 0, 'right edge turns right (-yaw)');
  assert.ok(Math.abs(edgeYawRate(1)) > Math.abs(edgeYawRate(0.85)));
  assert.ok(Math.abs(Math.abs(edgeYawRate(1)) - (75 * Math.PI) / 180) < 1e-9);
  assert.equal(edgeZone(-0.95), 'left');
  assert.equal(edgeZone(0.95), 'right');
  assert.equal(edgeZone(0.2), null);
});

test('dwell fire: 0.5s on a target fires once, leaving resets, then cooldown', () => {
  const d = new DwellFire();
  assert.equal(HAND_DWELL_SEC, 0.5);
  let fired = 0;
  for (let i = 0; i < 4; i++) fired += d.update(true, 0.1) ? 1 : 0;
  assert.equal(fired, 0);
  assert.ok(d.progress > 0.7);
  assert.equal(d.update(false, 0.1), false);
  assert.equal(d.progress, 0);
  for (let i = 0; i < 5; i++) fired += d.update(true, 0.1) ? 1 : 0;
  assert.equal(fired, 1);
  // 쿨다운 중에는 바로 다시 쏘지 않음
  assert.equal(d.update(true, 0.1), false);
});

test('dwell keeps its progress through a short tracking gap, resets after a long one', () => {
  const d = new DwellFire();
  d.update(true, 0.3);
  d.update(null, 0.2); // 잠깐 놓침
  assert.ok(d.progress > 0.5);
  assert.equal(d.update(true, 0.25), true);
  const e = new DwellFire();
  e.update(true, 0.3);
  e.update(null, 0.2);
  e.update(null, 0.2); // 0.4초 놓침 → 처음부터
  assert.equal(e.progress, 0);
  let st = newHandTestState();
  st = stepHandTest(st, HAND_TEST_POINTS[0].pos, 0.3).state;
  st = stepHandTest(st, null, 0.2).state;
  assert.ok(st.heldSec > 0.25);
  assert.equal(stepHandTest(st, HAND_TEST_POINTS[0].pos, 0.25).advanced, true);
});

test('hand test: each point needs a 0.5s hold, in order, then passes and calibrates', () => {
  // 엉뚱한 곳은 통과 못함
  let wrong = newHandTestState();
  for (let i = 0; i < 20; i++) wrong = stepHandTest(wrong, { x: 0.95, y: 0.05 }, 0.1).state;
  assert.equal(wrong.index, 0);
  let st = newHandTestState();
  let passed = false;
  for (const p of HAND_TEST_POINTS) {
    for (let i = 0; i < 6; i++) {
      const r = stepHandTest(st, { x: p.pos.x + 0.01, y: p.pos.y }, 0.1);
      st = r.state;
      passed = passed || r.passed;
    }
  }
  assert.equal(st.index, HAND_TEST_POINTS.length);
  assert.equal(passed, true);
  const cal = calibrationFromTest(st);
  // 테스트에서 왼쪽 0.18 ~ 오른쪽 0.82까지 뻗었으니 중앙선 기준 반폭은 약 0.32
  assert.ok(cal.halfX > 0.25 && cal.halfX < 0.4, String(cal.halfX));
  assert.ok(handTipToNdc({ x: 0.83, y: 0.5 }, cal).x > 0.95, 'reaching the right test point reaches the screen edge');
});

test('one euro filter smooths jitter but follows a steady move', () => {
  const f = new OneEuroFilter(1.2, 0.02);
  let maxDev = 0;
  for (let i = 0; i < 120; i++) {
    const noisy = 0.5 + (i % 2 ? 0.006 : -0.006);
    const out = f.filter(noisy, i / 30);
    if (i > 10) maxDev = Math.max(maxDev, Math.abs(out - 0.5));
  }
  assert.ok(maxDev < 0.006, `jitter not reduced: ${maxDev}`);
  const g = new OneEuroFilter(1.2, 0.02);
  let out = 0;
  for (let i = 0; i <= 60; i++) out = g.filter(i / 60, i / 30);
  assert.ok(out > 0.85, `lags too much: ${out}`);
});

test('reach calibration is symmetric around the body midline', () => {
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2;
    samples.push({ x: 0.55 + Math.cos(a) * 0.3, y: 0.5 + Math.sin(a) * 0.25 });
  }
  const cal = computeReachCalibration(samples, 0.5);
  assert.ok(Math.abs(cal.halfX - 0.35) < 0.02, String(cal.halfX));
  assert.ok(Math.abs(imageToReach({ x: 0.5, y: cal.centerY }, cal).x) < 1e-6);
  assert.equal(computeReachCalibration([{ x: 0.5, y: 0.5 }]).sampleCount, 0);
});
