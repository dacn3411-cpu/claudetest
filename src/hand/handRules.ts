/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 손 치료 모드(웹캠 손 추적) 순수 로직.
 * React·MediaPipe에 의존하지 않아 node:test로 검증할 수 있다.
 *
 * 좌표계 "도달 공간(reach space)":
 *   x: -1(아동의 왼쪽 최대 도달) ~ 0(몸 중앙선) ~ +1(오른쪽 최대 도달)
 *   y: -1(위쪽 최대 도달) ~ +1(아래쪽 최대 도달)
 * 화면에는 이 공간이 그대로 놀이 영역에 그려지므로, 화면 가장자리 = 팔을 끝까지 뻗은 위치다.
 */

import { evaluateContinuousLaserDragProgress, gradeLaserTrace } from '../game/rules';

export type HandSide = 'L' | 'R';
export type HandSetting = 'L' | 'R' | 'both';
export type FireMode = 'auto' | 'dwell' | 'pinch' | 'push';
export type HandTaskKind = 'reach' | 'trace' | 'depth' | 'choice' | 'bimanual';
export type TraceShapeKind = 'line' | 'circle' | 'square' | 'triangle' | 'figure8' | 'zigzag';

export interface Vec2 {
  x: number;
  y: number;
}

// ───────────────────────────── 레벨표 ─────────────────────────────

export interface HandLevelConfig {
  level: number;
  /** 과녁 크기 배율 (반지름 = HAND_BASE_RADIUS × sizeMul, 도달 공간 단위) */
  sizeMul: number;
  /** 이동 속도 (0 = 정지). 도달 공간 단위/초 = speed × 0.5 */
  speed: number;
  /** 동시에 진행하는 과제 수 */
  simultaneous: number;
  /** 과녁 유지 시간(초). Infinity = 맞힐 때까지 */
  lifetimeSec: number;
  /** 과녁이 놓이는 최대 도달 범위 (보정한 팔 도달 범위 대비 0~1) */
  reachPct: number;
  /** 몸 중앙선을 넘어가는 과녁 비율 */
  crossMidlineRate: number;
  /** 과녁이 0.5초 반짝인 뒤에만 맞힐 수 있음 (보고 → 뻗기) */
  lookFirst: boolean;
  /** 손가락 따라 그리기 도형 */
  traceShapes: TraceShapeKind[];
  /** 앞으로 뻗어야 하는 깊이 과녁 */
  depthTargets: boolean;
  /** 정답 고르기 과제 */
  choiceTask: boolean;
  /** 양손 과제 (손 설정이 '양손'일 때만) */
  bimanual: boolean;
  /** 양손 과제에서 손을 교차해야 하는 비율 */
  bimanualCrossRate: number;
  /** 자석 보조 세기 0~1 */
  magnet: number;
  /** 자동 발사 방식에서 머무르기 시간(초) */
  dwellSec: number;
  /** 자동 발사 방식에서 집기/뻗기 허용 */
  allowGesture: boolean;
  /** 아동·치료사용 한 줄 설명 */
  label: string;
}

export const HAND_BASE_RADIUS = 0.12;
export const LOOK_FIRST_CUE_SEC = 0.5;

export const HAND_LEVELS: Record<number, HandLevelConfig> = {
  1: {
    level: 1, sizeMul: 2.0, speed: 0, simultaneous: 1, lifetimeSec: Infinity, reachPct: 0.5,
    crossMidlineRate: 0, lookFirst: false, traceShapes: [], depthTargets: false, choiceTask: false,
    bimanual: false, bimanualCrossRate: 0, magnet: 0.6, dwellSec: 0.8, allowGesture: false,
    label: '몸 가까이 · 같은 쪽 손 · 큰 정지 과녁 · 손을 대고 기다리면 명중',
  },
  2: {
    level: 2, sizeMul: 1.8, speed: 0, simultaneous: 1, lifetimeSec: 15, reachPct: 0.6,
    crossMidlineRate: 0, lookFirst: false, traceShapes: [], depthTargets: false, choiceTask: false,
    bimanual: false, bimanualCrossRate: 0, magnet: 0.55, dwellSec: 0.8, allowGesture: false,
    label: '위·아래 방향 추가 · 조금 더 멀리',
  },
  3: {
    level: 3, sizeMul: 1.6, speed: 0, simultaneous: 1, lifetimeSec: 12, reachPct: 0.7,
    crossMidlineRate: 0.3, lookFirst: false, traceShapes: [], depthTargets: false, choiceTask: false,
    bimanual: false, bimanualCrossRate: 0, magnet: 0.5, dwellSec: 0.8, allowGesture: false,
    label: '몸 중앙선 넘기 (반대쪽 과녁) 시작',
  },
  4: {
    level: 4, sizeMul: 1.5, speed: 0.2, simultaneous: 1, lifetimeSec: 10, reachPct: 0.8,
    crossMidlineRate: 0.35, lookFirst: false, traceShapes: [], depthTargets: false, choiceTask: false,
    bimanual: false, bimanualCrossRate: 0, magnet: 0.4, dwellSec: 0.6, allowGesture: true,
    label: '천천히 움직이는 과녁 · 집기 동작 사용 가능',
  },
  5: {
    level: 5, sizeMul: 1.4, speed: 0.3, simultaneous: 1, lifetimeSec: 10, reachPct: 0.8,
    crossMidlineRate: 0.35, lookFirst: true, traceShapes: [], depthTargets: false, choiceTask: false,
    bimanual: false, bimanualCrossRate: 0, magnet: 0.35, dwellSec: 0.6, allowGesture: true,
    label: '보고 → 뻗기: 과녁이 반짝인 뒤에 출발',
  },
  6: {
    level: 6, sizeMul: 1.3, speed: 0.4, simultaneous: 2, lifetimeSec: 8, reachPct: 0.9,
    crossMidlineRate: 0.4, lookFirst: true, traceShapes: ['line', 'circle'], depthTargets: false,
    choiceTask: false, bimanual: false, bimanualCrossRate: 0, magnet: 0.3, dwellSec: 0.6,
    allowGesture: true, label: '손가락으로 직선·원 따라 그리기',
  },
  7: {
    level: 7, sizeMul: 1.2, speed: 0.5, simultaneous: 2, lifetimeSec: 8, reachPct: 0.9,
    crossMidlineRate: 0.4, lookFirst: true, traceShapes: ['line', 'circle', 'zigzag'], depthTargets: true,
    choiceTask: true, bimanual: false, bimanualCrossRate: 0, magnet: 0.2, dwellSec: 1.0,
    allowGesture: true, label: '앞으로 쭉 뻗기 (깊이) · 정답 고르기',
  },
  8: {
    level: 8, sizeMul: 1.1, speed: 0.6, simultaneous: 2, lifetimeSec: 7, reachPct: 1.0,
    crossMidlineRate: 0.45, lookFirst: true, traceShapes: ['circle', 'square', 'triangle', 'figure8'],
    depthTargets: true, choiceTask: true, bimanual: false, bimanualCrossRate: 0, magnet: 0.12,
    dwellSec: 1.0, allowGesture: true, label: '사각형·삼각형·8자 따라 그리기 · 팔 끝까지',
  },
  9: {
    level: 9, sizeMul: 1.0, speed: 0.7, simultaneous: 2, lifetimeSec: 6, reachPct: 1.0,
    crossMidlineRate: 0.45, lookFirst: true, traceShapes: ['square', 'triangle', 'figure8'],
    depthTargets: true, choiceTask: true, bimanual: true, bimanualCrossRate: 0, magnet: 0.05,
    dwellSec: 1.0, allowGesture: true, label: '양손 과제: 두 손이 각자 과녁',
  },
  10: {
    level: 10, sizeMul: 1.0, speed: 0.8, simultaneous: 3, lifetimeSec: 6, reachPct: 1.0,
    crossMidlineRate: 0.5, lookFirst: true, traceShapes: ['square', 'triangle', 'figure8', 'zigzag'],
    depthTargets: true, choiceTask: true, bimanual: true, bimanualCrossRate: 0.5, magnet: 0,
    dwellSec: 1.0, allowGesture: true, label: '양손 + 중앙선 넘기 + 정답 고르기',
  },
};

