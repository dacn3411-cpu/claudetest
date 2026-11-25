/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 손 치료 모드: 웹캠 손 추적으로 실제 팔을 뻗어 과녁을 맞히는 눈-손 협응 훈련.
 * 흐름: 설정 → 팔 뻗기 범위 보정 → 블록 플레이(60~90초) ↔ 휴식(20초) → 결과 리포트
 * 기존 3D 마우스 게임과 따로 동작하며, 카메라 영상은 화면에 보여 주지 않는다.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AutoDifficulty,
  DEFAULT_CALIBRATION,
  FatigueMonitor,
  HAND_LEVELS,
  LOOK_FIRST_CUE_SEC,
  OneEuroFilter2D,
  PushDetector,
  TRACE_SHAPE_LABELS,
  appendHandHistory,
  applyMagnet,
  buildChoiceOptions,
  buildHandSessionSummary,
  buildTraceShape,
  chooseTaskKind,
  clampHandLevel,
  computeMovementMetrics,
  computeReachCalibration,
  effectiveHitRadius,
  getHandLevel,
  getKpFeedback,
  gradeReachHit,
  handSummaryToCsv,
  handSummaryToText,
  imageToReach,
  isPinching,
  loadHandHistory,
  loadHandProfiles,
  newTraceState,
  placeReachTarget,
  placeTraceShape,
  randomVelocity,
  resolveFireRule,
  saveHandProfiles,
  stepMovingTarget,
  stepTrace,
  targetRadiusForLevel,
  traceCorridorForLevel,
  type ChoiceOption,
  type FireMode,
  type HandAttemptRecord,
  type HandProfile,
  type HandSessionSummary,
  type HandSetting,
  type HandSide,
  type HandTaskKind,
  type MovementSample,
  type ReachCalibration,
  type TraceShapeKind,
  type TraceState,
  type Vec2,
} from './handRules';
import { HAND_CONNECTIONS, HandTracker, type HandFrame, type TrackerStatus } from './handTracker';

// ───────────────────────────── 설정 ─────────────────────────────

interface HandModeSettings {
  profileId: string;
  handSetting: HandSetting;
  startLevel: number;
  autoDifficulty: boolean;
  fireMode: FireMode;
  blockSec: number;
  blocks: number;
  restSec: number;
  showKp: boolean;
  input: 'camera' | 'mouse';
  swapHandedness: boolean;
}

const SETTINGS_KEY = 'ehm-hand-settings-v1';

const DEFAULT_SETTINGS: HandModeSettings = {
  profileId: '',
  handSetting: 'R',
  startLevel: 1,
  autoDifficulty: true,
  fireMode: 'auto',
  blockSec: 75,
  blocks: 3,
  restSec: 20,
  showKp: true,
  input: 'camera',
  swapHandedness: false,
};

function loadSettings(): HandModeSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: HandModeSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

const HAND_COLOR: Record<HandSide, string> = { L: '#4F9DF7', R: '#F59E0B' };
const HAND_NAME: Record<HandSide, string> = { L: '왼손', R: '오른손' };

// ───────────────────────────── 소리 ─────────────────────────────

class Beeper {
  private ctx: AudioContext | null = null;
  private get ac(): AudioContext | null {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = Ctor ? new Ctor() : null;
      }
      if (this.ctx?.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }
  tone(freq: number, durSec: number, type: OscillatorType = 'sine', gain = 0.12, delay = 0) {
    const ac = this.ac;
    if (!ac) return;
    const t0 = ac.currentTime + delay;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
    o.connect(g).connect(ac.destination);
    o.start(t0);
    o.stop(t0 + durSec + 0.02);
  }
  perfect() {
    this.tone(880, 0.16, 'triangle');
    this.tone(1320, 0.22, 'triangle', 0.1, 0.08);
  }
  good() {
    this.tone(660, 0.18, 'triangle');
  }
  wrong() {
    this.tone(220, 0.22, 'sine', 0.08);
  }
  levelUp() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.1, i * 0.09));
  }
  tick() {
    this.tone(1200, 0.05, 'sine', 0.04);
  }
}

// ───────────────────────────── 과제 상태 ─────────────────────────────

interface BubbleTarget {
  pos: Vec2;
  vel: Vec2;
  radius: number;
  dwellMs: number;
}

interface ChoiceBubble extends BubbleTarget {
  option: ChoiceOption;
  wrongFlashUntil: number;
}

interface BimanualPart extends BubbleTarget {
  side: HandSide;
  done: boolean;
  doneGrade: 'PERFECT' | 'GOOD' | null;
}

interface Task {
  id: number;
  kind: HandTaskKind;
  level: number;
  /** 'any' = 어느 손으로든 (마우스 체험 등) */
  hand: HandSide | 'any';
  crossMidline: boolean;
  spawnMs: number;
  activateMs: number;
  expireMs: number;
  bubble?: BubbleTarget;
  choices?: ChoiceBubble[];
  instruction?: string;
  trace?: { shape: TraceShapeKind; path: Vec2[]; state: TraceState; corridor: number };
  parts?: BimanualPart[];
  samples: MovementSample[];
  wrongSelections: number;
  earlyMove: boolean;
}

interface Pointer {
  side: HandSide | 'any';
  cursor: Vec2;
  raw: Vec2;
  pinchEdge: boolean;
  pushEdge: boolean;
  landmarks: Vec2[] | null;
  pinching: boolean;
}

interface Popup {
  text: string;
  pos: Vec2;
  color: string;
  bornMs: number;
  lifeMs: number;
  big?: boolean;
}

type Phase = 'setup' | 'loading' | 'calibrate' | 'play' | 'rest' | 'report';

interface HudState {
  block: number;
  blocks: number;
  timeLeft: number;
  level: number;
  successes: number;
  attempts: number;
  instruction: string;
  handsSeen: number;
  restLeft: number;
  calibLeft: number;
  calibSamples: number;
}

// ───────────────────────────── 메인 컴포넌트 ─────────────────────────────

