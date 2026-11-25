/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutoDifficulty,
  FatigueMonitor,
  HAND_LEVELS,
  OneEuroFilter,
  PushDetector,
  applyMagnet,
  buildChoiceOptions,
  buildHandSessionSummary,
  buildTraceShape,
  chooseTaskKind,
  computeHandScore100,
  computeMovementMetrics,
  computeReachCalibration,
  getKpFeedback,
  handSummaryToCsv,
  imageToReach,
  isPinching,
  mulberry32,
  newTraceState,
  placeReachTarget,
  placeTraceShape,
  resolveFireRule,
  stepMovingTarget,
  stepTrace,
  targetRadiusForLevel,
  verifyHandLevelMonotonicity,
  type HandAttemptRecord,
} from './handRules';

test('hand level table: 10 levels, monotonic, matches the agreed design', () => {
  assert.equal(Object.keys(HAND_LEVELS).length, 10);
  const mono = verifyHandLevelMonotonicity();
  assert.equal(mono.pass, true, mono.details.join(', '));
  // Lv1~3 정지 과녁, Lv1 시간 제한 없음
  for (const lv of [1, 2, 3]) assert.equal(HAND_LEVELS[lv].speed, 0);
  assert.equal(HAND_LEVELS[1].lifetimeSec, Infinity);
  // 크기 2.0 → 1.0, 속도 최대 0.8, 동시 최대 3
  assert.equal(HAND_LEVELS[1].sizeMul, 2.0);
  assert.equal(HAND_LEVELS[10].sizeMul, 1.0);
  assert.equal(HAND_LEVELS[10].speed, 0.8);
  assert.equal(HAND_LEVELS[10].simultaneous, 3);
  // 단계별 새 과제
  assert.equal(HAND_LEVELS[2].crossMidlineRate, 0);
  assert.ok(HAND_LEVELS[3].crossMidlineRate > 0);
  assert.equal(HAND_LEVELS[4].lookFirst, false);
  assert.equal(HAND_LEVELS[5].lookFirst, true);
  assert.equal(HAND_LEVELS[5].traceShapes.length, 0);
  assert.ok(HAND_LEVELS[6].traceShapes.length > 0);
  assert.equal(HAND_LEVELS[6].depthTargets, false);
  assert.equal(HAND_LEVELS[7].depthTargets, true);
  assert.equal(HAND_LEVELS[8].bimanual, false);
  assert.equal(HAND_LEVELS[9].bimanual, true);
  assert.ok(HAND_LEVELS[10].bimanualCrossRate > 0);
  assert.equal(HAND_LEVELS[10].magnet, 0);
  // 도달 범위 50% → 100%
  assert.equal(HAND_LEVELS[1].reachPct, 0.5);
  assert.equal(HAND_LEVELS[8].reachPct, 1.0);
});

test('fire rule: Lv1~3 dwell only, gestures from Lv4, explicit modes override', () => {
  for (const lv of [1, 2, 3]) {
    const r = resolveFireRule('auto', lv);
    assert.equal(r.pinch, false);
    assert.equal(r.push, false);
    assert.equal(r.dwellSec, 0.8);
  }
  assert.equal(resolveFireRule('auto', 4).pinch, true);
  assert.equal(resolveFireRule('pinch', 1).dwellSec, Infinity);
  assert.equal(resolveFireRule('push', 5).push, true);
  assert.equal(resolveFireRule('dwell', 9).pinch, false);
});

test('one euro filter smooths jitter but follows a steady move', () => {
  const f = new OneEuroFilter(1.2, 0.02);
  const rng = mulberry32(3);
  let maxDev = 0;
  for (let i = 0; i < 120; i++) {
    const noisy = 0.5 + (rng() - 0.5) * 0.02;
    const out = f.filter(noisy, i / 30);
    if (i > 10) maxDev = Math.max(maxDev, Math.abs(out - 0.5));
  }
  assert.ok(maxDev < 0.01, `jitter not reduced: ${maxDev}`);
  const g = new OneEuroFilter(1.2, 0.02);
  let out = 0;
  for (let i = 0; i <= 60; i++) out = g.filter(i / 60, i / 30);
  assert.ok(out > 0.85, `lags too much: ${out}`);
});

test('reach calibration is symmetric around the body midline and maps to ±1', () => {
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2;
    samples.push({ x: 0.55 + Math.cos(a) * 0.3, y: 0.5 + Math.sin(a) * 0.25 });
  }
  const cal = computeReachCalibration(samples, 0.5);
  // 오른쪽으로 0.85까지 뻗음 → 중앙선 기준 반폭 약 0.35
  assert.ok(Math.abs(cal.halfX - 0.35) < 0.02, String(cal.halfX));
  assert.ok(Math.abs(cal.halfY - 0.25) < 0.02, String(cal.halfY));
  const right = imageToReach({ x: 0.5 + cal.halfX, y: cal.centerY }, cal);
  assert.ok(Math.abs(right.x - 1) < 1e-6);
  const mid = imageToReach({ x: 0.5, y: cal.centerY }, cal);
  assert.ok(Math.abs(mid.x) < 1e-6);
  // 표본이 적으면 기본값
  assert.equal(computeReachCalibration([{ x: 0.5, y: 0.5 }]).sampleCount, 0);
});

