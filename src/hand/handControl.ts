/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 3D 게임 손 조작 규칙 (순수 로직, node:test로 검증).
 * - 검지 끝 → 화면 조준점(NDC)
 * - 조준점이 화면 좌우 가장자리에 있으면 시점이 그쪽으로 돈다 (제자리, 좌우 ±90°)
 * - 과녁에 0.5초 대고 있으면 명중
 * - 게임 전 손 인식 테스트: 화면의 점 5개를 0.5초씩 짚으면 통과 + 팔 뻗기 범위 보정
 */

import { computeReachCalibration, imageToReach, type ReachCalibration, type Vec2 } from './handRules';

/** 과녁에 손을 대고 있어야 하는 시간 */
export const HAND_DWELL_SEC = 0.5;
/** 명중 뒤 다음 발사까지 쉬는 시간 (같은 과녁을 연달아 쏘지 않게) */
export const HAND_FIRE_COOLDOWN_SEC = 0.35;
/** 손 인식이 이 시간보다 짧게 끊기면 머무르기 진행을 유지한다 (한두 프레임 놓침 대비) */
export const HAND_LOST_GRACE_SEC = 0.3;
/** 이 값보다 바깥(|x|)이 가장자리 회전 구역 */
export const HAND_EDGE_START = 0.78;
/** 가장자리 끝에 손을 두었을 때 초당 회전 각도 */
export const HAND_EDGE_MAX_DEG_PER_SEC = 75;
/** 손 조작 게임의 단계 수 */
export const HAND_LEVEL_COUNT = 5;

/** 손가락(거울 화면 이미지 좌표) → 화면 조준점 NDC (-1~1, 위쪽이 +) */
export function handTipToNdc(tip: Vec2, cal: ReachCalibration): Vec2 {
  const r = imageToReach(tip, cal);
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return { x: clamp(r.x), y: clamp(-r.y) };
}

/**
 * 가장자리 회전 속도 (라디안/초). 왼쪽 가장자리 → 양수(왼쪽으로 돎), 오른쪽 → 음수.
 * 가장자리로 깊이 들어갈수록 빨라진다.
 */
export function edgeYawRate(ndcX: number): number {
  const ax = Math.abs(ndcX);
  if (ax <= HAND_EDGE_START) return 0;
  const depth = Math.min(1, (ax - HAND_EDGE_START) / (1 - HAND_EDGE_START));
  const rate = ((HAND_EDGE_MAX_DEG_PER_SEC * Math.PI) / 180) * depth * depth;
  return ndcX < 0 ? rate : -rate;
}

/** 지금 조준점이 가장자리 회전 구역인지 ('left' | 'right' | null) */
export function edgeZone(ndcX: number): 'left' | 'right' | null {
  if (ndcX <= -HAND_EDGE_START) return 'left';
  if (ndcX >= HAND_EDGE_START) return 'right';
  return null;
}

/** 과녁 위에 머무른 시간을 재고, 0.5초가 되면 한 번 발사한다 */
export class DwellFire {
  private heldSec = 0;
  private cooldownSec = 0;
  private lostSec = 0;
  constructor(
    public dwellSec = HAND_DWELL_SEC,
    public cooldown = HAND_FIRE_COOLDOWN_SEC,
  ) {}

  /**
   * onTarget: 조준점이 과녁 위인지. null = 이번 프레임에 손이 안 보임(잠깐이면 진행 유지).
   * 발사해야 하면 true
   */
  update(onTarget: boolean | null, dtSec: number): boolean {
    if (this.cooldownSec > 0) {
      this.cooldownSec = Math.max(0, this.cooldownSec - dtSec);
      this.heldSec = 0;
      return false;
    }
    if (onTarget === null) {
      this.lostSec += dtSec;
      if (this.lostSec > HAND_LOST_GRACE_SEC) this.heldSec = 0;
      return false;
    }
    this.lostSec = 0;
    if (!onTarget) {
      this.heldSec = 0;
      return false;
    }
    this.heldSec += dtSec;
    if (this.heldSec >= this.dwellSec) {
      this.heldSec = 0;
      this.cooldownSec = this.cooldown;
      return true;
    }
    return false;
  }

