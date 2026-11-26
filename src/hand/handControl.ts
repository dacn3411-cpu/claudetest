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

/** 손 관절 (거울 화면 이미지 좌표, z는 MediaPipe 상대 깊이) */
export interface Landmark3 {
  x: number;
  y: number;
  z: number;
}

/** 엄지 끝–검지 끝 거리 ÷ 손 크기가 이보다 작으면 "맞닿음" */
export const PINCH_TOUCH_RATIO = 0.3;
/** 당기는 중에는 이 정도까지 벌어져도 자세가 유지된 것으로 본다 */
export const PINCH_HOLD_RATIO = 0.5;
/**
 * 발사(손가락을 모두 폄): 엄지–검지가 맞닿은 거리보다 조금만 떨어져 있으면 된다.
 * 실제 편 손 사진에서 엄지가 검지 옆에 붙어 0.43 정도가 나와서, 맞닿음(0.3)보다 약간 큰 값으로 둔다.
 */
export const PINCH_OPEN_RATIO = 0.36;
/** 이 각도(°)보다 많이 꺾이면 접힌 손가락 */
export const CURL_BEND_DEG = 70;
/** 이 각도(°)보다 덜 꺾이면 편 손가락 */
export const EXTEND_BEND_DEG = 40;
/** 준비 자세를 이만큼 유지해야 당기기 시작 (잠깐 스친 모양은 무시) */
export const POSE_ARM_SEC = 0.12;
/** 당기는 중 자세가 풀린 채 이 시간이 지나면 (손을 펴지 않았으면) 취소 */
export const POSE_BREAK_SEC = 0.5;
/** 시위를 끝까지 당기는 데 걸리는 시간 */
export const DRAW_FULL_SEC = 1.2;
/** 이보다 적게 당기고 펴면 쏘지 않고 시위만 풀린다 */
export const MIN_RELEASE_DRAW = 0.15;

const FINGERS = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
} as const;

export interface BowPose {
  /** 엄지 끝–검지 끝 거리 ÷ 손 크기(손목–중지 뿌리) */
  pinchRatio: number;
  thumbIndexTouch: boolean;
  /** 중지·약지·새끼 접힘 */
  curled: { middle: boolean; ring: boolean; pinky: boolean };
  curledCount: number;
  /** 검지·중지·약지·새끼 폄 */
  extendedCount: number;
  /** 활 당기는 자세: 엄지·검지 맞닿음 + 중지·약지·새끼 모두 접힘 */
  drawPose: boolean;
  /** 손가락을 모두 폄: 네 손가락 중 3개 이상 펴지고 엄지·검지가 떨어짐 */
  openHand: boolean;
}