test('target placement: same side vs crossing midline, reach grows with level', () => {
  const rng = mulberry32(11);
  for (let i = 0; i < 60; i++) {
    const r = targetRadiusForLevel(1);
    const p = placeReachTarget({ rng, level: 1, hand: 'R', crossMidline: false, radius: r });
    assert.ok(p.x > 0, 'right hand same side should be x>0');
    assert.ok(Math.hypot(p.x, p.y) <= 0.5 + 1e-6, 'Lv1 stays within 50% reach');
    assert.ok(Math.abs(p.y) < 0.25, 'Lv1 mostly sideways');
  }
  for (let i = 0; i < 60; i++) {
    const p = placeReachTarget({ rng, level: 5, hand: 'R', crossMidline: true, radius: targetRadiusForLevel(5) });
    assert.ok(p.x <= -0.15 + 1e-9, `crossing target must be on the other side: ${p.x}`);
  }
  for (let i = 0; i < 60; i++) {
    const r = targetRadiusForLevel(9);
    const p = placeReachTarget({ rng, level: 9, hand: 'L', crossMidline: false, radius: r });
    assert.ok(p.x < 0);
    assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1);
    assert.ok(Math.hypot(p.x, p.y) >= 0.45, 'Lv9 needs a long reach');
  }
});

test('moving targets bounce inside the play area', () => {
  let s = { pos: { x: 0.9, y: 0 }, vel: { x: 0.5, y: 0 } };
  s = stepMovingTarget(s.pos, s.vel, 0.5, 0.12);
  assert.ok(s.pos.x <= 1);
  assert.ok(s.vel.x < 0);
});

test('magnet pulls the cursor only near a target and never past it', () => {
  const t = [{ pos: { x: 0.5, y: 0 }, radius: 0.2 }];
  const near = applyMagnet({ x: 0.3, y: 0 }, t, 0.6);
  assert.ok(near.x > 0.3 && near.x < 0.5);
  const far = applyMagnet({ x: -0.5, y: 0 }, t, 0.6);
  assert.deepEqual(far, { x: -0.5, y: 0 });
  assert.deepEqual(applyMagnet({ x: 0.3, y: 0 }, t, 0), { x: 0.3, y: 0 });
});

test('pinch and push gestures', () => {
  assert.equal(isPinching(0.02, 0.1), true);
  assert.equal(isPinching(0.06, 0.1), false);
  const push = new PushDetector();
  assert.equal(push.update(0.1, 0), false);
  assert.equal(push.update(0.105, 0.1), false);
  assert.equal(push.update(0.12, 0.2), true);
  // 쿨다운 동안은 다시 감지하지 않음
  assert.equal(push.update(0.2, 0.3), false);
});

test('movement metrics split reaction and movement time, and detect overshoot', () => {
  // 0~200ms 정지, 200~600ms 직선 이동, 명중 600ms
  const samples = [];
  for (let t = 0; t <= 600; t += 20) {
    const x = t < 200 ? 0 : Math.min(0.6, ((t - 200) / 400) * 0.6);
    samples.push({ t, p: { x, y: 0 } });
  }
  const m = computeMovementMetrics({ samples, activationMs: 0, hitMs: 600, target: { x: 0.6, y: 0 }, radius: 0.1 });
  assert.ok(m.reactionMs !== null && m.reactionMs >= 180 && m.reactionMs <= 240, String(m.reactionMs));
  assert.ok(m.movementMs !== null && m.movementMs >= 360 && m.movementMs <= 420, String(m.movementMs));
  assert.ok(m.pathEfficiency !== null && m.pathEfficiency > 0.8);
  assert.equal(m.overshoot, false);
  assert.equal(getKpFeedback(m).tone, 'great');

  const over = [
    { t: 0, p: { x: 0, y: 0 } },
    { t: 100, p: { x: 0.3, y: 0 } },
    { t: 200, p: { x: 0.85, y: 0 } },
    { t: 300, p: { x: 0.6, y: 0 } },
  ];
  const mo = computeMovementMetrics({ samples: over, activationMs: 0, hitMs: 300, target: { x: 0.6, y: 0 }, radius: 0.1 });
  assert.equal(mo.overshoot, true);
  assert.equal(getKpFeedback(mo).tone, 'tip');
});

test('trace: must start on the start point, grades by deviation', () => {
  const path = placeTraceShape(buildTraceShape('line'), { x: 0, y: 0 }, 0.5);
  let st = newTraceState();
  // 시작점 밖에서는 시작 안 됨
  let r = stepTrace({ state: st, path, pointer: { x: 0.3, y: 0 }, corridor: 0.1, startRadius: 0.08 });
  assert.equal(r.state.started, false);
  r = stepTrace({ state: st, path, pointer: { x: -0.5, y: 0 }, corridor: 0.1, startRadius: 0.08 });
  st = r.state;
  assert.equal(st.started, true);
  let done = false;
  let result;
  for (let x = -0.5; x <= 0.5 + 1e-9 && !done; x += 0.02) {
    r = stepTrace({ state: st, path, pointer: { x, y: 0.01 }, corridor: 0.1, startRadius: 0.08 });
    st = r.state;
    if (r.completed) {
      done = true;
      result = r.result;
    }
  }
  assert.equal(done, true);
  assert.equal(result?.grade, 'PERFECT');
  assert.ok((result?.pathAccuracyPct ?? 0) >= 85);
});