  /** 0~1 진행률 (커서 링 표시용) */
  get progress(): number {
    return Math.min(1, this.heldSec / this.dwellSec);
  }

  reset() {
    this.heldSec = 0;
    this.cooldownSec = 0;
    this.lostSec = 0;
  }
}

// ───────────────────────────── 손 인식 테스트 ─────────────────────────────

export interface HandTestPoint {
  id: string;
  label: string;
  /** 거울 화면 이미지 좌표 (0~1) */
  pos: Vec2;
}

/** 가운데 → 왼쪽 → 오른쪽 → 위 → 아래. 좌우 점은 가장자리 회전에 쓸 만큼 멀리 */
export const HAND_TEST_POINTS: HandTestPoint[] = [
  { id: 'center', label: '가운데', pos: { x: 0.5, y: 0.5 } },
  { id: 'left', label: '왼쪽', pos: { x: 0.18, y: 0.5 } },
  { id: 'right', label: '오른쪽', pos: { x: 0.82, y: 0.5 } },
  { id: 'up', label: '위', pos: { x: 0.5, y: 0.2 } },
  { id: 'down', label: '아래', pos: { x: 0.5, y: 0.78 } },
];

/** 테스트 점의 판정 반지름 (이미지 좌표) */
export const HAND_TEST_RADIUS = 0.075;

export interface HandTestState {
  /** 지금 짚어야 할 점 번호 (모두 끝나면 HAND_TEST_POINTS.length) */
  index: number;
  heldSec: number;
  /** 손이 안 보인 시간 (잠깐이면 진행 유지) */
  lostSec: number;
  samples: Vec2[];
}

export function newHandTestState(): HandTestState {
  return { index: 0, heldSec: 0, lostSec: 0, samples: [] };
}

/**
 * 테스트 한 프레임. 손가락이 지금 점 위에 0.5초 머무르면 다음 점으로 넘어간다.
 * 손가락 위치는 팔 뻗기 범위 보정용으로 모아 둔다.
 */
export function stepHandTest(state: HandTestState, tip: Vec2 | null, dtSec: number): {
  state: HandTestState;
  advanced: boolean;
  passed: boolean;
} {
  const s: HandTestState = { ...state, samples: state.samples };
  if (tip) s.samples = [...state.samples.slice(-600), { x: tip.x, y: tip.y }];
  if (s.index >= HAND_TEST_POINTS.length) return { state: s, advanced: false, passed: true };
  const target = HAND_TEST_POINTS[s.index].pos;
  if (tip === null) {
    s.lostSec += dtSec;
    if (s.lostSec > HAND_LOST_GRACE_SEC) s.heldSec = 0;
    return { state: s, advanced: false, passed: false };
  }
  s.lostSec = 0;
  const on = Math.hypot(tip.x - target.x, tip.y - target.y) <= HAND_TEST_RADIUS;
  s.heldSec = on ? s.heldSec + dtSec : 0;
  if (s.heldSec >= HAND_DWELL_SEC) {
    s.index += 1;
    s.heldSec = 0;
    return { state: s, advanced: true, passed: s.index >= HAND_TEST_POINTS.length };
  }
  return { state: s, advanced: false, passed: false };
}

/** 테스트 동안 모은 손가락 위치로 팔 뻗기 범위 보정 */
export function calibrationFromTest(state: HandTestState): ReachCalibration {
  return computeReachCalibration(state.samples, 0.5);
}

// ───────────────────────────── 활 쏘기 손동작 ─────────────────────────────

/** 엄지·검지 끝 거리 ÷ 손 크기가 이보다 작으면 "붙임" */
export const PINCH_CLOSE_RATIO = 0.35;
/** 당기는 중에는 이보다 벌어져야 "뗌" (흔들림으로 잘못 쏘지 않게 여유를 둔다) */
export const PINCH_OPEN_RATIO = 0.5;
/** 주먹으로 볼 접힌 손가락 수 (중지·약지·새끼 중) */
export const FIST_MIN_CURLED = 2;
/** 시위를 끝까지 당기는 데 걸리는 시간 */
export const DRAW_FULL_SEC = 1.2;
/** 이보다 적게 당기고 떼면 쏘지 않고 시위만 풀린다 */
export const MIN_RELEASE_DRAW = 0.15;

