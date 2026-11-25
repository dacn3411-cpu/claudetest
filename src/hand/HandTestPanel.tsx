/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 메인 메뉴의 손 인식 테스트: 카메라를 켜고 화면의 점 5개를 검지로 0.5초씩 짚으면 통과.
 * 통과하면 그동안 모은 손가락 위치로 팔 뻗기 범위를 보정하고, 게임 시작 버튼이 켜진다.
 * 카메라 영상은 보여 주지 않고 가상 손(관절 선)만 그린다.
 */

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  HAND_DWELL_SEC,
  HAND_TEST_POINTS,
  HAND_TEST_RADIUS,
  calibrationFromTest,
  newHandTestState,
  stepHandTest,
  type HandTestState,
} from './handControl';
import type { ReachCalibration } from './handRules';
import { HAND_CONNECTIONS, type HandFrame, type TrackedHand, type TrackerStatus } from './handTracker';

interface Props {
  frameRef: MutableRefObject<HandFrame | null>;
  status: TrackerStatus;
  passed: boolean;
  onStartCamera: () => void;
  onPassed: (cal: ReachCalibration) => void;
  onRetest: () => void;
}

/** 여러 손이 보이면 가장 크게(가깝게) 보이는 손 */
export function primaryHand(frame: HandFrame | null, maxAgeMs = 400): TrackedHand | null {
  if (!frame || performance.now() - frame.tMs > maxAgeMs || frame.hands.length === 0) return null;
  return frame.hands.reduce((a, b) => (b.size > a.size ? b : a));
}

