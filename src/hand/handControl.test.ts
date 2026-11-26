/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARROW_GRAVITY,
  bowPoseHint,
  evaluateBowPose,
  BALLISTIC_MAX_SPEED,
  BALLISTIC_MIN_SPEED,
  BowGesture,
  DRAW_FULL_SEC,
  STRAIGHT_ARROW_SPEED,
  arrowLaunchSpeed,
  ballisticPosition,
  isBallisticLevel,
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

type Pt = { x: number; y: number; z: number };
/**
 * 손 관절 21개 합성 (거울 화면 이미지 좌표, y 아래로 +). 손목 (0.5, 0.8)
 * pinch: 엄지 끝을 검지 끝에 맞댐 / curl: 중지·약지·새끼를 손바닥 쪽으로 말아 쥠 / indexOpen: 검지를 곧게 폄
 */
function makeHand(opts: { pinch: boolean; curl: boolean; indexOpen: boolean }): Pt[] {
  const lm: Pt[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  lm[0] = { x: 0.5, y: 0.8, z: 0 };
  const finger = (base: number, mcpX: number, mcpY: number, open: boolean) => {
    lm[base] = { x: mcpX, y: mcpY, z: 0 };
    if (open) {
      lm[base + 1] = { x: mcpX, y: mcpY - 0.08, z: 0 };
      lm[base + 2] = { x: mcpX, y: mcpY - 0.13, z: 0 };
      lm[base + 3] = { x: mcpX, y: mcpY - 0.17, z: 0 };
    } else {
      // 둘째 마디에서 손바닥 쪽으로 꺾여 끝이 뿌리 근처로 돌아온다
      lm[base + 1] = { x: mcpX, y: mcpY - 0.06, z: -0.02 };
      lm[base + 2] = { x: mcpX, y: mcpY - 0.03, z: -0.05 };
      lm[base + 3] = { x: mcpX, y: mcpY + 0.02, z: -0.04 };
    }
  };
  finger(5, 0.45, 0.6, opts.indexOpen);
  finger(9, 0.5, 0.58, !opts.curl);
  finger(13, 0.55, 0.6, !opts.curl);
  finger(17, 0.6, 0.63, !opts.curl);
  lm[1] = { x: 0.42, y: 0.75, z: 0 };
  lm[2] = { x: 0.37, y: 0.69, z: 0 };
  lm[3] = { x: 0.34, y: 0.64, z: 0 };
  lm[4] = opts.pinch ? { x: lm[8].x - 0.01, y: lm[8].y, z: lm[8].z } : { x: 0.29, y: 0.6, z: 0 };
  return lm;
}
const BOW = makeHand({ pinch: true, curl: true, indexOpen: false });
const OPEN = makeHand({ pinch: false, curl: false, indexOpen: true });
const PINCH_ONLY = makeHand({ pinch: true, curl: false, indexOpen: false });
const FIST_ONLY = makeHand({ pinch: false, curl: true, indexOpen: false });

test('bow pose: thumb-index touch plus a full fist is the draw pose; all fingers out is the release', () => {
  const bow = evaluateBowPose(BOW);
  assert.equal(bow.thumbIndexTouch, true);
  assert.deepEqual(bow.curled, { middle: true, ring: true, pinky: true });
  assert.equal(bow.drawPose, true);
  assert.equal(bow.openHand, false);

  const open = evaluateBowPose(OPEN);
  assert.equal(open.extendedCount, 4);
  assert.equal(open.openHand, true);
  assert.equal(open.drawPose, false);

  // 엄지·검지만 붙이고 나머지는 편 손, 주먹만 쥔 손은 당기는 자세가 아니다
  assert.equal(evaluateBowPose(PINCH_ONLY).drawPose, false);
  assert.equal(evaluateBowPose(FIST_ONLY).drawPose, false);
  assert.equal(evaluateBowPose(FIST_ONLY).openHand, false);
  assert.ok(bowPoseHint(evaluateBowPose(PINCH_ONLY), 'idle').includes('주먹'));
  assert.ok(bowPoseHint(evaluateBowPose(FIST_ONLY), 'idle').includes('엄지·검지'));
});

test('bow gesture: hold the pose to draw, open every finger to shoot', () => {
  const g = new BowGesture();
  const bow = evaluateBowPose(BOW);
  const open = evaluateBowPose(OPEN);
  // 잠깐 스친 자세(0.05초)는 무시
  assert.equal(g.update(bow, 0.05).state, 'arming');
  assert.equal(g.update(open, 0.05).fired, false);
  assert.equal(g.update(bow, 0.05).state, 'arming');
  let r = g.update(bow, 0.1);
  assert.equal(r.state, 'drawing');
  r = g.update(bow, 0.6);
  assert.ok(Math.abs(r.draw - 0.6 / DRAW_FULL_SEC) < 1e-9);
  r = g.update(bow, 5);
  assert.equal(r.draw, 1, 'draw stops at full');
  // 손가락을 모두 펴면 발사
  r = g.update(open, 0.05);
  assert.equal(r.fired, true);
  assert.equal(r.fireDraw, 1);
  assert.equal(r.state, 'idle');
});

test('bow gesture: only opening the pinch does not shoot; breaking the pose too long cancels', () => {
  const g = new BowGesture();
  const bow = evaluateBowPose(BOW);
  g.update(bow, 0.15);
  g.update(bow, 0.6);
  // 엄지·검지만 떼고 주먹은 그대로 → 쏘지 않고 잠깐 기다림
  let r = g.update(evaluateBowPose(FIST_ONLY), 0.2);
  assert.equal(r.fired, false);
  assert.equal(r.state, 'hold');
  // 다시 쥐면 이어서 당긴다
  r = g.update(bow, 0.1);
  assert.equal(r.state, 'drawing');
  // 자세가 0.5초 넘게 풀리면 취소
  g.update(evaluateBowPose(FIST_ONLY), 0.3);
  r = g.update(evaluateBowPose(FIST_ONLY), 0.3);
  assert.equal(r.state, 'idle');
  assert.equal(g.update(evaluateBowPose(OPEN), 0.05).fired, false);
  // 너무 조금 당기고 펴면 쏘지 않는다
  g.update(bow, 0.15);
  g.update(bow, 0.05);
  assert.equal(g.update(evaluateBowPose(OPEN), 0.05).fired, false);
  // 손이 0.3초 넘게 안 보이면 취소
  g.update(bow, 0.15);
  g.update(bow, 0.5);
  g.update(null, 0.2);
  assert.equal(g.update(null, 0.2).state, 'idle');
});

test('arrow speed: levels 1-4 ignore the draw, level 5 depends on it and drops', () => {
  for (const lv of [1, 2, 3, 4]) {
    assert.equal(isBallisticLevel(lv), false);
    assert.equal(arrowLaunchSpeed(lv, 0.2), STRAIGHT_ARROW_SPEED);
    assert.equal(arrowLaunchSpeed(lv, 1), STRAIGHT_ARROW_SPEED);
  }
  assert.equal(isBallisticLevel(5), true);
  assert.equal(arrowLaunchSpeed(5, 0), BALLISTIC_MIN_SPEED);
  assert.equal(arrowLaunchSpeed(5, 1), BALLISTIC_MAX_SPEED);
  assert.ok(arrowLaunchSpeed(5, 0.5) > BALLISTIC_MIN_SPEED && arrowLaunchSpeed(5, 0.5) < BALLISTIC_MAX_SPEED);
  // 같은 거리(15m)에서 느린 화살이 더 많이 떨어진다
  const o = { x: 0, y: 0, z: 0 };
  const d = { x: 0, y: 0, z: -1 };
  const drop = (speed: number) => -ballisticPosition(o, d, speed, ARROW_GRAVITY, 15 / speed).y;
  assert.ok(drop(BALLISTIC_MIN_SPEED) > drop(BALLISTIC_MAX_SPEED) * 5);
  assert.ok(Math.abs(drop(30) - 0.5 * ARROW_GRAVITY * 0.25) < 1e-9);
});