export function clampHandLevel(level: number): number {
  return Math.max(1, Math.min(10, Math.round(Number.isFinite(level) ? level : 1)));
}

export function getHandLevel(level: number): HandLevelConfig {
  return HAND_LEVELS[clampHandLevel(level)];
}

export function targetRadiusForLevel(level: number): number {
  return HAND_BASE_RADIUS * getHandLevel(level).sizeMul;
}

/** 레벨이 오를수록 크기·자석은 줄고 속도·도달 범위·동시 수는 줄지 않는지 검사 */
export function verifyHandLevelMonotonicity(): { pass: boolean; details: string[] } {
  const details: string[] = [];
  for (let lv = 2; lv <= 10; lv++) {
    const a = HAND_LEVELS[lv - 1];
    const b = HAND_LEVELS[lv];
    if (b.sizeMul > a.sizeMul) details.push(`Lv${lv} sizeMul 증가`);
    if (b.speed < a.speed) details.push(`Lv${lv} speed 감소`);
    if (b.simultaneous < a.simultaneous) details.push(`Lv${lv} simultaneous 감소`);
    if (b.reachPct < a.reachPct) details.push(`Lv${lv} reachPct 감소`);
    if (b.magnet > a.magnet) details.push(`Lv${lv} magnet 증가`);
    if (b.lifetimeSec > a.lifetimeSec) details.push(`Lv${lv} lifetime 증가`);
  }
  return { pass: details.length === 0, details };
}

// ───────────────────────────── 떨림 보정 (One Euro Filter) ─────────────────────────────

class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number | null {
    return this.y;
  }
  reset() {
    this.y = null;
  }
}

/**
 * One Euro Filter (Casiez, Roussel & Vogel, CHI 2012).
 * 천천히 움직일 때는 떨림을 강하게 줄이고, 빠르게 움직일 때는 지연을 줄인다.
 */