export default function HandTestPanel({ frameRef, status, passed, onStartCamera, onPassed, onRetest }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const testRef = useRef<HandTestState>(newHandTestState());
  const passedRef = useRef(passed);
  passedRef.current = passed;
  const onPassedRef = useRef(onPassed);
  onPassedRef.current = onPassed;
  const [step, setStep] = useState(0);
  const [handSeen, setHandSeen] = useState(false);

  // 다시 테스트할 때 처음부터
  useEffect(() => {
    if (!passed) {
      testRef.current = newHandTestState();
      setStep(0);
    }
  }, [passed]);

  useEffect(() => {
    if (status.kind !== 'running') return;
    let raf = 0;
    let last = performance.now();
    let lastSeen = false;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      // 느린 PC(낮은 프레임)에서도 0.5초를 실제 시간대로 세도록 한 프레임 상한은 0.25초
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const hand = primaryHand(frameRef.current);
      if (Boolean(hand) !== lastSeen) {
        lastSeen = Boolean(hand);
        setHandSeen(lastSeen);
      }
      if (!passedRef.current) {
        const r = stepHandTest(testRef.current, hand ? hand.tip : null, dt);
        testRef.current = r.state;
        if (r.advanced) setStep(r.state.index);
        if (r.passed) onPassedRef.current(calibrationFromTest(r.state));
      }
      draw(hand);
    };
    const draw = (hand: TrackedHand | null) => {
      const c = canvasRef.current;
      const ctx = c?.getContext('2d');
      if (!c || !ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#DFF1FF');
      g.addColorStop(1, '#EFE7FF');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      const sx = (x: number) => x * w;
      const sy = (y: number) => y * h;
      const st = testRef.current;
      const r = Math.max(14, HAND_TEST_RADIUS * Math.min(w, h) * 1.3);
      HAND_TEST_POINTS.forEach((p, i) => {
        const done = passedRef.current || i < st.index;
        const current = !passedRef.current && i === st.index;
        ctx.beginPath();
        ctx.arc(sx(p.pos.x), sy(p.pos.y), r, 0, Math.PI * 2);
        ctx.fillStyle = done ? '#34D399' : current ? '#22C55E' : 'rgba(100,116,139,0.18)';
        ctx.globalAlpha = current ? 0.75 + 0.25 * Math.sin(performance.now() / 160) : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (current && st.heldSec > 0) {
          ctx.lineWidth = 6;
          ctx.strokeStyle = '#F59E0B';
          ctx.beginPath();
          ctx.arc(sx(p.pos.x), sy(p.pos.y), r + 6, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * st.heldSec) / HAND_DWELL_SEC);
          ctx.stroke();
        }
        ctx.fillStyle = done || current ? '#FFFFFF' : '#64748B';
        ctx.font = "700 13px Jua, 'Noto Sans KR', sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(done ? '✓' : p.label, sx(p.pos.x), sy(p.pos.y));
      });
      if (hand) {
        const pts = hand.landmarks.map((p) => ({ x: sx(p.x), y: sy(p.y) }));
        ctx.lineCap = 'round';
        for (const [lw, color] of [[8, 'rgba(255,255,255,0.9)'], [4, '#0EA5E9']] as Array<[number, string]>) {
          ctx.lineWidth = lw;
          ctx.strokeStyle = color;
          for (const [a, b] of HAND_CONNECTIONS) {
            ctx.beginPath();
            ctx.moveTo(pts[a].x, pts[a].y);
            ctx.lineTo(pts[b].x, pts[b].y);
            ctx.stroke();
          }
        }
        ctx.fillStyle = '#F59E0B';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sx(hand.tip.x), sy(hand.tip.y), 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [status.kind, frameRef]);

  const total = HAND_TEST_POINTS.length;
  const current = HAND_TEST_POINTS[Math.min(step, total - 1)];

  return (
    <div className="mb-3" data-testid="hand-test-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
        <span className="text-xs sm:text-sm font-extrabold text-[#2B2A5E]">
          손 인식 테스트 (통과하면 게임 시작 버튼이 켜져요)
        </span>
        <span
          data-testid="hand-test-status"
          className={`px-2.5 py-0.5 rounded-full text-xs font-extrabold ${
            passed ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600'
          }`}
        >
          {passed ? '통과' : status.kind === 'running' ? `${Math.min(step, total)} / ${total}` : '대기'}
        </span>
      </div>

      <div
        className="relative w-full rounded-xl overflow-hidden border-2 border-[#C9BEF5]"
        style={{ height: 'clamp(150px, 30vh, 260px)' }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" data-testid="hand-test-canvas" />
        {status.kind !== 'running' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center bg-white/70">
            {status.kind === 'idle' && (
              <>
                <p className="text-sm font-bold text-slate-700">
                  화면에서 60cm쯤 떨어져 가운데에 앉아요. 손으로 조준하고, 과녁에 손가락을 0.5초 대면 터져요.
                </p>
                <button
                  type="button"
                  data-testid="hand-camera-start"
                  onClick={onStartCamera}
                  className="px-5 py-2.5 rounded-2xl font-black text-white bg-sky-500 border-2 border-[#2B2A5E] shadow-[0_4px_0_#2B2A5E] active:translate-y-0.5"
                >
                  카메라 켜고 손 인식 테스트 시작
                </button>
              </>
            )}
            {status.kind === 'loading' && <p className="text-sm font-bold text-slate-700">{status.message}</p>}
            {status.kind === 'error' && (
              <>
                <p className="text-sm font-bold text-rose-600" data-testid="hand-camera-error">{status.message}</p>
                <button
                  type="button"
                  onClick={onStartCamera}
                  className="px-4 py-2 rounded-xl font-black text-white bg-sky-500 border-2 border-[#2B2A5E]"
                >
                  다시 시도
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {status.kind === 'running' && (
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm font-extrabold text-[#2B2A5E]">
          <span>
            {passed
              ? '통과! 팔 뻗기 범위를 맞췄어요. 아래 게임 시작을 눌러요'
              : !handSeen
                ? '손이 안 보여요. 손바닥을 카메라 쪽으로 들어 주세요'
                : `초록 점(${current.label})에 검지를 0.5초 대요`}
          </span>
          {passed && (
            <button type="button" onClick={onRetest} className="px-3 py-1 rounded-lg bg-white border-2 border-[#C9BEF5]">
              다시 테스트
            </button>
          )}
        </div>
      )}
    </div>
  );
}
