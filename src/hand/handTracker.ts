/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 웹캠 손 추적 (MediaPipe Hands, @mediapipe/tasks-vision).
 * 카메라 영상은 화면에 그리지 않고, 손 관절 좌표만 넘긴다 (사생활 보호).
 * 좌표는 거울 화면 기준(아동이 오른손을 오른쪽으로 뻗으면 x가 커짐)으로 뒤집어 준다.
 */

import type { HandSide, Vec2 } from './handRules';
import { evaluateBowPose, type BowPose } from './handControl';

const TASKS_VISION_VERSION = '1.2.3';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export interface TrackedHand {
  side: HandSide;
  /** 검지 끝 (거울 화면 이미지 좌표 0~1) */
  tip: Vec2;
  /** 손바닥 중심 (손목·검지/중지/약지/새끼 뿌리 평균) — 활 조준점. 손가락을 떼도 덜 흔들린다 */
  aim: Vec2;
  /** 21개 관절(3D)로 판정한 활 쏘기 자세: 엄지·검지 맞닿음, 손가락별 접힘/폄 */
  pose: BowPose;
  /** 손목–중지 뿌리 거리 (이미지 좌표). 카메라에 가까울수록 커짐 → 뻗기 감지 */
  size: number;
  /** 엄지 끝–검지 끝 거리 → 집기 감지 */
  pinchDist: number;
  /** 21개 관절 (거울 화면 이미지 좌표) — 가상 손 그리기용 */
  landmarks: Vec2[];
  score: number;
}

export interface HandFrame {
  tMs: number;
  hands: TrackedHand[];
}

export type TrackerStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'running' }
  | { kind: 'error'; message: string };

/** 손 관절 연결선 (가상 손 그리기) */
export const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

type Landmarker = {
  detectForVideo: (
    video: HTMLVideoElement,
    ts: number,
  ) => {
    landmarks: Array<Array<{ x: number; y: number; z?: number }>>;
    handedness?: Array<Array<{ categoryName: string; score: number }>>;
    handednesses?: Array<Array<{ categoryName: string; score: number }>>;
  };
  close: () => void;
};

export class HandTracker {
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private landmarker: Landmarker | null = null;
  private rafId = 0;
  private lastVideoTime = -1;
  private stopped = false;
  /** 왼손/오른손 판별이 반대로 나오는 카메라용 */
  public swapHandedness = false;

  constructor(
    private onFrame: (frame: HandFrame) => void,
    private onStatus: (s: TrackerStatus) => void,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onStatus({ kind: 'error', message: '이 브라우저는 웹캠을 쓸 수 없어요. 크롬에서 열어 주세요.' });
      return;
    }
    try {
      this.onStatus({ kind: 'loading', message: '카메라를 켜는 중…' });
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      if (this.stopped) return this.stop();
      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.srcObject = this.stream;
      await video.play();
      this.video = video;

      this.onStatus({ kind: 'loading', message: '손 인식 모델을 불러오는 중… (처음 한 번은 10초 정도 걸려요)' });
      const vision = await import('@mediapipe/tasks-vision');
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
      const create = (delegate: 'GPU' | 'CPU') =>
        vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO',
          // 게임은 가장 크게 보이는 손 하나만 쓰므로 1개만 찾는다 (인식 계산이 가벼워진다)
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      let lm: unknown;
      try {
        lm = await create('GPU');
      } catch {
        lm = await create('CPU');
      }
      if (this.stopped) {
        (lm as Landmarker).close();
        return this.stop();
      }
      this.landmarker = lm as Landmarker;
      this.onStatus({ kind: 'running' });
      this.loop();
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      const message =
        name === 'NotAllowedError'
          ? '카메라 사용이 거부됐어요. 주소창의 카메라 아이콘에서 허용해 주세요.'
          : name === 'NotFoundError'
            ? '연결된 웹캠을 찾지 못했어요.'
            : `손 추적을 시작하지 못했어요 (${name || (err as Error)?.message || '알 수 없는 오류'}).`;
      this.onStatus({ kind: 'error', message });
      this.stop();
    }
  }

  private loop = () => {
    if (this.stopped || !this.video || !this.landmarker) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      const now = performance.now();
      try {
        const res = this.landmarker.detectForVideo(v, now);
        this.onFrame({ tMs: now, hands: this.toHands(res) });
      } catch {
        // 한 프레임 실패는 무시하고 다음 프레임을 본다
      }
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private toHands(res: ReturnType<Landmarker['detectForVideo']>): TrackedHand[] {
    const out: TrackedHand[] = [];
    const handed = res.handedness ?? res.handednesses ?? [];
    res.landmarks.forEach((raw, i) => {
      if (!raw || raw.length < 21) return;
      // 거울 화면: x를 뒤집는다
      const lm = raw.map((p) => ({ x: 1 - p.x, y: p.y }));
      // 자세 판정은 깊이(z)까지 쓴다: 카메라 쪽으로 말린 손가락도 접힘으로 잡힌다
      const lm3 = raw.map((p) => ({ x: 1 - p.x, y: p.y, z: (p as { z?: number }).z ?? 0 }));
      const cat = handed[i]?.[0];
      // MediaPipe는 원본(뒤집지 않은) 영상 기준으로 아동의 실제 손을 알려 준다
      let side: HandSide = cat?.categoryName === 'Left' ? 'L' : 'R';
      if (this.swapHandedness) side = side === 'L' ? 'R' : 'L';
      const dist = (a: number, b: number) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
      const palmIdx = [0, 5, 9, 13, 17];
      const aim = {
        x: palmIdx.reduce((acc, k) => acc + lm[k].x, 0) / palmIdx.length,
        y: palmIdx.reduce((acc, k) => acc + lm[k].y, 0) / palmIdx.length,
      };
      out.push({
        side,
        tip: lm[8],
        aim,
        pose: evaluateBowPose(lm3),
        size: dist(0, 9),
        pinchDist: dist(4, 8),
        landmarks: lm,
        score: cat?.score ?? 0.5,
      });
    });
    return out;
  }

  stop() {
    this.stopped = true;
    cancelAnimationFrame(this.rafId);
    try {
      this.landmarker?.close();
    } catch {
      // ignore
    }
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
  }
}