export interface BowGestureInput {
  /** 엄지·검지 거리 ÷ 손 크기. null = 손이 안 보임 */
  pinchRatio: number | null;
  /** 접힌 손가락 수 */
  curled: number;
}

export interface BowGestureResult {
  /** 지금 당긴 정도 0~1 */
  draw: number;
  drawing: boolean;
  /** 이번 프레임에 화살을 쐈는지, 그때 당긴 정도 */
  fired: boolean;
  fireDraw: number;
}

/**
 * 활 쏘기 손동작:
 * - 엄지·검지를 붙이고 나머지 손가락을 주먹 쥐면 당기기 시작
 * - 붙이고 있는 동안 시위가 점점 당겨져 1.2초에 최대
 * - 엄지·검지를 떼면 그때 당긴 만큼으로 발사 (너무 조금 당겼으면 취소)
 * - 손이 0.3초 넘게 안 보이면 취소
 */
export class BowGesture {
  private drawing = false;
  private heldSec = 0;
  private lostSec = 0;

  update(input: BowGestureInput, dtSec: number): BowGestureResult {
    const idle = (fired = false, fireDraw = 0): BowGestureResult => ({
      draw: 0,
      drawing: false,
      fired,
      fireDraw,
    });
    if (input.pinchRatio === null) {
      if (!this.drawing) return idle();
      this.lostSec += dtSec;
      if (this.lostSec > HAND_LOST_GRACE_SEC) {
        this.reset();
        return idle();
      }
      return { draw: this.draw, drawing: true, fired: false, fireDraw: 0 };
    }
    this.lostSec = 0;
    if (!this.drawing) {
      if (input.pinchRatio < PINCH_CLOSE_RATIO && input.curled >= FIST_MIN_CURLED) {
        this.drawing = true;
        this.heldSec = 0;
      }
      return { draw: this.draw, drawing: this.drawing, fired: false, fireDraw: 0 };
    }
    if (input.pinchRatio > PINCH_OPEN_RATIO) {
      const d = this.draw;
      this.reset();
      return d >= MIN_RELEASE_DRAW ? idle(true, d) : idle();
    }
    this.heldSec += dtSec;
    return { draw: this.draw, drawing: true, fired: false, fireDraw: 0 };
  }

  get draw(): number {
    return Math.min(1, this.heldSec / DRAW_FULL_SEC);
  }

  reset() {
    this.drawing = false;
    this.heldSec = 0;
    this.lostSec = 0;
  }
}

// ───────────────────────────── 화살 탄도 (5단계) ─────────────────────────────

/** 이 단계부터 당긴 정도에 따라 화살 속도가 바뀌고 중력으로 떨어진다 */
export const BALLISTIC_LEVEL = 5;
/** 1~4단계 화살 속도 (곧게, 낙차 없이) */
export const STRAIGHT_ARROW_SPEED = 55;
/** 5단계: 조금 당기면 느리고(많이 떨어짐), 끝까지 당기면 빠르다 */
export const BALLISTIC_MIN_SPEED = 16;
export const BALLISTIC_MAX_SPEED = 60;
export const ARROW_GRAVITY = 8;

export function isBallisticLevel(level: number): boolean {
  return level >= BALLISTIC_LEVEL;
}

/** 쏠 때 화살 속도 (m/s). 1~4단계는 당긴 정도와 상관없이 같다 */
export function arrowLaunchSpeed(level: number, draw: number): number {
  if (!isBallisticLevel(level)) return STRAIGHT_ARROW_SPEED;
  const d = Math.max(0, Math.min(1, draw));
  return BALLISTIC_MIN_SPEED + (BALLISTIC_MAX_SPEED - BALLISTIC_MIN_SPEED) * d;
}

/** 탄도 위치: 시작점 + 방향×속도×t, 아래로 ½gt² */
export function ballisticPosition(
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  speed: number,
  gravity: number,
  t: number,
): { x: number; y: number; z: number } {
  return {
    x: origin.x + dir.x * speed * t,
    y: origin.y + dir.y * speed * t - 0.5 * gravity * t * t,
    z: origin.z + dir.z * speed * t,
  };
}
