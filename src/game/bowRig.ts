/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 손 조작용 1인칭 국궁(각궁) (총 대신).
 * - 활 몸은 public/assets/models/weapons/gakgung.glb (tools/bow/build_gakgung.mjs로 만든 원래 디자인)
 * - 시위는 GLB 안의 위치 표시를 따라 코드로 그린다: 양냥고자 → 도고지 → 당김점 → 도고지 → 양냥고자
 * - 활은 손가락 조준점 쪽으로 몸을 돌리고, 위치도 조금 따라간다
 * - 과녁에 손가락을 대고 있는 0.5초 동안 시위가 당겨지고 화살촉이 빛난다 (setDraw)
 * - 다 당겨지면 화살이 날아가 맞은 곳에 잠깐 꽂혔다가 사라진다 (release)
 * 총과 같은 1인칭 레이어(VIEWMODEL_LAYER)에 그린다.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VIEWMODEL_LAYER } from './weaponSystem';

/** 조준점 쪽으로 활 몸통이 돌아가는 정도 (1 = 정확히 조준점을 향함) */
const AIM_FOLLOW = 0.85;
/** 조준점 쪽으로 활 위치가 따라가는 거리 (카메라 공간 m) */
const SHIFT_X = 0.1;
const SHIFT_Y = 0.06;
/** 실제 크기(약 1.2m) 활을 화면에 맞게 줄이는 배율 */
const BOW_SCALE = 0.38;
/** 다 당겼을 때 시위가 뒤로 오는 거리 (활 모델 단위 m) */
const DRAW_PULL = 0.34;
/** 걸어 둔 화살 길이 배율 (기본 화살 0.62m → 약 0.8m) */
const NOCKED_ARROW_SCALE = 1.3;
const ARROW_SPEED = 55;

const GAKGUNG_URL =
  ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/') +
  'assets/models/weapons/gakgung.glb';

interface FlyingArrow {
  mesh: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  stuckSec: number;
  trail: THREE.Mesh;
}

export function aimPointInCameraSpace(
  ndcX: number,
  ndcY: number,
  camera: THREE.PerspectiveCamera,
  depth = 10,
): THREE.Vector3 {
  const halfH = depth * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const halfW = halfH * camera.aspect;
  return new THREE.Vector3(ndcX * halfW, ndcY * halfH, -depth);
}

/** 화살 (길이 0.62m, -Z가 촉). 깃은 붉은색과 흰색 */
function buildArrow(): THREE.Group {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, 0.62, 8),
    new THREE.MeshStandardMaterial({ color: '#D2B07A', roughness: 0.7 }),
  );
  shaft.rotation.x = Math.PI / 2;
  g.add(shaft);
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.016, 0.06, 10),
    new THREE.MeshStandardMaterial({ color: '#E9F6FF', emissive: '#38BDF8', emissiveIntensity: 0.4, metalness: 0.6, roughness: 0.25 }),
  );
  head.name = 'arrow-head';
  head.rotation.x = -Math.PI / 2;
  head.position.z = -0.34;
  g.add(head);
  const fletchMats = [
    new THREE.MeshStandardMaterial({ color: '#C0262D', side: THREE.DoubleSide, roughness: 0.8 }),
    new THREE.MeshStandardMaterial({ color: '#F8F4EA', side: THREE.DoubleSide, roughness: 0.8 }),
  ];
  for (let i = 0; i < 3; i++) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(0.026, 0.1), fletchMats[i === 0 ? 0 : 1]);
    f.position.z = 0.25;
    f.rotation.set(Math.PI / 2, 0, (i * Math.PI * 2) / 3);
    f.translateX(0.014);
    g.add(f);
  }
  return g;
}