export class OneEuroFilter {
  private xFilt = new LowPass();
  private dxFilt = new LowPass();
  private lastT: number | null = null;
  constructor(
    public minCutoff = 1.2,
    public beta = 0.02,
    public dCutoff = 1.0,
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, tSec: number): number {
    if (this.lastT === null || tSec <= this.lastT) {
      this.lastT = tSec;
      this.dxFilt.filter(0, 1);
      return this.xFilt.filter(x, 1);
    }
    const dt = Math.min(0.25, tSec - this.lastT);
    this.lastT = tSec;
    const prev = this.xFilt.last() ?? x;
    const dx = (x - prev) / dt;
    const edx = this.dxFilt.filter(dx, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilt.filter(x, this.alpha(cutoff, dt));
  }

  reset() {
    this.xFilt.reset();
    this.dxFilt.reset();
    this.lastT = null;
  }
}

export class OneEuroFilter2D {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  constructor(minCutoff = 1.2, beta = 0.02) {
    this.fx = new OneEuroFilter(minCutoff, beta);
    this.fy = new OneEuroFilter(minCutoff, beta);
  }
  filter(p: Vec2, tSec: number): Vec2 {
    return { x: this.fx.filter(p.x, tSec), y: this.fy.filter(p.y, tSec) };
  }
  reset() {
    this.fx.reset();
    this.fy.reset();
  }
}

// ───────────────────────────── 팔 도달 범위 보정 ─────────────────────────────

/** 카메라 이미지 좌표(0~1, 좌우 반전된 거울 화면 기준)에서 잰 도달 범위 */
export interface ReachCalibration {
  /** 몸 중앙선 x (아동이 화면 가운데 앉는다고 보고 0.5) */
  midX: number;
  /** 중앙선에서 좌우로 뻗을 수 있는 거리 */
  halfX: number;
  centerY: number;
  halfY: number;
  sampleCount: number;
}

export const DEFAULT_CALIBRATION: ReachCalibration = {
  midX: 0.5,
  halfX: 0.38,
  centerY: 0.5,
  halfY: 0.36,
  sampleCount: 0,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * 보정 단계에서 모은 손가락 끝 위치(거울 화면 이미지 좌표)로 도달 범위를 만든다.
 * 튀는 값은 5~95 백분위로 잘라낸다. 좌우는 몸 중앙선 기준 대칭으로 잡아 중앙선 넘기가 의미를 갖게 한다.
 */
export function computeReachCalibration(samples: Vec2[], midX = 0.5): ReachCalibration {
  if (samples.length < 15) {
    return { ...DEFAULT_CALIBRATION, midX };
  }
  const xs = samples.map((s) => s.x).sort((a, b) => a - b);
  const ys = samples.map((s) => s.y).sort((a, b) => a - b);
  const minX = percentile(xs, 0.05);
  const maxX = percentile(xs, 0.95);
  const minY = percentile(ys, 0.05);
  const maxY = percentile(ys, 0.95);
  const halfX = Math.max(0.12, Math.min(0.5, Math.max(Math.abs(minX - midX), Math.abs(maxX - midX))));
  const halfY = Math.max(0.1, Math.min(0.5, (maxY - minY) / 2));
  return {
    midX,
    halfX: Number(halfX.toFixed(4)),
    centerY: Number(((minY + maxY) / 2).toFixed(4)),
    halfY: Number(halfY.toFixed(4)),
    sampleCount: samples.length,
  };
}

/** 거울 화면 이미지 좌표 → 도달 공간 (±1.25로 제한) */
export function imageToReach(p: Vec2, cal: ReachCalibration): Vec2 {
  const clamp = (v: number) => Math.max(-1.25, Math.min(1.25, v));
  return {
    x: clamp((p.x - cal.midX) / cal.halfX),
    y: clamp((p.y - cal.centerY) / cal.halfY),
  };
}

// ───────────────────────────── 손 동작 감지 ─────────────────────────────

/** 엄지 끝–검지 끝 거리가 손 크기의 35% 미만이면 집기 */
export function isPinching(pinchDist: number, handSize: number): boolean {
  if (!(handSize > 0)) return false;
  return pinchDist / handSize < 0.35;
}

/**
 * 앞으로 뻗기 감지: 최근 0.4초 안에 손 크기(손목–중지 뿌리)가 15% 이상 커지면 뻗기.
 * 카메라 쪽으로 손이 가까워지면 화면 속 손이 커지는 원리.
 */
export class PushDetector {
  private history: Array<{ t: number; size: number }> = [];
  private cooldownUntil = 0;
  constructor(
    public windowSec = 0.4,
    public growth = 0.15,
    public cooldownSec = 0.6,
  ) {}

  update(size: number, tSec: number): boolean {
    if (!(size > 0)) return false;
    this.history.push({ t: tSec, size });
    while (this.history.length && this.history[0].t < tSec - this.windowSec) this.history.shift();
    if (tSec < this.cooldownUntil) return false;
    const minSize = Math.min(...this.history.map((h) => h.size));
    if (minSize > 0 && size / minSize >= 1 + this.growth) {
      this.cooldownUntil = tSec + this.cooldownSec;
      this.history = [{ t: tSec, size }];
      return true;
    }
    return false;
  }

  reset() {
    this.history = [];
    this.cooldownUntil = 0;
  }
}

export interface FireRule {
  dwellSec: number;
  pinch: boolean;
  push: boolean;
}

/** 발사 방식 설정 + 레벨 → 실제로 허용하는 동작 */
export function resolveFireRule(mode: FireMode, level: number): FireRule {
  const cfg = getHandLevel(level);
  switch (mode) {
    case 'dwell':
      return { dwellSec: cfg.dwellSec, pinch: false, push: false };
    case 'pinch':
      return { dwellSec: Infinity, pinch: true, push: false };
    case 'push':
      return { dwellSec: Infinity, pinch: false, push: true };
    default:
      return { dwellSec: cfg.dwellSec, pinch: cfg.allowGesture, push: cfg.allowGesture };
  }
}

// ───────────────────────────── 과녁 배치 ─────────────────────────────

export type Rng = () => number;

/** 재현 가능한 의사 난수 (테스트용) */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 과녁 위치 고르기.
 * - 같은 쪽: 해당 손 쪽 (x 부호), 중앙선 넘기: 반대쪽으로 0.15 이상
 * - 몸 중심(0,0)에서 거리 = reachPct의 (0.5~1.0) 구간 → 레벨이 오를수록 더 멀리 뻗어야 함
 * - Lv1은 위아래를 좁게(옆으로 뻗기 위주), Lv2부터 위·아래 방향 추가
 */
export function placeReachTarget(params: {
  rng: Rng;
  level: number;
  hand: HandSide;
  crossMidline: boolean;
  radius: number;
  avoid?: Array<{ pos: Vec2; radius: number }>;
}): Vec2 {
  const cfg = getHandLevel(params.level);
  const sideSign = params.hand === 'R' ? 1 : -1;
  const targetSign = params.crossMidline ? -sideSign : sideSign;
  const maxDist = cfg.reachPct;
  const minDist = Math.max(0.22, maxDist * 0.5);
  const vertSpread = params.level <= 1 ? 0.35 : 1.0;
  const lim = 1 - params.radius * 0.6;

  let best: Vec2 = { x: targetSign * minDist, y: 0 };
  let bestScore = -Infinity;
  for (let attempt = 0; attempt < 40; attempt++) {
    const dist = minDist + (maxDist - minDist) * params.rng();
    // 각도: 수평(0)에서 위/아래로 최대 ±70° (Lv1은 ±25°)
    const ang = (params.rng() * 2 - 1) * (Math.PI / 180) * 70 * vertSpread;
    let x = targetSign * Math.cos(ang) * dist;
    let y = Math.sin(ang) * dist;
    // 중앙선 넘기 과녁은 확실히 반대편(0.15 이상), 같은 쪽 과녁은 0.05 이상
    const minSide = params.crossMidline ? 0.15 : 0.05;
    if (Math.abs(x) < minSide) x = targetSign * minSide;
    x = Math.max(-lim, Math.min(lim, x));
    y = Math.max(-lim, Math.min(lim, y));
    const p = { x, y };
    let clearance = Infinity;
    for (const o of params.avoid ?? []) {
      clearance = Math.min(clearance, Math.hypot(o.pos.x - x, o.pos.y - y) - o.radius - params.radius);
    }
    if (clearance >= 0.08) return p;
    if (clearance > bestScore) {
      bestScore = clearance;
      best = p;
    }
  }
  return best;
}

/** 이동 과녁: 벽(±lim)에 닿으면 튕긴다 */
export function stepMovingTarget(
  pos: Vec2,
  vel: Vec2,
  dtSec: number,
  radius: number,
): { pos: Vec2; vel: Vec2 } {
  const lim = 1 - radius * 0.6;
  let x = pos.x + vel.x * dtSec;
  let y = pos.y + vel.y * dtSec;
  let vx = vel.x;
  let vy = vel.y;
  if (x > lim) { x = lim; vx = -Math.abs(vx); }
  if (x < -lim) { x = -lim; vx = Math.abs(vx); }
  if (y > lim) { y = lim; vy = -Math.abs(vy); }
  if (y < -lim) { y = -lim; vy = Math.abs(vy); }
  return { pos: { x, y }, vel: { x: vx, y: vy } };
}

export function randomVelocity(rng: Rng, level: number): Vec2 {
  const speed = getHandLevel(level).speed * 0.5;
  if (speed <= 0) return { x: 0, y: 0 };
  const ang = rng() * Math.PI * 2;
  return { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed };
}

/** 자석 보조: 과녁 근처에서 표시 커서를 중심 쪽으로 당긴다 */
export function applyMagnet(cursor: Vec2, targets: Array<{ pos: Vec2; radius: number }>, strength: number): Vec2 {
  if (!(strength > 0) || targets.length === 0) return cursor;
  let nearest: { pos: Vec2; radius: number } | null = null;
  let nearestD = Infinity;
  for (const t of targets) {
    const d = Math.hypot(t.pos.x - cursor.x, t.pos.y - cursor.y);
    if (d < nearestD) {
      nearestD = d;
      nearest = t;
    }
  }
  if (!nearest) return cursor;
  const range = nearest.radius * 2.2;
  if (nearestD >= range) return cursor;
  const pull = strength * 0.55 * (1 - nearestD / range);
  return {
    x: cursor.x + (nearest.pos.x - cursor.x) * pull,
    y: cursor.y + (nearest.pos.y - cursor.y) * pull,
  };
}

/** 자석 보조가 있으면 판정 반지름도 조금 넓힌다 */
export function effectiveHitRadius(radius: number, magnet: number): number {
  return radius * (1 + 0.25 * Math.max(0, Math.min(1, magnet)));
}

// ───────────────────────────── 과제 고르기 ─────────────────────────────

export function chooseTaskKind(params: {
  rng: Rng;
  level: number;
  handSetting: HandSetting;
  bimanualAvailable: boolean;
}): HandTaskKind {
  const cfg = getHandLevel(params.level);
  const options: Array<{ kind: HandTaskKind; w: number }> = [{ kind: 'reach', w: 1 }];
  if (cfg.traceShapes.length > 0) options.push({ kind: 'trace', w: 0.3 });
  if (cfg.depthTargets) options.push({ kind: 'depth', w: 0.3 });
  if (cfg.choiceTask) options.push({ kind: 'choice', w: 0.3 });
  if (cfg.bimanual && params.handSetting === 'both' && params.bimanualAvailable) {
    options.push({ kind: 'bimanual', w: 0.6 });
  }
  const total = options.reduce((s, o) => s + o.w, 0);
  let r = params.rng() * total;
  for (const o of options) {
    r -= o.w;
    if (r <= 0) return o.kind;
  }
  return 'reach';
}

// ───────────────────────────── 정답 고르기 ─────────────────────────────

export const CHOICE_COLORS = [
  { name: '노란', hex: '#F5B749' },
  { name: '파란', hex: '#4F9DF7' },
  { name: '분홍', hex: '#F472B6' },
  { name: '초록', hex: '#34D399' },
] as const;

export const CHOICE_SHAPES = [
  { kind: 'circle', name: '동그라미' },
  { kind: 'star', name: '별' },
  { kind: 'triangle', name: '세모' },
  { kind: 'square', name: '네모' },
] as const;

export type ChoiceShapeKind = (typeof CHOICE_SHAPES)[number]['kind'];

export interface ChoiceOption {
  colorName: string;
  colorHex: string;
  shape: ChoiceShapeKind;
  shapeName: string;
  correct: boolean;
}

function shuffled<T>(arr: readonly T[], rng: Rng): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 서로 색과 모양이 다른 3개 중 정답 1개 */
export function buildChoiceOptions(rng: Rng): { options: ChoiceOption[]; instruction: string } {
  const colors = shuffled(CHOICE_COLORS, rng).slice(0, 3);
  const shapes = shuffled(CHOICE_SHAPES, rng).slice(0, 3);
  const correctIdx = Math.floor(rng() * 3);
  const options = colors.map((c, i) => ({
    colorName: c.name,
    colorHex: c.hex,
    shape: shapes[i].kind,
    shapeName: shapes[i].name,
    correct: i === correctIdx,
  }));
  const c = options[correctIdx];
  return { options, instruction: `${c.colorName} ${c.shapeName}를 찾아요` };
}

// ───────────────────────────── 따라 그리기 도형 ─────────────────────────────

export const TRACE_SHAPE_LABELS: Record<TraceShapeKind, string> = {
  line: '직선',
  circle: '동그라미',
  square: '네모',
  triangle: '세모',
  figure8: '8자',
  zigzag: '지그재그',
};

/** 단위 도형(중심 0,0 · 반지름 1)을 촘촘한 점들로 만든다 */
export function buildTraceShape(kind: TraceShapeKind, samples = 72): Vec2[] {
  const pts: Vec2[] = [];
  const poly = (corners: Vec2[]) => {
    const per = Math.max(4, Math.round(samples / (corners.length - 1)));
    for (let i = 0; i < corners.length - 1; i++) {
      const a = corners[i];
      const b = corners[i + 1];
      for (let k = 0; k < per; k++) {
        const t = k / per;
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    pts.push(corners[corners.length - 1]);
  };
  switch (kind) {
    case 'line':
      poly([{ x: -1, y: 0 }, { x: 1, y: 0 }]);
      break;
    case 'circle':
      for (let i = 0; i <= samples; i++) {
        const a = -Math.PI / 2 + (i / samples) * Math.PI * 2;
        pts.push({ x: Math.cos(a), y: Math.sin(a) });
      }
      break;
    case 'square':
      poly([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }, { x: -1, y: -1 }]);
      break;
    case 'triangle':
      poly([{ x: 0, y: -1 }, { x: 0.95, y: 0.8 }, { x: -0.95, y: 0.8 }, { x: 0, y: -1 }]);
      break;
    case 'figure8':
      for (let i = 0; i <= samples; i++) {
        const a = (i / samples) * Math.PI * 2;
        pts.push({ x: Math.sin(a), y: Math.sin(a) * Math.cos(a) * 1.6 });
      }
      break;
    case 'zigzag':
      poly([
        { x: -1, y: 0.5 }, { x: -0.5, y: -0.5 }, { x: 0, y: 0.5 }, { x: 0.5, y: -0.5 }, { x: 1, y: 0.5 },
      ]);
      break;
  }
  return pts;
}

/** 단위 도형을 도달 공간의 위치·크기로 옮긴다 */
export function placeTraceShape(unit: Vec2[], center: Vec2, scale: number): Vec2[] {
  return unit.map((p) => ({ x: center.x + p.x * scale, y: center.y + p.y * scale }));
}

/** 레벨별 따라 그리기 허용 폭 (도달 공간 단위) */
export function traceCorridorForLevel(level: number): number {
  const lv = clampHandLevel(level);
  return lv <= 6 ? 0.11 : lv <= 8 ? 0.09 : 0.075;
}

export interface TraceState {
  progress: number;
  devSum: number;
  devN: number;
  started: boolean;
}

export function newTraceState(): TraceState {
  return { progress: 0, devSum: 0, devN: 0, started: false };
}

/**
 * 따라 그리기 한 프레임 진행. 시작점(반지름 startRadius)에 손가락을 대야 시작한다.
 * 진행 중 경로 이탈(최근접 거리 ÷ 허용 폭)을 모아 완주 시 PERFECT/GOOD과 경로 정확도를 낸다.
 */
export function stepTrace(params: {
  state: TraceState;
  path: Vec2[];
  pointer: Vec2;
  corridor: number;
  startRadius: number;
}): {
  state: TraceState;
  completed: boolean;
  onTrack: boolean;
  result?: ReturnType<typeof gradeLaserTrace>;
} {
  const s = { ...params.state };
  if (!s.started) {
    const p0 = params.path[0];
    if (Math.hypot(params.pointer.x - p0.x, params.pointer.y - p0.y) <= params.startRadius) {
      s.started = true;
      s.progress = 0.01;
    }
    return { state: s, completed: false, onTrack: s.started };
  }
  const r = evaluateContinuousLaserDragProgress({
    samples: params.path,
    currentProgress: s.progress,
    pointer: params.pointer,
    corridorTol: params.corridor,
    maxForwardStep: 0.12,
    completionThreshold: 0.95,
  });
  if (r.onTrack && Number.isFinite(r.closestDist)) {
    s.devSum += r.closestDist / params.corridor;
    s.devN += 1;
  }
  s.progress = Math.max(s.progress, r.nextProgress);
  if (r.completed) {
    return {
      state: s,
      completed: true,
      onTrack: true,
      result: gradeLaserTrace(s.devN > 0 ? s.devSum / s.devN : 0.5),
    };
  }
  return { state: s, completed: false, onTrack: r.onTrack };
}

// ───────────────────────────── 동작 측정 ─────────────────────────────

/** 과녁 활성화 후 손이 0.04 이상 움직이기 시작한 순간을 "손 출발"로 본다 */
export const MOVE_START_THRESHOLD = 0.04;

export interface MovementSample {
  t: number; // ms
  p: Vec2;
}

export interface MovementMetrics {
  /** 반응시간: 과녁 활성화 → 손 출발 (시각 처리·운동 계획) */
  reactionMs: number | null;
  /** 움직임시간: 손 출발 → 명중 (운동 실행) */
  movementMs: number | null;
  /** 경로 효율: 직선거리 ÷ 실제 이동거리 (1 = 완전히 곧게) */
  pathEfficiency: number | null;
  /** 과녁을 지나친 정도 (반지름 대비) */
  overshootRatio: number;
  overshoot: boolean;
}

export function computeMovementMetrics(params: {
  samples: MovementSample[];
  activationMs: number;
  hitMs: number;
  target: Vec2;
  radius: number;
}): MovementMetrics {
  const { samples, activationMs, hitMs, target, radius } = params;
  const empty: MovementMetrics = {
    reactionMs: null,
    movementMs: null,
    pathEfficiency: null,
    overshootRatio: 0,
    overshoot: false,
  };
  const seq = samples.filter((s) => s.t >= activationMs && s.t <= hitMs);
  if (seq.length < 2) return empty;
  const start = seq[0].p;
  let startIdx = -1;
  for (let i = 1; i < seq.length; i++) {
    if (Math.hypot(seq[i].p.x - start.x, seq[i].p.y - start.y) >= MOVE_START_THRESHOLD) {
      startIdx = i - 1;
      break;
    }
  }
  if (startIdx < 0) {
    return { ...empty, reactionMs: Math.max(0, hitMs - activationMs), movementMs: 0 };
  }
  const moveStartMs = seq[startIdx].t;
  let pathLen = 0;
  for (let i = startIdx + 1; i < seq.length; i++) {
    pathLen += Math.hypot(seq[i].p.x - seq[i - 1].p.x, seq[i].p.y - seq[i - 1].p.y);
  }
  const startP = seq[startIdx].p;
  const dirX = target.x - startP.x;
  const dirY = target.y - startP.y;
  const directDist = Math.hypot(dirX, dirY);
  // 과녁 가장자리까지 가는 직선이 "필요한 최소 거리"
  const needed = Math.max(0, directDist - radius);
  const pathEfficiency =
    directDist <= radius || pathLen <= 1e-6 ? null : Math.max(0, Math.min(1, needed / pathLen));
  let maxProj = 0;
  if (directDist > 1e-6) {
    const ux = dirX / directDist;
    const uy = dirY / directDist;
    for (let i = startIdx; i < seq.length; i++) {
      const proj = (seq[i].p.x - startP.x) * ux + (seq[i].p.y - startP.y) * uy;
      if (proj > maxProj) maxProj = proj;
    }
  }
  const overshootDist = Math.max(0, maxProj - directDist);
  const overshootRatio = radius > 0 ? overshootDist / radius : 0;
  return {
    reactionMs: Math.max(0, moveStartMs - activationMs),
    movementMs: Math.max(0, hitMs - moveStartMs),
    pathEfficiency: pathEfficiency === null ? null : Number(pathEfficiency.toFixed(3)),
    overshootRatio: Number(overshootRatio.toFixed(3)),
    overshoot: overshootRatio > 0.5,
  };
}

/** 명중 시 과녁 중심에서 떨어진 정도로 등급 */
export function gradeReachHit(distFromCenter: number, radius: number): 'PERFECT' | 'GOOD' {
  return distFromCenter <= radius * 0.45 ? 'PERFECT' : 'GOOD';
}

/** 동작 과정 피드백 (KP) 한 줄 */
export function getKpFeedback(m: MovementMetrics): { text: string; tone: 'great' | 'tip' } {
  if (m.overshoot) return { text: '조금 지나쳤어요. 과녁 앞에서 천천히 멈춰요', tone: 'tip' };
  if (m.pathEfficiency !== null && m.pathEfficiency < 0.6) {
    return { text: '돌아서 갔어요. 과녁을 먼저 보고 곧게 뻗어요', tone: 'tip' };
  }
  if (m.pathEfficiency !== null && m.pathEfficiency >= 0.85) {
    return { text: '곧게 쭉 뻗었어요!', tone: 'great' };
  }
  return { text: '잘했어요!', tone: 'great' };
}

// ───────────────────────────── 자동 난이도 (도전점) ─────────────────────────────

/**
 * 최근 10번 시도의 성공률이 80% 이상이면 한 단계 올리고, 60% 미만이면 내린다.
 * 바뀐 뒤에는 기록을 비워 새 레벨에서 다시 10번을 본다.
 */
export class AutoDifficulty {
  private outcomes: boolean[] = [];
  constructor(
    public windowSize = 10,
    public upAt = 0.8,
    public downBelow = 0.6,
  ) {}

  record(success: boolean, level: number): { level: number; changed: -1 | 0 | 1; rate: number | null } {
    this.outcomes.push(success);
    if (this.outcomes.length < this.windowSize) {
      return { level, changed: 0, rate: null };
    }
    const rate = this.outcomes.filter(Boolean).length / this.outcomes.length;
    this.outcomes = [];
    if (rate >= this.upAt && level < 10) return { level: level + 1, changed: 1, rate };
    if (rate < this.downBelow && level > 1) return { level: level - 1, changed: -1, rate };
    return { level, changed: 0, rate };
  }

  reset() {
    this.outcomes = [];
  }
}

// ───────────────────────────── 피로 감지 ─────────────────────────────

/**
 * 손이 안 보이거나 도달 범위 아래로 처진 상태가 6초 이어지면 블록을 일찍 끝낸다.
 */
export class FatigueMonitor {
  private lowSinceSec: number | null = null;
  constructor(
    public limitSec = 6,
    public lowY = 1.1,
  ) {}

  update(cursor: Vec2 | null, tSec: number): boolean {
    const low = cursor === null || cursor.y > this.lowY;
    if (!low) {
      this.lowSinceSec = null;
      return false;
    }
    if (this.lowSinceSec === null) this.lowSinceSec = tSec;
    return tSec - this.lowSinceSec >= this.limitSec;
  }

  reset() {
    this.lowSinceSec = null;
  }
}

// ───────────────────────────── 기록과 리포트 ─────────────────────────────

export interface HandAttemptRecord {
  kind: HandTaskKind;
  level: number;
  hand: HandSide | 'mouse' | 'both';
  crossMidline: boolean;
  success: boolean;
  grade: 'PERFECT' | 'GOOD' | 'MISS';
  reactionMs: number | null;
  movementMs: number | null;
  pathEfficiency: number | null;
  overshoot: boolean;
  traceAccuracyPct: number | null;
  wrongSelections: number;
  earlyMove: boolean;
  block: number;
  tSec: number;
}

export interface HandSessionSummary {
  id: string;
  timestamp: string;
  profileName: string;
  profileAge: number | null;
  handSetting: HandSetting;
  inputSource: 'camera' | 'mouse';
  attempts: number;
  successes: number;
  accuracyPct: number;
  perfect: number;
  score100: number;
  avgReactionMs: number | null;
  avgMovementMs: number | null;
  avgPathEfficiencyPct: number | null;
  overshootRatePct: number | null;
  traceAccuracyPct: number | null;
  wrongSelections: number;
  earlyMoves: number;
  sameSideAccuracyPct: number | null;
  crossMidlineAccuracyPct: number | null;
  leftAccuracyPct: number | null;
  rightAccuracyPct: number | null;
  byKind: Record<HandTaskKind, { attempts: number; accuracyPct: number | null }>;
  startLevel: number;
  endLevel: number;
  maxLevel: number;
  levelChanges: Array<{ tSec: number; from: number; to: number }>;
  blocksPlanned: number;
  blocksDone: number;
  fatigueStops: number;
  durationSec: number;
  recommendations: string[];
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 100) : null);
const roundOrNull = (v: number | null): number | null => (v === null ? null : Math.round(v));

/**
 * 100점 환산: 성공률 60 + 경로 효율 20 + 움직임 속도 20
 * (움직임시간 400ms 이하 만점 → 2000ms 이상 0점)
 */
export function computeHandScore100(params: {
  accuracy: number;
  pathEfficiency: number | null;
  movementMs: number | null;
}): number {
  const acc = Math.max(0, Math.min(1, params.accuracy)) * 60;
  const eff = (params.pathEfficiency ?? 0.6) * 20;
  const mt = params.movementMs ?? 1500;
  const speed = (1 - (Math.max(400, Math.min(2000, mt)) - 400) / 1600) * 20;
  return Math.max(0, Math.min(100, Math.round(acc + eff + speed)));
}

/** 약한 부분에 맞춘 실물 과제 추천 (일반화 전략) */
export function buildRealWorldRecommendations(s: {
  sameSideAccuracyPct: number | null;
  crossMidlineAccuracyPct: number | null;
  overshootRatePct: number | null;
  avgPathEfficiencyPct: number | null;
  avgReactionMs: number | null;
  traceAccuracyPct: number | null;
  leftAccuracyPct: number | null;
  rightAccuracyPct: number | null;
  earlyMoves: number;
}): string[] {
  const out: string[] = [];
  if (
    s.sameSideAccuracyPct !== null &&
    s.crossMidlineAccuracyPct !== null &&
    s.sameSideAccuracyPct - s.crossMidlineAccuracyPct >= 15
  ) {
    out.push('몸 중앙 넘기: 왼쪽에 둔 블록을 오른손으로 집어 오른쪽 통에 옮기기 10회 (반대 손도)');
  }
  if (s.overshootRatePct !== null && s.overshootRatePct >= 30) {
    out.push('멈춤 조절: 숟가락으로 콩을 컵에 옮겨 담기, 점 위에 스티커 정확히 붙이기');
  }
  if (s.avgPathEfficiencyPct !== null && s.avgPathEfficiencyPct < 70) {
    out.push('곧게 뻗기: 테이블 여러 곳에 놓인 동전·구슬을 한 번에 집어 오기');
  }
  if (s.avgReactionMs !== null && s.avgReactionMs > 700) {
    out.push('시각 반응: 떨어지는 스카프 잡기, 굴러오는 공 멈추기');
  }
  if (s.traceAccuracyPct !== null && s.traceAccuracyPct < 70) {
    out.push('따라 그리기: "따라그리기 시트 인쇄"로 오늘 도형을 연필로 따라 그리기');
  }
  if (
    s.leftAccuracyPct !== null &&
    s.rightAccuracyPct !== null &&
    Math.abs(s.leftAccuracyPct - s.rightAccuracyPct) >= 15
  ) {
    const weak = s.leftAccuracyPct < s.rightAccuracyPct ? '왼손' : '오른손';
    out.push(`${weak} 집중: ${weak}으로 풍선 치기, 페그보드 꽂기 5분`);
  }
  if (s.earlyMoves >= 3) {
    out.push('보고 → 뻗기: "봤다!"라고 말한 다음 손을 출발하는 공 받기 놀이');
  }
  if (out.length === 0) {
    out.push('공 주고받기 5분, 풍선 배구 5분으로 오늘 연습한 동작을 실제 물건으로 이어 가기');
  }
  return out.slice(0, 4);
}

export function buildHandSessionSummary(params: {
  records: HandAttemptRecord[];
  profileName: string;
  profileAge: number | null;
  handSetting: HandSetting;
  inputSource: 'camera' | 'mouse';
  startLevel: number;
  endLevel: number;
  levelChanges: Array<{ tSec: number; from: number; to: number }>;
  blocksPlanned: number;
  blocksDone: number;
  fatigueStops: number;
  durationSec: number;
  now?: Date;
}): HandSessionSummary {
  const r = params.records;
  const successes = r.filter((a) => a.success).length;
  const rts = r.map((a) => a.reactionMs).filter((v): v is number => v !== null);
  const mts = r.map((a) => a.movementMs).filter((v): v is number => v !== null);
  const effs = r.map((a) => a.pathEfficiency).filter((v): v is number => v !== null);
  const traces = r.map((a) => a.traceAccuracyPct).filter((v): v is number => v !== null);
  const reachLike = r.filter((a) => a.kind !== 'trace' && a.success);
  const sameSide = r.filter((a) => !a.crossMidline && a.kind !== 'bimanual');
  const cross = r.filter((a) => a.crossMidline);
  const left = r.filter((a) => a.hand === 'L');
  const right = r.filter((a) => a.hand === 'R');
  const kinds: HandTaskKind[] = ['reach', 'trace', 'depth', 'choice', 'bimanual'];
  const byKind = Object.fromEntries(
    kinds.map((k) => {
      const ks = r.filter((a) => a.kind === k);
      return [k, { attempts: ks.length, accuracyPct: pct(ks.filter((a) => a.success).length, ks.length) }];
    }),
  ) as HandSessionSummary['byKind'];

  const accuracy = r.length ? successes / r.length : 0;
  const avgEff = mean(effs);
  const avgMt = mean(mts);
  const base = {
    sameSideAccuracyPct: pct(sameSide.filter((a) => a.success).length, sameSide.length),
    crossMidlineAccuracyPct: pct(cross.filter((a) => a.success).length, cross.length),
    overshootRatePct: pct(reachLike.filter((a) => a.overshoot).length, reachLike.length),
    avgPathEfficiencyPct: avgEff === null ? null : Math.round(avgEff * 100),
    avgReactionMs: roundOrNull(mean(rts)),
    traceAccuracyPct: roundOrNull(mean(traces)),
    leftAccuracyPct: pct(left.filter((a) => a.success).length, left.length),
    rightAccuracyPct: pct(right.filter((a) => a.success).length, right.length),
    earlyMoves: r.filter((a) => a.earlyMove).length,
  };
  const levels = [params.startLevel, params.endLevel, ...params.levelChanges.map((c) => c.to)];
  const now = params.now ?? new Date();
  return {
    id: `hand-${now.getTime()}`,
    timestamp: now.toLocaleString('ko-KR'),
    profileName: params.profileName,
    profileAge: params.profileAge,
    handSetting: params.handSetting,
    inputSource: params.inputSource,
    attempts: r.length,
    successes,
    accuracyPct: pct(successes, r.length) ?? 0,
    perfect: r.filter((a) => a.grade === 'PERFECT').length,
    score100: computeHandScore100({ accuracy, pathEfficiency: avgEff, movementMs: avgMt }),
    avgMovementMs: roundOrNull(avgMt),
    wrongSelections: r.reduce((s, a) => s + a.wrongSelections, 0),
    byKind,
    startLevel: params.startLevel,
    endLevel: params.endLevel,
    maxLevel: Math.max(...levels),
    levelChanges: params.levelChanges,
    blocksPlanned: params.blocksPlanned,
    blocksDone: params.blocksDone,
    fatigueStops: params.fatigueStops,
    durationSec: Math.round(params.durationSec),
    ...base,
    recommendations: buildRealWorldRecommendations(base),
  };
}

const fmt = (v: number | null, unit = '') => (v === null ? '-' : `${v}${unit}`);

export function handSummaryToText(s: HandSessionSummary): string {
  return [
    `[EYE HAND MISSION · 손 치료 모드 결과]`,
    `일시: ${s.timestamp} | 아동: ${s.profileName || '-'}${s.profileAge ? ` (${s.profileAge}세)` : ''} | 입력: ${s.inputSource === 'camera' ? '웹캠 손 추적' : '마우스(체험)'} | 손: ${s.handSetting === 'both' ? '양손' : s.handSetting === 'L' ? '왼손' : '오른손'}`,
    `점수: ${s.score100}/100 | 성공률: ${s.accuracyPct}% (${s.successes}/${s.attempts}) | PERFECT ${s.perfect}`,
    `반응시간(보고→출발): ${fmt(s.avgReactionMs, 'ms')} | 움직임시간(출발→명중): ${fmt(s.avgMovementMs, 'ms')}`,
    `경로 효율: ${fmt(s.avgPathEfficiencyPct, '%')} | 지나침 비율: ${fmt(s.overshootRatePct, '%')} | 따라그리기 정확도: ${fmt(s.traceAccuracyPct, '%')}`,
    `같은 쪽: ${fmt(s.sameSideAccuracyPct, '%')} | 중앙선 넘기: ${fmt(s.crossMidlineAccuracyPct, '%')} | 왼손: ${fmt(s.leftAccuracyPct, '%')} | 오른손: ${fmt(s.rightAccuracyPct, '%')}`,
    `레벨: 시작 Lv${s.startLevel} → 끝 Lv${s.endLevel} (최고 Lv${s.maxLevel}) | 블록 ${s.blocksDone}/${s.blocksPlanned} | 피로로 조기 종료 ${s.fatigueStops}회`,
    `실물 과제 추천: ${s.recommendations.join(' / ')}`,
  ].join('\n');
}

export function handSummaryToCsv(s: HandSessionSummary): string {
  const header = [
    'timestamp', 'profile', 'age', 'input', 'hand', 'score100', 'accuracyPct', 'attempts', 'perfect',
    'avgReactionMs', 'avgMovementMs', 'pathEfficiencyPct', 'overshootRatePct', 'traceAccuracyPct',
    'sameSidePct', 'crossMidlinePct', 'leftPct', 'rightPct', 'startLevel', 'endLevel', 'maxLevel',
    'blocksDone', 'fatigueStops', 'durationSec',
  ];
  const row = [
    s.timestamp, s.profileName, s.profileAge ?? '', s.inputSource, s.handSetting, s.score100, s.accuracyPct,
    s.attempts, s.perfect, s.avgReactionMs ?? '', s.avgMovementMs ?? '', s.avgPathEfficiencyPct ?? '',
    s.overshootRatePct ?? '', s.traceAccuracyPct ?? '', s.sameSideAccuracyPct ?? '',
    s.crossMidlineAccuracyPct ?? '', s.leftAccuracyPct ?? '', s.rightAccuracyPct ?? '', s.startLevel,
    s.endLevel, s.maxLevel, s.blocksDone, s.fatigueStops, s.durationSec,
  ].map((v) => {
    const str = String(v);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  });
  return `${header.join(',')}\n${row.join(',')}`;
}

// ───────────────────────────── 아동 프로필·기록 저장 ─────────────────────────────

export interface HandProfile {
  id: string;
  name: string;
  age: number | null;
}

const PROFILES_KEY = 'ehm-hand-profiles-v1';
const HISTORY_KEY = 'ehm-hand-history-v1';
const MAX_HISTORY_PER_PROFILE = 50;

function safeGet(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // 저장소를 못 쓰는 환경(사생활 보호 모드 등)에서는 기록만 생략한다
  }
}

export function loadHandProfiles(): HandProfile[] {
  try {
    const raw = safeGet(PROFILES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((p) => p && typeof p.id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHandProfiles(list: HandProfile[]) {
  safeSet(PROFILES_KEY, JSON.stringify(list));
}

export function loadHandHistory(): Record<string, HandSessionSummary[]> {
  try {
    const raw = safeGet(HISTORY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function appendHandHistory(profileId: string, summary: HandSessionSummary) {
  const all = loadHandHistory();
  const list = Array.isArray(all[profileId]) ? all[profileId] : [];
  list.push(summary);
  all[profileId] = list.slice(-MAX_HISTORY_PER_PROFILE);
  safeSet(HISTORY_KEY, JSON.stringify(all));
}