const d3 = (a: Landmark3, b: Landmark3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** 둘째 마디(PIP)에서 꺾인 각도: 0° = 곧게 폄, 180° = 완전히 접힘 */
function pipBendDeg(lm: Landmark3[], mcp: number, pip: number, tip: number): number {
  const v1 = { x: lm[pip].x - lm[mcp].x, y: lm[pip].y - lm[mcp].y, z: lm[pip].z - lm[mcp].z };
  const v2 = { x: lm[tip].x - lm[pip].x, y: lm[tip].y - lm[pip].y, z: lm[tip].z - lm[pip].z };
  const l1 = Math.hypot(v1.x, v1.y, v1.z) || 1e-6;
  const l2 = Math.hypot(v2.x, v2.y, v2.z) || 1e-6;
  const cos = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (l1 * l2);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * 21개 손 관절로 활 쏘기 자세를 판정한다.
 * - 접힘: 마디가 70° 넘게 꺾였거나, 손가락 끝이 둘째 마디보다 손목에 가까움(손바닥 쪽으로 말림)
 * - 폄: 마디가 40° 미만으로 곧고, 끝이 둘째 마디보다 손목에서 멂
 */
export function evaluateBowPose(lm: Landmark3[]): BowPose {
  const size = d3(lm[0], lm[9]) || 1e-6;
  const pinchRatio = d3(lm[4], lm[8]) / size;
  const isCurled = ([mcp, pip, , tip]: readonly number[]) =>
    pipBendDeg(lm, mcp, pip, tip) > CURL_BEND_DEG || d3(lm[tip], lm[0]) < d3(lm[pip], lm[0]);
  const isExtended = ([mcp, pip, , tip]: readonly number[]) =>
    pipBendDeg(lm, mcp, pip, tip) < EXTEND_BEND_DEG && d3(lm[tip], lm[0]) > d3(lm[pip], lm[0]);
  const curled = {
    middle: isCurled(FINGERS.middle),
    ring: isCurled(FINGERS.ring),
    pinky: isCurled(FINGERS.pinky),
  };
  const curledCount = Number(curled.middle) + Number(curled.ring) + Number(curled.pinky);
  const extendedCount = [FINGERS.index, FINGERS.middle, FINGERS.ring, FINGERS.pinky].filter(isExtended).length;
  const thumbIndexTouch = pinchRatio < PINCH_TOUCH_RATIO;
  return {
    pinchRatio,
    thumbIndexTouch,
    curled,
    curledCount,
    extendedCount,
    drawPose: thumbIndexTouch && curledCount === 3,
    openHand: extendedCount >= 3 && pinchRatio > PINCH_OPEN_RATIO,
  };
}

export type BowGestureState = 'idle' | 'arming' | 'drawing' | 'hold';

export interface BowGestureResult {
  state: BowGestureState;
  /** 지금 당긴 정도 0~1 */
  draw: number;
  drawing: boolean;
  /** 이번 프레임에 화살을 쐈는지, 그때 당긴 정도 */
  fired: boolean;
  fireDraw: number;
}

/**
 * 활 쏘기 손동작 (손가락·손바닥 21개 관절로 판정):
 * - 준비: 엄지·검지 끝이 맞닿고 중지·약지·새끼가 모두 접힌 자세를 0.12초 유지 → 당기기 시작
 * - 당기기: 자세를 유지하는 동안(약간 흐트러져도 엄지·검지가 가깝고 두 손가락 이상 접혀 있으면) 시위가 당겨져 1.2초에 최대
 * - 발사: 손가락을 모두 펴면 그때 당긴 만큼으로 발사 (너무 조금 당겼으면 취소)
 * - 자세가 풀렸는데 손을 펴지 않고 0.5초가 지나면 취소. 손이 0.3초 넘게 안 보여도 취소
 */
export class BowGesture {
  private state: BowGestureState = 'idle';
  private armSec = 0;
  private heldSec = 0;
  private breakSec = 0;
  private lostSec = 0;

  update(pose: BowPose | null, dtSec: number): BowGestureResult {
    const out = (fired = false, fireDraw = 0): BowGestureResult => ({
      state: this.state,
      draw: this.draw,
      drawing: this.state === 'drawing' || this.state === 'hold',
      fired,
      fireDraw,
    });
    if (pose === null) {
      if (this.state === 'drawing' || this.state === 'hold') {
        this.lostSec += dtSec;
        if (this.lostSec > HAND_LOST_GRACE_SEC) this.reset();
      } else {
        this.reset();
      }
      return out();
    }
    this.lostSec = 0;

    if (this.state === 'idle' || this.state === 'arming') {
      if (pose.drawPose) {
        this.state = 'arming';
        this.armSec += dtSec;
        if (this.armSec >= POSE_ARM_SEC) {
          this.state = 'drawing';
          this.heldSec = 0;
          this.breakSec = 0;
        }
      } else {
        this.state = 'idle';
        this.armSec = 0;
      }
      return out();
    }

    // drawing / hold
    if (pose.openHand) {
      const d = this.draw;
      this.reset();
      return d >= MIN_RELEASE_DRAW ? out(true, d) : out();
    }
    const holding = pose.pinchRatio < PINCH_HOLD_RATIO && pose.curledCount >= 2;
    if (holding) {
      this.state = 'drawing';
      this.breakSec = 0;
      this.heldSec += dtSec;
    } else {
      this.state = 'hold';
      this.breakSec += dtSec;
      if (this.breakSec > POSE_BREAK_SEC) this.reset();
    }
    return out();
  }

  get draw(): number {
    return Math.min(1, this.heldSec / DRAW_FULL_SEC);
  }

  reset() {
    this.state = 'idle';
    this.armSec = 0;
    this.heldSec = 0;
    this.breakSec = 0;
    this.lostSec = 0;
  }
}

/** 화면에 보여 줄 한 줄 안내 */
export function bowPoseHint(pose: BowPose | null, state: BowGestureState): string {
  if (!pose) return '손이 안 보여요';
  if (state === 'drawing') return '당기는 중 · 손가락을 모두 펴면 발사';
  if (state === 'hold') return '손가락을 모두 펴면 발사 · 다시 쥐면 계속 당겨요';
  const fingers = ['중지', '약지', '새끼'].filter((_, i) => ![pose.curled.middle, pose.curled.ring, pose.curled.pinky][i]);
  const need: string[] = [];
  if (!pose.thumbIndexTouch) need.push('엄지·검지 끝을 붙여요');
  if (fingers.length) need.push(`${fingers.join('·')}를 접어 주먹`);
  return need.length ? need.join(' · ') : '좋아요, 그대로!';
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