/** GLB를 못 읽을 때 쓰는 간단한 활 (활 모델 단위) */
function buildFallbackBow(): THREE.Group {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: '#3A2618', roughness: 0.55 });
  for (const sign of [1, -1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.07 * sign, -0.012),
      new THREE.Vector3(0, 0.26 * sign, 0.035),
      new THREE.Vector3(0, 0.42 * sign, 0.1),
      new THREE.Vector3(0, 0.525 * sign, 0.09),
      new THREE.Vector3(0, 0.585 * sign, -0.005),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 30, 0.016, 8, false), wood));
  }
  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.14, 12),
    new THREE.MeshStandardMaterial({ color: '#8E1B1B', roughness: 0.8 }),
  );
  grip.position.z = -0.012;
  g.add(grip);
  return g;
}

export class BowRig {
  private camera: THREE.PerspectiveCamera;
  private scene: THREE.Scene;
  private root = new THREE.Group();
  private pivot = new THREE.Group();
  private model = new THREE.Group();
  private string: THREE.Line;
  private stringPos: THREE.BufferAttribute;
  private nocked: THREE.Group;
  private headMat: THREE.MeshStandardMaterial;
  private glow: THREE.PointLight;
  private disposed = false;

  // 시위가 지나는 자리 (활 모델 단위). GLB의 빈 노드 위치로 바뀐다
  private stringTop = new THREE.Vector3(0, 0.585, -0.001);
  private bridgeTop = new THREE.Vector3(0, 0.43, 0.128);
  private bridgeBottom = new THREE.Vector3(0, -0.456, 0.128);
  private stringBottom = new THREE.Vector3(0, -0.62, -0.001);
  private nockRest = new THREE.Vector3(0, 0.09, 0.128);
  private arrowRest = new THREE.Vector3(0.012, 0.09, -0.012);

  // 왼손에 든 활처럼 화면 왼쪽 아래: 화살이 대각선으로 조준점을 향해 보인다
  private basePos = new THREE.Vector3(-0.16, -0.15, -0.55);

  private aimNdc = new THREE.Vector2(0, 0);
  private curQuat = new THREE.Quaternion();
  private curShift = new THREE.Vector2(0, 0);
  private drawTarget = 0;
  private draw = 0;
  private releaseKick = 0;
  private flying: FlyingArrow[] = [];
  private audio: AudioContext | null = null;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
    if (!camera.parent) scene.add(camera);
    this.root.name = 'bow-rig';
    this.root.position.copy(this.basePos);
    this.root.scale.setScalar(BOW_SCALE);
    this.root.add(this.pivot);
    this.pivot.add(this.model);
    camera.add(this.root);

    // GLB를 읽는 동안(또는 실패하면) 보이는 간단한 활
    const fallback = buildFallbackBow();
    fallback.name = 'bow-fallback';
    this.model.add(fallback);