export default function HandTherapyMode({ onExit }: { onExit: () => void }) {
  const [settings, setSettings] = useState<HandModeSettings>(() => loadSettings());
  const [profiles, setProfiles] = useState<HandProfile[]>(() => loadHandProfiles());
  const [phase, setPhase] = useState<Phase>('setup');
  const [trackerStatus, setTrackerStatus] = useState<TrackerStatus>({ kind: 'idle' });
  const [hud, setHud] = useState<HudState>({
    block: 1, blocks: 3, timeLeft: 0, level: 1, successes: 0, attempts: 0, instruction: '',
    handsSeen: 0, restLeft: 0, calibLeft: 0, calibSamples: 0,
  });
  const [summary, setSummary] = useState<HandSessionSummary | null>(null);
  const [blockEndReason, setBlockEndReason] = useState<'time' | 'fatigue'>('time');
  const [copied, setCopied] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [newAge, setNewAge] = useState('');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const frameRef = useRef<HandFrame | null>(null);
  const phaseRef = useRef<Phase>('setup');
  phaseRef.current = phase;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // 메인 루프는 한 번만 등록되므로 프로필 목록도 ref로 읽는다
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const beeper = useMemo(() => new Beeper(), []);

  useEffect(() => saveSettings(settings), [settings]);

  // ── 세션 상태 (프레임마다 바뀌므로 ref) ──
  const sim = useRef({
    calibration: DEFAULT_CALIBRATION as ReachCalibration,
    calibSamples: [] as Vec2[],
    calibStartMs: 0,
    level: 1,
    startLevel: 1,
    levelChanges: [] as Array<{ tSec: number; from: number; to: number }>,
    tasks: [] as Task[],
    nextTaskId: 1,
    nextSpawnMs: 0,
    records: [] as HandAttemptRecord[],
    block: 1,
    blockStartMs: 0,
    blockPlayedMs: 0,
    totalPlayedMs: 0,
    restStartMs: 0,
    fatigueStops: 0,
    blocksDone: 0,
    popups: [] as Popup[],
    replay: null as { path: Vec2[]; bornMs: number } | null,
    filters: { L: new OneEuroFilter2D(1.0, 0.03), R: new OneEuroFilter2D(1.0, 0.03) } as Record<HandSide, OneEuroFilter2D>,
    push: { L: new PushDetector(), R: new PushDetector() } as Record<HandSide, PushDetector>,
    pinchPrev: { L: false, R: false } as Record<HandSide, boolean>,
    mouse: { pos: null as Vec2 | null, clickEdge: false },
    pointers: [] as Pointer[],
    auto: new AutoDifficulty(),
    fatigue: new FatigueMonitor(),
    rng: Math.random as () => number,
    lastHudMs: 0,
    lastTs: 0,
  });

  const activeProfile = profiles.find((p) => p.id === settings.profileId) ?? null;

  // 개발 서버에서만: 자동 플레이 테스트가 과녁 위치를 읽고 화면 좌표로 바꿀 수 있게 연다
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    w.__handModeDebug = {
      sim: () => sim.current,
      toScreen: (p: Vec2) => toScreen(p),
      phase: () => phaseRef.current,
    };
    return () => {
      delete w.__handModeDebug;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 좌표 변환 ──
  const layoutRef = useRef({ w: 1, h: 1, cx: 0.5, cy: 0.5, hx: 1, hy: 1, unit: 1 });
  const toScreen = (p: Vec2) => {
    const L = layoutRef.current;
    return { x: L.cx + p.x * L.hx, y: L.cy + p.y * L.hy };
  };
  const fromScreen = (x: number, y: number): Vec2 => {
    const L = layoutRef.current;
    return { x: (x - L.cx) / L.hx, y: (y - L.cy) / L.hy };
  };

  // ── 손 추적 시작/정지 ──
  const stopTracker = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    frameRef.current = null;
  }, []);

  useEffect(() => () => stopTracker(), [stopTracker]);

  const startSession = async () => {
    const s = sim.current;
    s.level = clampHandLevel(settings.startLevel);
    s.startLevel = s.level;
    s.levelChanges = [];
    s.tasks = [];
    s.records = [];
    s.block = 1;
    s.blockPlayedMs = 0;
    s.totalPlayedMs = 0;
    s.fatigueStops = 0;
    s.blocksDone = 0;
    s.popups = [];
    s.replay = null;
    s.auto.reset();
    s.fatigue.reset();
    s.calibration = DEFAULT_CALIBRATION;
    s.calibSamples = [];
    (['L', 'R'] as HandSide[]).forEach((h) => {
      s.filters[h].reset();
      s.push[h].reset();
      s.pinchPrev[h] = false;
    });
    setSummary(null);
    if (settings.input === 'mouse') {
      beginBlock();
      return;
    }
    setPhase('loading');
    stopTracker();
    const tracker = new HandTracker(
      (f) => {
        frameRef.current = f;
      },
      (st) => {
        setTrackerStatus(st);
        if (st.kind === 'running' && phaseRef.current === 'loading') {
          sim.current.calibSamples = [];
          sim.current.calibStartMs = 0; // 손이 처음 보이는 순간부터 6초를 잰다
          setPhase('calibrate');
        }
      },
    );
    tracker.swapHandedness = settings.swapHandedness;
    trackerRef.current = tracker;
    await tracker.start();
  };

  const beginBlock = () => {
    const s = sim.current;
    s.tasks = [];
    s.blockStartMs = performance.now();
    s.blockPlayedMs = 0;
    s.nextSpawnMs = performance.now() + 900;
    s.fatigue.reset();
    setPhase('play');
  };

  const finishSession = useCallback(() => {
    const s = sim.current;
    const st = settingsRef.current;
    const prof = profilesRef.current.find((p) => p.id === st.profileId) ?? null;
    const sum = buildHandSessionSummary({
      records: s.records,
      profileName: prof?.name ?? '',
      profileAge: prof?.age ?? null,
      handSetting: st.handSetting,
      inputSource: st.input,
      startLevel: s.startLevel,
      endLevel: s.level,
      levelChanges: s.levelChanges,
      blocksPlanned: st.blocks,
      blocksDone: s.blocksDone,
      fatigueStops: s.fatigueStops,
      durationSec: s.totalPlayedMs / 1000,
    });
    if (prof && s.records.length > 0) appendHandHistory(prof.id, sum);
    setSummary(sum);
    stopTracker();
    setPhase('report');
  }, [stopTracker]);

  const endBlock = useCallback(
    (reason: 'time' | 'fatigue') => {
      const s = sim.current;
      s.blocksDone += 1;
      s.totalPlayedMs += s.blockPlayedMs;
      s.tasks = [];
      if (reason === 'fatigue') s.fatigueStops += 1;
      setBlockEndReason(reason);
      if (s.blocksDone >= settingsRef.current.blocks) {
        finishSession();
      } else {
        s.block += 1;
        s.restStartMs = performance.now();
        setPhase('rest');
      }
    },
    [finishSession],
  );

  // ── 과제 만들기 ──
  const spawnTask = (nowMs: number) => {
    const s = sim.current;
    const st = settingsRef.current;
    const cfg = getHandLevel(s.level);
    const isMouse = st.input === 'mouse';
    const kind = chooseTaskKind({
      rng: s.rng,
      level: s.level,
      handSetting: st.handSetting,
      bimanualAvailable: !isMouse,
    });
    const pickHand = (): HandSide =>
      st.handSetting === 'both' ? (s.rng() < 0.5 ? 'L' : 'R') : st.handSetting;
    const hand = pickHand();
    const radius = targetRadiusForLevel(s.level);
    const avoid: Array<{ pos: Vec2; radius: number }> = [];
    for (const t of s.tasks) {
      if (t.bubble) avoid.push({ pos: t.bubble.pos, radius: t.bubble.radius });
      t.choices?.forEach((c) => avoid.push({ pos: c.pos, radius: c.radius }));
      t.parts?.forEach((p) => avoid.push({ pos: p.pos, radius: p.radius }));
      if (t.trace) avoid.push({ pos: t.trace.path[0], radius: 0.5 });
    }
    const crossMidline = s.rng() < cfg.crossMidlineRate;
    const cue = cfg.lookFirst ? LOOK_FIRST_CUE_SEC * 1000 : 0;
    const life = Number.isFinite(cfg.lifetimeSec) ? cfg.lifetimeSec * 1000 : Infinity;
    const base: Task = {
      id: s.nextTaskId++,
      kind,
      level: s.level,
      hand: isMouse ? 'any' : hand,
      crossMidline,
      spawnMs: nowMs,
      activateMs: nowMs + cue,
      expireMs: nowMs + cue + life,
      samples: [],
      wrongSelections: 0,
      earlyMove: false,
    };
    const mouseHand: HandSide = st.handSetting === 'L' ? 'L' : 'R';
    const placeHand = isMouse ? mouseHand : hand;

    if (kind === 'reach' || kind === 'depth') {
      const pos = placeReachTarget({ rng: s.rng, level: s.level, hand: placeHand, crossMidline, radius, avoid });
      base.bubble = {
        pos,
        vel: kind === 'depth' ? { x: 0, y: 0 } : randomVelocity(s.rng, s.level),
        radius: kind === 'depth' ? radius * 1.15 : radius,
        dwellMs: 0,
      };
    } else if (kind === 'choice') {
      const { options, instruction } = buildChoiceOptions(s.rng);
      const choices: ChoiceBubble[] = [];
      for (const option of options) {
        const pos = placeReachTarget({
          rng: s.rng,
          level: s.level,
          hand: placeHand,
          crossMidline: s.rng() < cfg.crossMidlineRate,
          radius,
          avoid: [...avoid, ...choices.map((c) => ({ pos: c.pos, radius: c.radius }))],
        });
        choices.push({ pos, vel: { x: 0, y: 0 }, radius, dwellMs: 0, option, wrongFlashUntil: 0 });
      }
      base.choices = choices;
      base.instruction = instruction;
      base.crossMidline = false;
      base.expireMs = base.activateMs + (Number.isFinite(life) ? life + 3000 : Infinity);
    } else if (kind === 'trace') {
      const shape = cfg.traceShapes[Math.floor(s.rng() * cfg.traceShapes.length)] ?? 'line';
      const scale = 0.22 + 0.1 * Math.min(1, cfg.reachPct);
      const c = placeReachTarget({ rng: s.rng, level: s.level, hand: placeHand, crossMidline, radius: scale + 0.06, avoid });
      const lim = 1 - scale - 0.06;
      const center = { x: Math.max(-lim, Math.min(lim, c.x)), y: Math.max(-lim, Math.min(lim, c.y)) };
      base.trace = {
        shape,
        path: placeTraceShape(buildTraceShape(shape), center, scale),
        state: newTraceState(),
        corridor: traceCorridorForLevel(s.level),
      };
      base.instruction = `${TRACE_SHAPE_LABELS[shape]}를 손가락으로 따라 그려요`;
      base.expireMs = base.activateMs + (Number.isFinite(life) ? life + 8000 : Infinity);
    } else if (kind === 'bimanual') {
      const crossed = s.rng() < cfg.bimanualCrossRate;
      const parts: BimanualPart[] = [];
      for (const side of ['L', 'R'] as HandSide[]) {
        const pos = placeReachTarget({
          rng: s.rng,
          level: s.level,
          hand: side,
          crossMidline: crossed,
          radius,
          avoid: [...avoid, ...parts.map((p) => ({ pos: p.pos, radius: p.radius }))],
        });
        parts.push({ pos, vel: { x: 0, y: 0 }, radius, dwellMs: 0, side, done: false, doneGrade: null });
      }
      base.parts = parts;
      base.hand = 'any';
      base.crossMidline = crossed;
      base.instruction = crossed ? '손을 엇갈려서 두 과녁을 함께!' : '두 손으로 각자 과녁을!';
      base.expireMs = base.activateMs + (Number.isFinite(life) ? life + 3000 : Infinity);
    }
    s.tasks.push(base);
  };

  // ── 시도 기록 ──
  const recordAttempt = (task: Task, rec: Omit<HandAttemptRecord, 'kind' | 'level' | 'crossMidline' | 'block' | 'tSec' | 'wrongSelections' | 'earlyMove'>, nowMs: number) => {
    const s = sim.current;
    s.records.push({
      kind: task.kind,
      level: task.level,
      crossMidline: task.crossMidline,
      block: s.block,
      tSec: Math.round((s.totalPlayedMs + s.blockPlayedMs) / 100) / 10,
      wrongSelections: task.wrongSelections,
      earlyMove: task.earlyMove,
      ...rec,
    });
    if (settingsRef.current.autoDifficulty) {
      const prev = s.level;
      const r = s.auto.record(rec.success, s.level);
      if (r.changed !== 0) {
        s.level = r.level;
        s.levelChanges.push({ tSec: Math.round((s.totalPlayedMs + s.blockPlayedMs) / 1000), from: prev, to: r.level });
        s.popups.push({
          text: r.changed > 0 ? `레벨 업! Lv${r.level}` : `천천히 해 봐요 · Lv${r.level}`,
          pos: { x: 0, y: -0.75 },
          color: r.changed > 0 ? '#F59E0B' : '#64748B',
          bornMs: nowMs,
          lifeMs: 1800,
          big: true,
        });
        if (r.changed > 0) beeper.levelUp();
      }
    }
  };

  const showHit = (pos: Vec2, grade: 'PERFECT' | 'GOOD', nowMs: number, kpText?: string, kpTone?: 'great' | 'tip') => {
    const s = sim.current;
    s.popups.push({ text: grade, pos, color: grade === 'PERFECT' ? '#F59E0B' : '#10B981', bornMs: nowMs, lifeMs: 900, big: true });
    if (kpText && settingsRef.current.showKp) {
      s.popups.push({
        text: kpText,
        pos: { x: pos.x, y: Math.min(0.95, pos.y + 0.22) },
        color: kpTone === 'tip' ? '#7C3AED' : '#0EA5E9',
        bornMs: nowMs,
        lifeMs: 1600,
      });
    }
    if (grade === 'PERFECT') beeper.perfect();
    else beeper.good();
  };

  // ── 입력 → 포인터 ──
  const updatePointers = (nowMs: number) => {
    const s = sim.current;
    const st = settingsRef.current;
    const tSec = nowMs / 1000;
    const pointers: Pointer[] = [];
    if (st.input === 'mouse') {
      if (s.mouse.pos) {
        pointers.push({
          side: 'any',
          cursor: s.mouse.pos,
          raw: s.mouse.pos,
          pinchEdge: s.mouse.clickEdge,
          pushEdge: s.mouse.clickEdge,
          landmarks: null,
          pinching: false,
        });
      }
      s.mouse.clickEdge = false;
      s.pointers = pointers;
      return;
    }
    const frame = frameRef.current;
    if (!frame || nowMs - frame.tMs > 400) {
      s.pointers = [];
      return;
    }
    let hands = frame.hands;
    if (st.handSetting !== 'both') {
      // 한 손 설정: 왼손/오른손 판별과 상관없이 가장 크게 보이는 손 하나를 그 손으로 본다
      hands = [...hands].sort((a, b) => b.size - a.size).slice(0, 1).map((h) => ({ ...h, side: st.handSetting as HandSide }));
    } else {
      // 양손: 같은 쪽으로 두 번 잡히면 화면 위치로 나눈다
      if (hands.length === 2 && hands[0].side === hands[1].side) {
        const sorted = [...hands].sort((a, b) => a.tip.x - b.tip.x);
        hands = [{ ...sorted[0], side: 'L' }, { ...sorted[1], side: 'R' }];
      }
    }
    for (const h of hands) {
      const reach = imageToReach(h.tip, s.calibration);
      const filtered = s.filters[h.side].filter(reach, tSec);
      const pinching = isPinching(h.pinchDist, h.size);
      const pinchEdge = pinching && !s.pinchPrev[h.side];
      s.pinchPrev[h.side] = pinching;
      const pushEdge = s.push[h.side].update(h.size, tSec);
      pointers.push({
        side: h.side,
        cursor: filtered,
        raw: filtered,
        pinchEdge,
        pushEdge,
        landmarks: h.landmarks.map((p) => imageToReach(p, s.calibration)),
        pinching,
      });
    }
    s.pointers = pointers;
  };

  // ── 한 프레임 진행 ──
  const stepPlay = (nowMs: number, dtMs: number) => {
    const s = sim.current;
    const st = settingsRef.current;
    const cfg = getHandLevel(s.level);
    s.blockPlayedMs += dtMs;

    // 자석 보조: 활성 과녁 근처에서 커서를 당긴다
    const magnetTargets: Array<{ pos: Vec2; radius: number }> = [];
    for (const t of s.tasks) {
      if (nowMs < t.activateMs) continue;
      if (t.bubble) magnetTargets.push(t.bubble);
      t.choices?.forEach((c) => magnetTargets.push(c));
      t.parts?.forEach((p) => !p.done && magnetTargets.push(p));
    }
    for (const p of s.pointers) p.cursor = applyMagnet(p.raw, magnetTargets, cfg.magnet);

    const rule = resolveFireRule(st.fireMode, s.level);
    const matching = (t: Task, side?: HandSide) =>
      s.pointers.filter((p) => p.side === 'any' || (side ? p.side === side : t.hand === 'any' || p.side === t.hand));

    const tryFire = (target: BubbleTarget, p: Pointer, requirePush: boolean, dtLocal: number): { fired: boolean; dist: number } => {
      const d = Math.hypot(p.cursor.x - target.pos.x, p.cursor.y - target.pos.y);
      const inside = d <= effectiveHitRadius(target.radius, cfg.magnet);
      if (!inside) {
        target.dwellMs = 0;
        return { fired: false, dist: d };
      }
      if (requirePush) {
        return { fired: p.pushEdge || (p.side === 'any' && p.pinchEdge), dist: d };
      }
      target.dwellMs += dtLocal;
      const gesture = (rule.pinch && p.pinchEdge) || (rule.push && p.pushEdge) || (p.side === 'any' && p.pinchEdge);
      return { fired: gesture || target.dwellMs >= rule.dwellSec * 1000, dist: d };
    };

    const finished: Task[] = [];
    for (const t of s.tasks) {
      const active = nowMs >= t.activateMs;
      // 움직이는 과녁
      if (t.bubble && (t.bubble.vel.x !== 0 || t.bubble.vel.y !== 0) && active) {
        const m = stepMovingTarget(t.bubble.pos, t.bubble.vel, dtMs / 1000, t.bubble.radius);
        t.bubble.pos = m.pos;
        t.bubble.vel = m.vel;
      }
      // 보고 → 뻗기: 반짝이는 동안 과녁에 먼저 들어가면 "기다려요"
      if (!active) {
        const zones = [t.bubble, ...(t.choices ?? []), ...(t.parts ?? [])].filter(Boolean) as BubbleTarget[];
        for (const p of matching(t)) {
          if (zones.some((z) => Math.hypot(p.cursor.x - z.pos.x, p.cursor.y - z.pos.y) <= z.radius) && !t.earlyMove) {
            t.earlyMove = true;
            s.popups.push({ text: '기다려요! 반짝인 다음에', pos: { x: p.cursor.x, y: p.cursor.y - 0.2 }, color: '#7C3AED', bornMs: nowMs, lifeMs: 1100 });
          }
        }
        continue;
      }
      // 움직임 기록 (과제 담당 손)
      const mp = matching(t)[0];
      if (mp) t.samples.push({ t: nowMs, p: { ...mp.raw } });

      // 시간 초과
      if (nowMs > t.expireMs) {
        finished.push(t);
        recordAttempt(t, {
          hand: t.hand === 'any' ? (st.input === 'mouse' ? 'mouse' : 'both') : t.hand,
          success: false,
          grade: 'MISS',
          reactionMs: null,
          movementMs: null,
          pathEfficiency: null,
          overshoot: false,
          traceAccuracyPct: null,
        }, nowMs);
        const where = t.bubble?.pos ?? t.choices?.[0]?.pos ?? t.parts?.[0]?.pos ?? t.trace?.path[0] ?? { x: 0, y: 0 };
        s.popups.push({ text: '다음엔 잡을 수 있어요', pos: where, color: '#94A3B8', bornMs: nowMs, lifeMs: 900 });
        continue;
      }

      const handOf = (p: Pointer): HandAttemptRecord['hand'] => (p.side === 'any' ? 'mouse' : p.side);

      if (t.kind === 'reach' || t.kind === 'depth') {
        const b = t.bubble!;
        for (const p of matching(t)) {
          const r = tryFire(b, p, t.kind === 'depth', dtMs);
          if (!r.fired) continue;
          const grade = gradeReachHit(r.dist, b.radius);
          const m = computeMovementMetrics({ samples: t.samples, activationMs: t.activateMs, hitMs: nowMs, target: b.pos, radius: b.radius });
          const kp = getKpFeedback(m);
          showHit(b.pos, grade, nowMs, kp.text, kp.tone);
          s.replay = { path: t.samples.map((x) => x.p), bornMs: nowMs };
          recordAttempt(t, {
            hand: handOf(p), success: true, grade, reactionMs: m.reactionMs, movementMs: m.movementMs,
            pathEfficiency: m.pathEfficiency, overshoot: m.overshoot, traceAccuracyPct: null,
          }, nowMs);
          finished.push(t);
          break;
        }
      } else if (t.kind === 'choice') {
        let done = false;
        for (const c of t.choices!) {
          for (const p of matching(t)) {
            const r = tryFire(c, p, false, dtMs);
            if (!r.fired) continue;
            if (c.option.correct) {
              const grade = gradeReachHit(r.dist, c.radius);
              const m = computeMovementMetrics({ samples: t.samples, activationMs: t.activateMs, hitMs: nowMs, target: c.pos, radius: c.radius });
              showHit(c.pos, grade, nowMs, t.wrongSelections === 0 ? '정답을 바로 찾았어요!' : '찾았어요!', 'great');
              recordAttempt(t, {
                hand: handOf(p), success: true, grade, reactionMs: m.reactionMs, movementMs: m.movementMs,
                pathEfficiency: m.pathEfficiency, overshoot: m.overshoot, traceAccuracyPct: null,
              }, nowMs);
              done = true;
            } else {
              t.wrongSelections += 1;
              c.wrongFlashUntil = nowMs + 700;
              c.dwellMs = -400; // 바로 다시 판정되지 않게
              beeper.wrong();
              s.popups.push({ text: '다른 걸 찾아봐요', pos: c.pos, color: '#7C3AED', bornMs: nowMs, lifeMs: 900 });
            }
            break;
          }
          if (done) break;
        }
        if (done) finished.push(t);
      } else if (t.kind === 'trace') {
        const tr = t.trace!;
        const p = matching(t)[0];
        if (p) {
          const res = stepTrace({ state: tr.state, path: tr.path, pointer: p.raw, corridor: tr.corridor, startRadius: Math.max(0.09, tr.corridor) });
          if (!tr.state.started && res.state.started) beeper.tick();
          tr.state = res.state;
          if (res.completed && res.result) {
            const end = tr.path[tr.path.length - 1];
            showHit(end, res.result.grade, nowMs, `경로 정확도 ${res.result.pathAccuracyPct}%`, res.result.pathAccuracyPct >= 70 ? 'great' : 'tip');
            recordAttempt(t, {
              hand: handOf(p), success: true, grade: res.result.grade, reactionMs: null, movementMs: null,
              pathEfficiency: null, overshoot: false, traceAccuracyPct: res.result.pathAccuracyPct,
            }, nowMs);
            finished.push(t);
          }
        }
      } else if (t.kind === 'bimanual') {
        for (const part of t.parts!) {
          if (part.done) continue;
          for (const p of matching(t, part.side)) {
            const r = tryFire(part, p, false, dtMs);
            if (!r.fired) continue;
            part.done = true;
            part.doneGrade = gradeReachHit(r.dist, part.radius);
            beeper.tick();
            break;
          }
        }
        if (t.parts!.every((p) => p.done)) {
          const grade = t.parts!.every((p) => p.doneGrade === 'PERFECT') ? 'PERFECT' : 'GOOD';
          showHit({ x: 0, y: -0.3 }, grade, nowMs, '두 손이 함께 해냈어요!', 'great');
          recordAttempt(t, {
            hand: 'both', success: true, grade, reactionMs: null, movementMs: Math.round(nowMs - t.activateMs),
            pathEfficiency: null, overshoot: false, traceAccuracyPct: null,
          }, nowMs);
          finished.push(t);
        }
      }
    }
    if (finished.length) {
      s.tasks = s.tasks.filter((t) => !finished.includes(t));
      s.nextSpawnMs = Math.max(s.nextSpawnMs, nowMs + 700);
    }
    // 새 과제
    if (s.tasks.length < cfg.simultaneous && nowMs >= s.nextSpawnMs) {
      spawnTask(nowMs);
      s.nextSpawnMs = nowMs + 600;
    }

    // 피로 감지 (손 없음/처짐 6초)
    if (st.input === 'camera') {
      const vis = s.pointers.length ? s.pointers.reduce((a, b) => (a.raw.y < b.raw.y ? a : b)).raw : null;
      if (s.fatigue.update(vis, nowMs / 1000)) {
        endBlock('fatigue');
        return;
      }
    }
    if (s.blockPlayedMs >= st.blockSec * 1000) endBlock('time');
  };

  // ── 그리기 ──
  const draw = (ctx: CanvasRenderingContext2D, nowMs: number) => {
    const s = sim.current;
    const L = layoutRef.current;
    const ph = phaseRef.current;
    ctx.clearRect(0, 0, L.w, L.h);
    // 배경
    const g = ctx.createLinearGradient(0, 0, 0, L.h);
    g.addColorStop(0, '#CDEBFF');
    g.addColorStop(1, '#F3E8FF');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, L.w, L.h);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    [[0.12, 0.18, 60], [0.2, 0.2, 44], [0.82, 0.14, 54], [0.9, 0.17, 38], [0.6, 0.88, 70]].forEach(([x, y, r]) => {
      ctx.beginPath();
      ctx.arc(L.w * x, L.h * y, r, 0, Math.PI * 2);
      ctx.fill();
    });
    // 도달 범위와 몸 중앙선
    ctx.save();
    ctx.strokeStyle = 'rgba(99,102,241,0.18)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    ctx.strokeRect(L.cx - L.hx, L.cy - L.hy, L.hx * 2, L.hy * 2);
    ctx.beginPath();
    ctx.moveTo(L.cx, L.cy - L.hy);
    ctx.lineTo(L.cx, L.cy + L.hy);
    ctx.stroke();
    ctx.restore();

    const px = (r: number) => r * L.unit;

    if (ph === 'play') {
      // 지난 명중 경로 다시 보기 (동작 과정 피드백)
      if (s.replay && nowMs - s.replay.bornMs < 1200 && settingsRef.current.showKp) {
        const a = 1 - (nowMs - s.replay.bornMs) / 1200;
        ctx.save();
        ctx.strokeStyle = `rgba(14,165,233,${0.7 * a})`;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        s.replay.path.forEach((p, i) => {
          const q = toScreen(p);
          if (i === 0) ctx.moveTo(q.x, q.y);
          else ctx.lineTo(q.x, q.y);
        });
        ctx.stroke();
        ctx.restore();
      }
      for (const t of s.tasks) drawTask(ctx, t, nowMs, px);
    }

    // 가상 손
    for (const p of s.pointers) drawPointer(ctx, p, px);

    // 팝업
    s.popups = s.popups.filter((p) => nowMs - p.bornMs < p.lifeMs);
    for (const p of s.popups) {
      const age = (nowMs - p.bornMs) / p.lifeMs;
      const q = toScreen({ x: p.pos.x, y: p.pos.y - age * 0.15 });
      ctx.save();
      ctx.globalAlpha = 1 - age * age;
      ctx.font = `${p.big ? 900 : 700} ${p.big ? 34 : 22}px Jua, 'Noto Sans KR', sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(p.text, q.x, q.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, q.x, q.y);
      ctx.restore();
    }
  };

  const drawBubble = (
    ctx: CanvasRenderingContext2D,
    b: BubbleTarget,
    color: string,
    px: (r: number) => number,
    opts: { cue?: boolean; dwellRatio?: number; ringColor?: string; label?: string; shape?: string; dim?: boolean; nowMs: number },
  ) => {
    const q = toScreen(b.pos);
    const r = px(b.radius);
    ctx.save();
    if (opts.cue) {
      const pulse = 0.5 + 0.5 * Math.sin(opts.nowMs / 60);
      ctx.globalAlpha = 0.35 + 0.5 * pulse;
    }
    if (opts.dim) ctx.globalAlpha = 0.45;
    const grad = ctx.createRadialGradient(q.x - r * 0.35, q.y - r * 0.35, r * 0.1, q.x, q.y, r);
    grad.addColorStop(0, '#FFFFFF');
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.beginPath();
    if (opts.shape === 'star') {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? r : r * 0.48;
        const x = q.x + Math.cos(a) * rr;
        const y = q.y + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    } else if (opts.shape === 'triangle') {
      ctx.moveTo(q.x, q.y - r);
      ctx.lineTo(q.x + r * 0.95, q.y + r * 0.75);
      ctx.lineTo(q.x - r * 0.95, q.y + r * 0.75);
      ctx.closePath();
    } else if (opts.shape === 'square') {
      ctx.rect(q.x - r * 0.82, q.y - r * 0.82, r * 1.64, r * 1.64);
    } else {
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = opts.ringColor ?? 'rgba(255,255,255,0.95)';
    ctx.stroke();
    if (opts.cue) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(q.x, q.y, r * 1.3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (opts.dwellRatio && opts.dwellRatio > 0) {
      ctx.lineWidth = 7;
      ctx.strokeStyle = '#22C55E';
      ctx.beginPath();
      ctx.arc(q.x, q.y, r + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, opts.dwellRatio));
      ctx.stroke();
    }
    if (opts.label) {
      ctx.font = `700 ${Math.max(14, r * 0.42)}px Jua, 'Noto Sans KR', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#1E293B';
      ctx.fillText(opts.label, q.x, q.y);
    }
    ctx.restore();
  };

  const drawTask = (ctx: CanvasRenderingContext2D, t: Task, nowMs: number, px: (r: number) => number) => {
    const s = sim.current;
    const cue = nowMs < t.activateMs;
    const dwellSec = resolveFireRule(settingsRef.current.fireMode, s.level).dwellSec;
    const ringFor = (side: HandSide | 'any') => (side === 'any' || settingsRef.current.handSetting !== 'both' ? undefined : HAND_COLOR[side]);
    const labelFor = (side: HandSide | 'any') => (side === 'any' || settingsRef.current.handSetting !== 'both' ? undefined : HAND_NAME[side]);
    if (t.kind === 'reach' && t.bubble) {
      drawBubble(ctx, t.bubble, '#7DD3FC', px, {
        cue, nowMs, ringColor: ringFor(t.hand), label: labelFor(t.hand),
        dwellRatio: Number.isFinite(dwellSec) ? t.bubble.dwellMs / (dwellSec * 1000) : 0,
      });
    } else if (t.kind === 'depth' && t.bubble) {
      const pulse = 1 + 0.08 * Math.sin(nowMs / 160);
      const b = { ...t.bubble, radius: t.bubble.radius * pulse };
      drawBubble(ctx, b, '#C4B5FD', px, { cue, nowMs, ringColor: ringFor(t.hand) ?? '#7C3AED', label: '쭉!' });
    } else if (t.kind === 'choice' && t.choices) {
      for (const c of t.choices) {
        drawBubble(ctx, c, c.option.colorHex, px, {
          cue, nowMs, shape: c.option.shape, dim: nowMs < c.wrongFlashUntil,
          dwellRatio: Number.isFinite(dwellSec) && c.dwellMs > 0 ? c.dwellMs / (dwellSec * 1000) : 0,
        });
      }
    } else if (t.kind === 'bimanual' && t.parts) {
      for (const p of t.parts) {
        drawBubble(ctx, p, p.done ? '#BBF7D0' : HAND_COLOR[p.side], px, {
          cue, nowMs, label: p.done ? '✓' : HAND_NAME[p.side], ringColor: '#FFFFFF',
          dwellRatio: !p.done && Number.isFinite(dwellSec) ? p.dwellMs / (dwellSec * 1000) : 0,
        });
      }
    } else if (t.kind === 'trace' && t.trace) {
      const tr = t.trace;
      const pts = tr.path.map(toScreen);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(167,139,250,0.35)';
      ctx.lineWidth = px(tr.corridor) * 2;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.strokeStyle = '#A78BFA';
      ctx.lineWidth = 5;
      ctx.setLineDash([12, 10]);
      ctx.stroke();
      ctx.setLineDash([]);
      const upto = Math.floor(tr.state.progress * (pts.length - 1));
      if (upto > 0) {
        ctx.strokeStyle = '#F59E0B';
        ctx.lineWidth = 9;
        ctx.beginPath();
        pts.slice(0, upto + 1).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      }
      const p0 = pts[0];
      const pulse = tr.state.started ? 1 : 1 + 0.15 * Math.sin(nowMs / 140);
      ctx.fillStyle = '#22C55E';
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, px(Math.max(0.09, tr.corridor)) * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `700 16px Jua, 'Noto Sans KR', sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(tr.state.started ? '' : '시작', p0.x, p0.y + 6);
      const pe = pts[pts.length - 1];
      ctx.fillStyle = '#F472B6';
      ctx.beginPath();
      ctx.arc(pe.x, pe.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // 남은 시간 표시 (작은 막대)
    if (Number.isFinite(t.expireMs) && !cue) {
      const anchor = t.bubble?.pos ?? t.choices?.[0]?.pos ?? t.parts?.[0]?.pos ?? t.trace?.path[0];
      if (anchor) {
        const ratio = Math.max(0, (t.expireMs - nowMs) / (t.expireMs - t.activateMs));
        const q = toScreen(anchor);
        const r = px(t.bubble?.radius ?? 0.1);
        ctx.fillStyle = 'rgba(15,23,42,0.15)';
        ctx.fillRect(q.x - r, q.y + r + 12, r * 2, 5);
        ctx.fillStyle = ratio > 0.3 ? '#10B981' : '#F43F5E';
        ctx.fillRect(q.x - r, q.y + r + 12, r * 2 * ratio, 5);
      }
    }
  };

  const drawPointer = (ctx: CanvasRenderingContext2D, p: Pointer, px: (r: number) => number) => {
    const color = p.side === 'any' ? '#0EA5E9' : HAND_COLOR[p.side];
    if (p.landmarks) {
      const pts = p.landmarks.map(toScreen);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
        ctx.stroke();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
        ctx.stroke();
      }
      ctx.restore();
    }
    const q = toScreen(p.cursor);
    ctx.save();
    ctx.fillStyle = p.pinching ? '#22C55E' : color;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(q.x, q.y, Math.max(10, px(0.035)), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  // ── 캔버스 크기 ──
  useEffect(() => {
    const onResize = () => {
      const c = canvasRef.current;
      if (!c) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = window.innerWidth;
      const h = window.innerHeight;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      const ctx = c.getContext('2d');
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      const top = Math.min(90, h * 0.12);
      const bottom = 24;
      const hy = (h - top - bottom) / 2 - 10;
      const hx = Math.min(w / 2 - 24, hy * 1.6);
      layoutRef.current = { w, h, cx: w / 2, cy: top + 10 + hy, hx, hy, unit: Math.min(hx, hy) };
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── 마우스 체험 입력 ──
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const move = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      sim.current.mouse.pos = fromScreen(e.clientX - r.left, e.clientY - r.top);
    };
    const down = (e: PointerEvent) => {
      move(e);
      sim.current.mouse.clickEdge = true;
    };
    const leave = () => {
      sim.current.mouse.pos = null;
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointerleave', leave);
    return () => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointerleave', leave);
    };
  }, []);

  // ── 메인 루프 ──
  useEffect(() => {
    let raf = 0;
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      const s = sim.current;
      const dt = s.lastTs ? Math.min(100, ts - s.lastTs) : 16;
      s.lastTs = ts;
      const nowMs = performance.now();
      const ph = phaseRef.current;
      const st = settingsRef.current;
      const ctx = canvasRef.current?.getContext('2d');

      if (ph === 'calibrate' || ph === 'play' || ph === 'rest') updatePointers(nowMs);
      else s.pointers = [];

      if (ph === 'calibrate') {
        const frame = frameRef.current;
        if (frame && nowMs - frame.tMs < 300) {
          const hands = st.handSetting === 'both' ? frame.hands : frame.hands.slice(0, 1);
          if (hands.length > 0 && s.calibStartMs === 0) s.calibStartMs = nowMs;
          for (const h of hands) s.calibSamples.push({ ...h.tip });
        }
        if (s.calibStartMs > 0 && nowMs - s.calibStartMs >= 6000 && s.calibSamples.length >= 15) {
          s.calibration = computeReachCalibration(s.calibSamples, 0.5);
          (['L', 'R'] as HandSide[]).forEach((h) => s.filters[h].reset());
          beeper.levelUp();
          beginBlock();
        }
      } else if (ph === 'play') {
        stepPlay(nowMs, dt);
      } else if (ph === 'rest') {
        if (nowMs - s.restStartMs >= st.restSec * 1000) beginBlock();
      }

      if (ctx && ph !== 'setup' && ph !== 'report') draw(ctx, nowMs);

      if (nowMs - s.lastHudMs > 200) {
        s.lastHudMs = nowMs;
        const parts = s.tasks
          .filter((t) => nowMs >= t.activateMs)
          .map((t) => t.instruction ?? (t.kind === 'depth' ? '보라색 "쭉!"은 손을 화면 쪽으로 쭉 뻗어요' : ''))
          .filter(Boolean);
        const instr = [...new Set(parts)].join('  ·  ');
        setHud({
          block: s.block,
          blocks: st.blocks,
          timeLeft: Math.max(0, Math.ceil(st.blockSec - s.blockPlayedMs / 1000)),
          level: s.level,
          successes: s.records.filter((r) => r.success).length,
          attempts: s.records.length,
          instruction: instr,
          handsSeen: s.pointers.length,
          restLeft: Math.max(0, Math.ceil(st.restSec - (nowMs - s.restStartMs) / 1000)),
          calibLeft: s.calibStartMs === 0 ? 6 : Math.max(0, Math.ceil(6 - (nowMs - s.calibStartMs) / 1000)),
          calibSamples: s.calibSamples.length,
        });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // 루프는 ref만 읽으므로 한 번만 등록한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 프로필 ──
  const addProfile = () => {
    const name = newName.trim();
    if (!name) return;
    const ageNum = Number(newAge);
    const p: HandProfile = {
      id: `p-${Date.now()}`,
      name: name.slice(0, 20),
      age: Number.isFinite(ageNum) && ageNum > 0 && ageNum < 30 ? Math.round(ageNum) : null,
    };
    const list = [...profiles, p];
    setProfiles(list);
    saveHandProfiles(list);
    setSettings({ ...settings, profileId: p.id });
    setNewName('');
    setNewAge('');
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setCopied('복사하지 못했어요. 브라우저 권한을 확인해 주세요');
    }
    window.setTimeout(() => setCopied(''), 1800);
  };

  const printTraceSheet = () => {
    const shapes: TraceShapeKind[] = ['line', 'circle', 'zigzag', 'square', 'triangle', 'figure8'];
    const svg = (kind: TraceShapeKind) => {
      const pts = buildTraceShape(kind, 120).map((p) => `${(p.x * 80 + 100).toFixed(1)},${(p.y * 80 + 100).toFixed(1)}`);
      const [sx, sy] = pts[0].split(',');
      return `<figure><svg viewBox="0 0 200 200" width="300" height="300"><polyline points="${pts.join(' ')}" fill="none" stroke="#999" stroke-width="3" stroke-dasharray="6 6"/><circle cx="${sx}" cy="${sy}" r="9" fill="#22C55E"/></svg><figcaption>${TRACE_SHAPE_LABELS[kind]} · 초록 점에서 시작</figcaption></figure>`;
    };
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>따라그리기 시트</title><style>body{font-family:'Noto Sans KR',sans-serif;margin:24px}h1{font-size:20px}main{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}figure{margin:0;text-align:center;border:1px solid #ddd;border-radius:12px;padding:8px}figcaption{font-size:14px;color:#444}@media print{button{display:none}}</style></head><body><h1>EYE HAND MISSION · 따라그리기 시트${summary?.profileName ? ` (${summary.profileName})` : ''}</h1><p>게임에서 연습한 도형을 연필로 따라 그려요. 선에서 벗어나지 않게 천천히!</p><button onclick="print()">인쇄하기</button><main>${shapes.map(svg).join('')}</main></body></html>`;
    const w = window.open('', '_blank');
    if (!w) {
      setCopied('팝업이 막혀 있어요. 팝업을 허용해 주세요');
      window.setTimeout(() => setCopied(''), 2200);
      return;
    }
    w.document.write(html);
    w.document.close();
  };

  const history = useMemo(() => {
    if (!settings.profileId) return [];
    return loadHandHistory()[settings.profileId] ?? [];
  }, [settings.profileId, summary]);

  const stopNow = () => {
    const s = sim.current;
    if (phaseRef.current === 'play') {
      s.totalPlayedMs += s.blockPlayedMs;
      s.blockPlayedMs = 0;
    }
    if (s.records.length > 0) finishSession();
    else {
      stopTracker();
      setPhase('setup');
    }
  };

  // ───────────────────────────── 화면 ─────────────────────────────

  const lvCfg = HAND_LEVELS[clampHandLevel(settings.startLevel)];
  const btn = 'rounded-xl px-4 py-2 font-black shadow-sm border-2 transition active:scale-95';
  const pill = (on: boolean) =>
    `${btn} ${on ? 'bg-sky-500 text-white border-sky-600' : 'bg-white text-slate-700 border-slate-200 hover:border-sky-300'}`;

  return (
    <div className="fixed inset-0 z-[200] select-none" style={{ fontFamily: "Jua, 'Noto Sans KR', sans-serif", background: '#EEF6FF' }} data-testid="hand-mode">
      <canvas ref={canvasRef} className="absolute inset-0 touch-none" data-testid="hand-canvas" />

      {/* 상단 HUD */}
      {(phase === 'play' || phase === 'rest' || phase === 'calibrate' || phase === 'loading') && (
        <div className="absolute top-0 inset-x-0 flex items-start justify-between gap-2 p-3 pointer-events-none">
          <div className="rounded-xl bg-white/85 px-3 py-2 shadow text-slate-700 text-sm sm:text-base">
            <div>블록 {hud.block} / {hud.blocks}</div>
            {phase === 'play' && <div className="text-2xl text-sky-600 tabular-nums">{hud.timeLeft}초</div>}
          </div>
          {phase === 'play' && hud.instruction && (
            <div className="rounded-2xl bg-white/90 px-4 py-2 shadow text-lg sm:text-2xl text-violet-700" data-testid="hand-instruction">
              {hud.instruction}
            </div>
          )}
          <div className="flex items-start gap-2">
            <div className="rounded-xl bg-white/85 px-3 py-2 shadow text-right text-slate-700 text-sm sm:text-base">
              <div data-testid="hand-level">Lv {hud.level}</div>
              <div className="text-xl text-emerald-600 tabular-nums">{hud.successes} / {hud.attempts}</div>
            </div>
            <button className={`${btn} pointer-events-auto bg-white text-slate-700 border-slate-200`} onClick={stopNow}>
              그만하기
            </button>
          </div>
        </div>
      )}

      {phase === 'play' && settings.input === 'camera' && hud.handsSeen === 0 && (
        <div className="absolute bottom-6 inset-x-0 flex justify-center pointer-events-none">
          <div className="rounded-xl bg-amber-100 border-2 border-amber-300 px-4 py-2 text-amber-800 text-lg">
            손이 안 보여요. 손을 카메라 앞으로 올려 주세요
          </div>
        </div>
      )}

      {/* 카메라 준비 */}
      {phase === 'loading' && (
        <Overlay>
          <h2 className="text-2xl text-slate-800 mb-2">손 추적 준비 중</h2>
          <p className="text-slate-600 mb-4">
            {trackerStatus.kind === 'loading' ? trackerStatus.message : trackerStatus.kind === 'error' ? '' : '잠시만 기다려 주세요…'}
          </p>
          {trackerStatus.kind === 'error' && (
            <>
              <p className="text-rose-600 mb-4" data-testid="hand-error">{trackerStatus.message}</p>
              <div className="flex flex-wrap gap-2 justify-center">
                <button className={pill(true)} onClick={() => { setSettings({ ...settings, input: 'mouse' }); setPhase('setup'); }}>
                  마우스로 체험하기
                </button>
                <button className={pill(false)} onClick={() => setPhase('setup')}>설정으로</button>
              </div>
            </>
          )}
          <p className="text-xs text-slate-500 mt-4">카메라 영상은 저장하거나 화면에 보여 주지 않고, 손 관절 위치만 사용해요.</p>
        </Overlay>
      )}

      {/* 팔 뻗기 범위 보정 */}
      {phase === 'calibrate' && (
        <div className="absolute inset-x-0 bottom-6 flex justify-center pointer-events-none">
          <div className="rounded-2xl bg-white/92 px-6 py-4 shadow-lg text-center max-w-xl">
            <div className="text-2xl text-slate-800 mb-1">팔 뻗기 범위 재기 · {hud.calibLeft}초</div>
            <div className="text-slate-600">
              화면 가운데에 앉아서, 팔을 쭉 뻗어 <b>위 · 아래 · 왼쪽 · 오른쪽</b>으로 크게 원을 그려요
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {hud.handsSeen === 0 ? '손이 보이면 시작돼요' : `측정 중 (${hud.calibSamples})`}
            </div>
          </div>
        </div>
      )}

      {/* 휴식 */}
      {phase === 'rest' && (
        <Overlay>
          <div className="text-5xl mb-2">🙌</div>
          <h2 className="text-2xl text-slate-800 mb-1" data-testid="hand-rest">
            {blockEndReason === 'fatigue' ? '팔이 피곤해 보여요. 쉬어 가요' : '잘했어요! 잠깐 쉬어요'}
          </h2>
          <p className="text-slate-600 mb-3">팔을 내리고 손을 탈탈 털어요 · {hud.restLeft}초</p>
          <button className={pill(true)} onClick={beginBlock}>바로 시작</button>
        </Overlay>
      )}

      {/* 설정 */}
      {phase === 'setup' && (
        <div className="absolute inset-0 overflow-y-auto bg-gradient-to-b from-sky-100 to-violet-100 p-4">
          <div className="mx-auto max-w-3xl rounded-3xl bg-white/95 shadow-xl p-5 sm:p-7">
            <div className="flex items-center justify-between gap-2 mb-4">
              <div>
                <h1 className="text-3xl text-slate-800">손 치료 모드</h1>
                <p className="text-slate-500">웹캠으로 실제 팔을 뻗어 과녁을 맞혀요 · 눈-손 협응 훈련</p>
              </div>
              <button className={pill(false)} onClick={() => { stopTracker(); onExit(); }}>← 3D 게임으로</button>
            </div>

            <Section title="아동">
              <div className="flex flex-wrap gap-2 mb-2">
                {profiles.length === 0 && <span className="text-slate-400">아직 등록한 아동이 없어요 (없어도 할 수 있어요)</span>}
                {profiles.map((p) => (
                  <button key={p.id} className={pill(settings.profileId === p.id)} onClick={() => setSettings({ ...settings, profileId: settings.profileId === p.id ? '' : p.id })}>
                    {p.name}{p.age ? ` (${p.age}세)` : ''}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <input className="rounded-xl border-2 border-slate-200 px-3 py-2 w-40" placeholder="이름·별명" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <input className="rounded-xl border-2 border-slate-200 px-3 py-2 w-24" placeholder="나이" inputMode="numeric" value={newAge} onChange={(e) => setNewAge(e.target.value)} />
                <button className={pill(false)} onClick={addProfile}>추가</button>
              </div>
              <p className="text-xs text-slate-400 mt-1">기록은 이 브라우저에만 저장돼요. 실명 대신 별명을 써도 돼요.</p>
            </Section>

            <Section title="입력 방식">
              <div className="flex flex-wrap gap-2">
                <button className={pill(settings.input === 'camera')} onClick={() => setSettings({ ...settings, input: 'camera' })}>웹캠 손 추적</button>
                <button className={pill(settings.input === 'mouse')} onClick={() => setSettings({ ...settings, input: 'mouse' })}>마우스로 체험 (시연·테스트용)</button>
              </div>
            </Section>

            <Section title="사용할 손">
              <div className="flex flex-wrap gap-2">
                {(['L', 'R', 'both'] as HandSetting[]).map((h) => (
                  <button key={h} className={pill(settings.handSetting === h)} onClick={() => setSettings({ ...settings, handSetting: h })}>
                    {h === 'L' ? '왼손' : h === 'R' ? '오른손' : '양손'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-1">편마비 아동은 마비된 쪽 손을 고르면 그 손 사용 훈련이 돼요. 양손 과제는 Lv9부터 나와요.</p>
            </Section>

            <Section title={`시작 레벨 · Lv${settings.startLevel}`}>
              <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5 mb-2">
                {Array.from({ length: 10 }, (_, i) => i + 1).map((lv) => (
                  <button key={lv} className={pill(settings.startLevel === lv)} onClick={() => setSettings({ ...settings, startLevel: lv })}>{lv}</button>
                ))}
              </div>
              <p className="text-slate-600">{lvCfg.label}</p>
              <label className="flex items-center gap-2 mt-2 text-slate-700">
                <input type="checkbox" checked={settings.autoDifficulty} onChange={(e) => setSettings({ ...settings, autoDifficulty: e.target.checked })} />
                자동 난이도 (최근 10번 성공률 80% 이상이면 올리고, 60% 미만이면 내려요)
              </label>
            </Section>

            <Section title="맞히는 방법">
              <div className="flex flex-wrap gap-2">
                {([
                  ['auto', '레벨에 맞게 (추천)'],
                  ['dwell', '손을 대고 기다리기'],
                  ['pinch', '엄지·검지 집기'],
                  ['push', '앞으로 쭉 뻗기'],
                ] as Array<[FireMode, string]>).map(([m, label]) => (
                  <button key={m} className={pill(settings.fireMode === m)} onClick={() => setSettings({ ...settings, fireMode: m })}>{label}</button>
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-1">"레벨에 맞게": Lv1~3은 기다리기, Lv4부터 집기·뻗기도 돼요. 보라색 "쭉!" 과녁은 항상 뻗어야 해요.</p>
            </Section>

            <Section title="블록 (팔 피로 관리)">
              <div className="flex flex-wrap items-center gap-2">
                {[60, 75, 90].map((sec) => (
                  <button key={sec} className={pill(settings.blockSec === sec)} onClick={() => setSettings({ ...settings, blockSec: sec })}>{sec}초</button>
                ))}
                <span className="mx-2 text-slate-400">×</span>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} className={pill(settings.blocks === n)} onClick={() => setSettings({ ...settings, blocks: n })}>{n}블록</button>
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-1">블록 사이에 {settings.restSec}초 쉬어요. 손이 6초 넘게 안 보이거나 아래로 처지면 블록을 일찍 끝내요.</p>
            </Section>

            <Section title="기타">
              <label className="flex items-center gap-2 text-slate-700">
                <input type="checkbox" checked={settings.showKp} onChange={(e) => setSettings({ ...settings, showKp: e.target.checked })} />
                동작 피드백 보여 주기 (손이 지나간 길 + "곧게 뻗었어요" 같은 한마디)
              </label>
              <label className="flex items-center gap-2 text-slate-700 mt-1">
                <input type="checkbox" checked={settings.swapHandedness} onChange={(e) => setSettings({ ...settings, swapHandedness: e.target.checked })} />
                양손 모드에서 왼손·오른손이 반대로 잡히면 체크
              </label>
            </Section>

            <div className="rounded-2xl bg-amber-50 border-2 border-amber-200 p-3 text-sm text-amber-900 mb-4">
              안전: 화면에서 60cm 이상 떨어져 앉고, 팔을 뻗었을 때 손이 카메라에 보이게 해요. 광과민성 발작 병력이 있거나 어지러우면 멈춰요. 카메라 영상은 저장하지 않아요.
            </div>

            <div className="flex flex-wrap gap-2">
              <button className={`${btn} flex-1 min-w-[200px] bg-orange-400 border-orange-500 text-white text-xl py-3`} onClick={startSession} data-testid="hand-start">
                시작하기
              </button>
            </div>

            {activeProfile && history.length > 0 && (
              <Section title={`${activeProfile.name}의 기록 (${history.length}회)`}>
                <TrendChart sessions={history} />
              </Section>
            )}
          </div>
        </div>
      )}

      {/* 결과 리포트 */}
      {phase === 'report' && summary && (
        <div className="absolute inset-0 overflow-y-auto bg-gradient-to-b from-sky-100 to-violet-100 p-4" data-testid="hand-report">
          <div className="mx-auto max-w-3xl rounded-3xl bg-white/95 shadow-xl p-5 sm:p-7">
            <h1 className="text-3xl text-slate-800">결과 리포트</h1>
            <p className="text-slate-500 mb-4">
              {summary.timestamp} · {summary.profileName || '이름 없음'} · {summary.inputSource === 'camera' ? '웹캠 손 추적' : '마우스 체험'} ·{' '}
              {summary.handSetting === 'both' ? '양손' : HAND_NAME[summary.handSetting]}
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
              <Stat label="100점 환산" value={`${summary.score100}`} accent />
              <Stat label="성공률" value={`${summary.accuracyPct}%`} sub={`${summary.successes}/${summary.attempts}`} />
              <Stat label="반응시간 (보고→출발)" value={summary.avgReactionMs === null ? '-' : `${summary.avgReactionMs}ms`} />
              <Stat label="움직임시간 (출발→명중)" value={summary.avgMovementMs === null ? '-' : `${summary.avgMovementMs}ms`} />
              <Stat label="경로 효율" value={summary.avgPathEfficiencyPct === null ? '-' : `${summary.avgPathEfficiencyPct}%`} sub="곧게 갈수록 100%" />
              <Stat label="지나침 비율" value={summary.overshootRatePct === null ? '-' : `${summary.overshootRatePct}%`} sub="낮을수록 좋아요" />
              <Stat label="따라그리기 정확도" value={summary.traceAccuracyPct === null ? '-' : `${summary.traceAccuracyPct}%`} />
              <Stat label="레벨" value={`Lv${summary.startLevel}→${summary.endLevel}`} sub={`최고 Lv${summary.maxLevel}`} />
            </div>

            <Section title="어디가 어려웠나요">
              <Bars
                rows={[
                  ['같은 쪽', summary.sameSideAccuracyPct],
                  ['몸 중앙선 넘기', summary.crossMidlineAccuracyPct],
                  ['왼손', summary.leftAccuracyPct],
                  ['오른손', summary.rightAccuracyPct],
                  ['뻗기 (깊이)', summary.byKind.depth.accuracyPct],
                  ['정답 고르기', summary.byKind.choice.accuracyPct],
                  ['따라 그리기', summary.byKind.trace.accuracyPct],
                  ['양손', summary.byKind.bimanual.accuracyPct],
                ]}
              />
              <p className="text-xs text-slate-400 mt-1">
                블록 {summary.blocksDone}/{summary.blocksPlanned} · 피로로 일찍 끝난 블록 {summary.fatigueStops} · 정답 고르기 오답 {summary.wrongSelections} · 반짝이기 전 출발 {summary.earlyMoves}
              </p>
            </Section>

            <Section title="오늘의 실물 과제 (게임 → 실제 물건으로)">
              <ul className="list-disc pl-5 text-slate-700 space-y-1">
                {summary.recommendations.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </Section>

            {history.length > 1 && (
              <Section title="회기별 변화">
                <TrendChart sessions={history} />
              </Section>
            )}

            <div className="flex flex-wrap gap-2 mt-2">
              <button className={pill(false)} onClick={() => copy(handSummaryToText(summary), '텍스트를 복사했어요')}>텍스트 복사</button>
              <button className={pill(false)} onClick={() => copy(handSummaryToCsv(summary), 'CSV를 복사했어요')}>CSV 복사</button>
              <button className={pill(false)} onClick={printTraceSheet}>따라그리기 시트 인쇄</button>
              <button className={pill(true)} onClick={() => setPhase('setup')}>다시 하기</button>
              <button className={pill(false)} onClick={() => { stopTracker(); onExit(); }}>3D 게임으로</button>
            </div>
            {copied && <p className="text-emerald-600 mt-2">{copied}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── 작은 UI 조각 ─────────────────────────────

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-slate-900/20 p-4">
      <div className="rounded-3xl bg-white/95 shadow-xl px-6 py-6 text-center max-w-md w-full">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <h2 className="text-lg text-slate-700 mb-2">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border-2 p-3 ${accent ? 'border-orange-300 bg-orange-50' : 'border-slate-100 bg-slate-50'}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl tabular-nums ${accent ? 'text-orange-500' : 'text-slate-800'}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

function Bars({ rows }: { rows: Array<[string, number | null]> }) {
  const shown = rows.filter(([, v]) => v !== null) as Array<[string, number]>;
  if (shown.length === 0) return <p className="text-slate-400">기록이 부족해요</p>;
  return (
    <div className="space-y-1.5">
      {shown.map(([label, v]) => (
        <div key={label} className="flex items-center gap-2">
          <div className="w-28 text-sm text-slate-600 shrink-0">{label}</div>
          <div className="flex-1 h-4 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${v}%`, background: v >= 80 ? '#10B981' : v >= 60 ? '#F59E0B' : '#F43F5E' }} />
          </div>
          <div className="w-12 text-right text-sm tabular-nums text-slate-700">{v}%</div>
        </div>
      ))}
    </div>
  );
}

function TrendChart({ sessions }: { sessions: HandSessionSummary[] }) {
  const last = sessions.slice(-12);
  const W = 560;
  const H = 150;
  const pad = 26;
  const x = (i: number) => pad + (last.length <= 1 ? 0 : (i * (W - pad * 2)) / (last.length - 1));
  const yAcc = (v: number) => H - pad - (v / 100) * (H - pad * 2);
  const mts = last.map((s) => s.avgMovementMs).filter((v): v is number => v !== null);
  const maxMt = Math.max(1500, ...mts);
  const yMt = (v: number) => H - pad - (v / maxMt) * (H - pad * 2);
  const line = (pts: Array<[number, number]>) => pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
  const accPts = last.map((s, i) => [x(i), yAcc(s.accuracyPct)] as [number, number]);
  const mtPts = last.flatMap((s, i) => (s.avgMovementMs === null ? [] : [[x(i), yMt(s.avgMovementMs)] as [number, number]]));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="회기별 성공률과 움직임시간">
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#CBD5E1" />
        <path d={line(accPts)} fill="none" stroke="#10B981" strokeWidth={3} />
        {accPts.map(([a, b], i) => <circle key={`a${i}`} cx={a} cy={b} r={4} fill="#10B981" />)}
        {mtPts.length > 0 && <path d={line(mtPts)} fill="none" stroke="#6366F1" strokeWidth={2} strokeDasharray="5 4" />}
        {last.map((s, i) => (
          <text key={`t${i}`} x={x(i)} y={H - 8} fontSize={10} textAnchor="middle" fill="#94A3B8">{i + 1}</text>
        ))}
      </svg>
      <div className="flex gap-4 text-xs text-slate-500">
        <span><span className="inline-block w-3 h-1 bg-emerald-500 align-middle mr-1" />성공률</span>
        <span><span className="inline-block w-3 h-1 bg-indigo-500 align-middle mr-1" />움직임시간 (낮을수록 빠름)</span>
      </div>
    </div>
  );
}