test('auto difficulty follows the 80% / 60% challenge-point rule', () => {
  const ad = new AutoDifficulty();
  let lv = 3;
  for (let i = 0; i < 10; i++) lv = ad.record(i < 9, lv).level;
  assert.equal(lv, 4);
  for (let i = 0; i < 10; i++) lv = ad.record(i < 5, lv).level;
  assert.equal(lv, 3);
  for (let i = 0; i < 10; i++) lv = ad.record(i < 7, lv).level;
  assert.equal(lv, 3);
  // 경계 1과 10을 넘지 않음
  const ad2 = new AutoDifficulty();
  let lv2 = 1;
  for (let i = 0; i < 10; i++) lv2 = ad2.record(false, lv2).level;
  assert.equal(lv2, 1);
});

test('fatigue: hand missing or drooping for 6s ends the block', () => {
  const f = new FatigueMonitor();
  assert.equal(f.update({ x: 0, y: 0 }, 0), false);
  assert.equal(f.update(null, 1), false);
  assert.equal(f.update({ x: 0, y: 1.2 }, 4), false);
  assert.equal(f.update(null, 7.1), true);
  f.update({ x: 0, y: 0.2 }, 8);
  assert.equal(f.update(null, 9), false);
});

test('choice task: 3 options, exactly one correct, all distinct', () => {
  const rng = mulberry32(5);
  for (let i = 0; i < 20; i++) {
    const { options, instruction } = buildChoiceOptions(rng);
    assert.equal(options.length, 3);
    assert.equal(options.filter((o) => o.correct).length, 1);
    assert.equal(new Set(options.map((o) => o.colorHex)).size, 3);
    assert.equal(new Set(options.map((o) => o.shape)).size, 3);
    const c = options.find((o) => o.correct)!;
    assert.ok(instruction.includes(c.colorName) && instruction.includes(c.shapeName));
  }
});

test('task choice respects level and hand setting', () => {
  const rng = mulberry32(9);
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) seen.add(chooseTaskKind({ rng, level: 3, handSetting: 'R', bimanualAvailable: true }));
  assert.deepEqual([...seen], ['reach']);
  const seen10 = new Set<string>();
  for (let i = 0; i < 400; i++) seen10.add(chooseTaskKind({ rng, level: 10, handSetting: 'R', bimanualAvailable: true }));
  assert.ok(!seen10.has('bimanual'), 'bimanual only when both hands are selected');
  const seenBoth = new Set<string>();
  for (let i = 0; i < 400; i++) seenBoth.add(chooseTaskKind({ rng, level: 10, handSetting: 'both', bimanualAvailable: true }));
  for (const k of ['reach', 'trace', 'depth', 'choice', 'bimanual']) assert.ok(seenBoth.has(k), k);
});

test('session summary: midline, per-hand, score and real-object recommendations', () => {
  const rec = (o: Partial<HandAttemptRecord>): HandAttemptRecord => ({
    kind: 'reach', level: 3, hand: 'R', crossMidline: false, success: true, grade: 'GOOD',
    reactionMs: 400, movementMs: 700, pathEfficiency: 0.8, overshoot: false, traceAccuracyPct: null,
    wrongSelections: 0, earlyMove: false, block: 1, tSec: 1, ...o,
  });
  const records = [
    ...Array.from({ length: 8 }, () => rec({})),
    ...Array.from({ length: 4 }, (_, i) => rec({ crossMidline: true, success: i === 0, grade: i === 0 ? 'GOOD' : 'MISS' })),
  ];
  const s = buildHandSessionSummary({
    records, profileName: '하늘', profileAge: 7, handSetting: 'R', inputSource: 'camera',
    startLevel: 3, endLevel: 3, levelChanges: [], blocksPlanned: 3, blocksDone: 3, fatigueStops: 0,
    durationSec: 240, now: new Date('2026-11-25T10:00:00Z'),
  });
  assert.equal(s.attempts, 12);
  assert.equal(s.sameSideAccuracyPct, 100);
  assert.equal(s.crossMidlineAccuracyPct, 25);
  assert.ok(s.recommendations.some((t) => t.includes('몸 중앙')));
  assert.ok(s.score100 > 0 && s.score100 <= 100);
  const csv = handSummaryToCsv(s);
  assert.equal(csv.split('\n').length, 2);
  assert.equal(computeHandScore100({ accuracy: 1, pathEfficiency: 1, movementMs: 300 }), 100);
  assert.equal(computeHandScore100({ accuracy: 0, pathEfficiency: 0, movementMs: 3000 }), 0);
});
