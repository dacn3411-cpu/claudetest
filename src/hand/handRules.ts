/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 손 조작 공통 수학: 손가락 떨림 보정(One Euro Filter)과 팔 뻗기 범위 보정.
 * React·MediaPipe에 의존하지 않아 node:test로 검증할 수 있다.
 *
 * 좌표계 "도달 공간(reach space)":
 *   x: -1(아동의 왼쪽 최대 도달) ~ 0(몸 중앙선) ~ +1(오른쪽 최대 도달)
 *   y: -1(위쪽 최대 도달) ~ +1(아래쪽 최대 도달)
 */

export type HandSide = 'L' | 'R';

export interface Vec2 {
  x: number;
  y: number;
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