    // 시위: 양냥고자 → 도고지 → 당김점 → 도고지 → 양냥고자
    const sg = new THREE.BufferGeometry();
    this.stringPos = new THREE.BufferAttribute(new Float32Array(15), 3);
    sg.setAttribute('position', this.stringPos);
    this.string = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: '#FFF3DA' }));
    this.string.frustumCulled = false;
    this.pivot.add(this.string);

    // 걸어 둔 화살 (줌통의 화살 자리 옆, 촉이 과녁 쪽 -Z)
    this.nocked = buildArrow();
    this.nocked.scale.setScalar(NOCKED_ARROW_SCALE);
    this.pivot.add(this.nocked);
    this.headMat = (this.nocked.getObjectByName('arrow-head') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    this.glow = new THREE.PointLight('#38BDF8', 0, 1.2);
    this.pivot.add(this.glow);

    this.applyLayers(this.root);
    this.glow.layers.enable(VIEWMODEL_LAYER);
    this.updateString();
    this.loadModel();
  }

  private applyLayers(obj: THREE.Object3D) {
    obj.traverse((o) => o.layers.set(VIEWMODEL_LAYER));
  }

  private loadModel() {
    new GLTFLoader().load(
      GAKGUNG_URL,
      (gltf) => {
        if (this.disposed) return;
        const glb = gltf.scene;
        const pick = (name: string, into: THREE.Vector3) => {
          const n = glb.getObjectByName(name);
          if (n) into.copy(n.position);
        };
        pick('string_top', this.stringTop);
        pick('string_bottom', this.stringBottom);
        pick('bridge_top', this.bridgeTop);
        pick('bridge_bottom', this.bridgeBottom);
        pick('nock_point', this.nockRest);
        pick('arrow_rest', this.arrowRest);
        glb.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.castShadow = false;
            m.receiveShadow = false;
            m.frustumCulled = false;
          }
        });
        this.applyLayers(glb);
        const fb = this.model.getObjectByName('bow-fallback');
        if (fb) this.model.remove(fb);
        this.model.add(glb);
        this.updateString();
      },
      undefined,
      () => {
        // 못 읽으면 간단한 활을 그대로 쓴다
      },
    );
  }

  setVisible(v: boolean) {
    this.root.visible = v;
  }

  /** 손가락 조준점 (NDC). null이면 가운데로 돌아온다 */
  setAim(ndc: { x: number; y: number } | null) {
    if (ndc) this.aimNdc.set(ndc.x, ndc.y);
    else this.aimNdc.multiplyScalar(0.9);
  }

  /** 시위 당김 0~1 (과녁에 손가락을 댄 시간 비율) */
  setDraw(p: number) {
    this.drawTarget = Math.max(0, Math.min(1, p));
  }

  private ensureAudio(): AudioContext | null {
    try {
      if (!this.audio) {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audio = Ctor ? new Ctor() : null;
      }
      if (this.audio?.state === 'suspended') void this.audio.resume();
      return this.audio;
    } catch {
      return null;
    }
  }

  private playTwang() {
    const ac = this.ensureAudio();
    if (!ac) return;
    const t0 = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t0);
    o.frequency.exponentialRampToValueAtTime(90, t0 + 0.18);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    o.connect(g).connect(ac.destination);
    o.start(t0);
    o.stop(t0 + 0.25);
    // 바람 가르는 소리
    const len = Math.floor(ac.sampleRate * 0.18);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const n = ac.createBufferSource();
    n.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800, t0);
    bp.frequency.exponentialRampToValueAtTime(600, t0 + 0.18);
    const ng = ac.createGain();
    ng.gain.value = 0.12;
    n.connect(bp).connect(ng).connect(ac.destination);
    n.start(t0);
  }

  /**
   * 화살 쏘기: 조준점 방향으로 hitDistance(m)만큼 날아가 꽂힌다.
   */
  release(ndcX: number, ndcY: number, hitDistance: number) {
    this.camera.updateMatrixWorld(true);
    const from = new THREE.Vector3();
    this.nocked.getWorldPosition(from);
    const dir = aimPointInCameraSpace(ndcX, ndcY, this.camera, 1).normalize();
    const to = dir.multiplyScalar(Math.max(1.5, hitDistance)).applyMatrix4(this.camera.matrixWorld);
    const mesh = buildArrow();
    mesh.scale.setScalar(1.6);
    mesh.position.copy(from);
    mesh.lookAt(to);
    mesh.rotateY(Math.PI); // 화살 앞(-Z)이 목표를 향하게
    const trail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.01, 0.002, 1, 6, 1, true),
      new THREE.MeshBasicMaterial({ color: '#7DD3FC', transparent: true, opacity: 0.6, depthWrite: false }),
    );
    this.scene.add(mesh);
    this.scene.add(trail);
    const dist = from.distanceTo(to);
    this.flying.push({ mesh, from, to, t: 0, dur: Math.max(0.08, dist / ARROW_SPEED), stuckSec: 0, trail });
    this.draw = 0;
    this.drawTarget = 0;
    this.releaseKick = 1;
    this.nocked.visible = false;
    this.playTwang();
  }

  private updateString() {
    // 당김점: 쉴 때는 도고지 사이 직선 위, 당기면 쏘는 사람 쪽(+Z)으로
    const nockZ = this.nockRest.z + this.draw * DRAW_PULL;
    const p = this.stringPos.array as Float32Array;
    p.set([
      this.stringTop.x, this.stringTop.y, this.stringTop.z,
      this.bridgeTop.x, this.bridgeTop.y, this.bridgeTop.z,
      this.nockRest.x, this.nockRest.y, nockZ,
      this.bridgeBottom.x, this.bridgeBottom.y, this.bridgeBottom.z,
      this.stringBottom.x, this.stringBottom.y, this.stringBottom.z,
    ]);
    this.stringPos.needsUpdate = true;
    // 화살: 오늬(꼬리)가 당김점에, 몸통은 화살 자리 옆
    const tailOffset = 0.31 * NOCKED_ARROW_SCALE;
    this.nocked.position.set(this.arrowRest.x, this.nockRest.y, nockZ - tailOffset);
    const headZ = nockZ - tailOffset - 0.34 * NOCKED_ARROW_SCALE;
    this.glow.position.set(this.arrowRest.x, this.nockRest.y, headZ);
  }

  update(dt: number) {
    const k = Math.min(1, dt * 14);
    // 활이 조준점 쪽으로 돌고 조금 따라간다
    const target = aimPointInCameraSpace(this.aimNdc.x * AIM_FOLLOW, this.aimNdc.y * AIM_FOLLOW, this.camera, 10);
    const local = target.clone().sub(this.root.position).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), local);
    // 살짝 기울여 들고, 옆으로 조금 틀어 각궁의 휜 모양(반곡)이 보이게 한다
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.38));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.42));
    this.curQuat.slerp(q, k);
    this.pivot.quaternion.copy(this.curQuat);
    this.curShift.lerp(new THREE.Vector2(this.aimNdc.x * SHIFT_X, this.aimNdc.y * SHIFT_Y), k);

    // 시위: 당길 때는 따라가고, 놓으면 빠르게 풀린다
    const speed = this.drawTarget > this.draw ? 10 : 6;
    this.draw += (this.drawTarget - this.draw) * Math.min(1, dt * speed);
    this.releaseKick = Math.max(0, this.releaseKick - dt * 5);
    if (!this.nocked.visible && this.releaseKick < 0.4) this.nocked.visible = true;
    this.root.position.set(
      this.basePos.x + this.curShift.x,
      this.basePos.y + this.curShift.y,
      this.basePos.z + this.releaseKick * 0.04,
    );
    this.headMat.emissiveIntensity = 0.4 + this.draw * 2.2;
    this.glow.intensity = this.draw * 1.6;
    this.updateString();

    // 날아가는 화살
    for (const a of this.flying) {
      if (a.t < 1) {
        a.t = Math.min(1, a.t + dt / a.dur);
        const tail = a.mesh.position.clone();
        a.mesh.position.lerpVectors(a.from, a.to, a.t);
        const len = Math.max(0.05, tail.distanceTo(a.mesh.position) * 2.5);
        a.trail.position.lerpVectors(tail, a.mesh.position, 0.5);
        a.trail.scale.set(1, len, 1);
        a.trail.lookAt(a.mesh.position);
        a.trail.rotateX(Math.PI / 2);
      } else {
        a.stuckSec += dt;
        (a.trail.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.6 - a.stuckSec * 3);
      }
    }
    const done = this.flying.filter((a) => a.stuckSec > 0.7);
    for (const a of done) {
      this.scene.remove(a.mesh);
      this.scene.remove(a.trail);
      a.mesh.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
      });
      a.trail.geometry.dispose();
    }
    if (done.length) this.flying = this.flying.filter((a) => !done.includes(a));
  }

  dispose() {
    this.disposed = true;
    this.camera.remove(this.root);
    for (const a of this.flying) {
      this.scene.remove(a.mesh);
      this.scene.remove(a.trail);
    }
    this.flying = [];
    try {
      void this.audio?.close();
    } catch {
      // ignore
    }
  }
}
