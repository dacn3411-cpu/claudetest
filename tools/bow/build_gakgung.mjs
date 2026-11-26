// 국궁(각궁) 3D 모델 → GLB 만들기
//   node tools/bow/build_gakgung.mjs  → public/assets/models/weapons/gakgung.glb
//
// 각궁 특징을 따른 원래 디자인 (특정 사진을 베끼지 않음):
// - 반곡(리커브): 줌통에서 뻗은 활 몸(오금)이 쏘는 사람 쪽으로 휘었다가, 끝의 고자가 과녁 쪽으로 다시 꺾인다
// - 아랫장이 윗장보다 조금 길다
// - 안쪽(쏘는 사람 쪽)은 검은 물소뿔, 바깥쪽(과녁 쪽)은 벚나무 껍질(화피) 무늬
// - 가운데 줌통(감싼 손잡이), 고자와 활 몸 사이에 시위가 걸치는 도고지, 끝에 시위를 거는 양냥고자
//
// 좌표: 활 몸은 YZ 평면, +Y 위, 쏘는 사람 쪽 +Z, 과녁 쪽 -Z (화살은 -Z로 날아감). 단위 m, 전체 높이 약 1.2m.
// 시위는 게임에서 당기는 동작을 위해 코드로 그리므로, 시위가 지나는 위치를 빈 노드로 넣는다:
//   string_top / string_bottom (양냥고자), bridge_top / bridge_bottom (도고지), arrow_rest (줌통 화살 자리), nock_point (쉴 때 시위 가운데)

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// GLTFExporter(binary)가 쓰는 FileReader를 Node에서 흉내 낸다
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.();
        this.onload?.({ target: this });
      });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
        this.onloadend?.();
        this.onload?.({ target: this });
      });
    }
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../public/assets/models/weapons/gakgung.glb');

const C = {
  horn: new THREE.Color('#17130F'), // 물소뿔 (안쪽)
  hornHi: new THREE.Color('#2B241D'),
  bark: new THREE.Color('#B9824A'), // 화피 (바깥쪽)
  barkDark: new THREE.Color('#6E4626'),
  barkLight: new THREE.Color('#D9A66A'),
  side: new THREE.Color('#3A2618'),
};

/** 길이 방향으로 단면(너비 w, 두께 t)이 바뀌는 활 몸 튜브. 안쪽(쏘는 사람 쪽)은 뿔, 바깥쪽은 화피 무늬 */
function limbGeometry(curve, segments, widthAt, thickAt, skin = 'limb') {
  const pos = [];
  const col = [];
  const idx = [];
  const RING = 12;
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const p = curve.getPointAt(u);
    const T = curve.getTangentAt(u).normalize();
    // 활 평면(YZ)에 수직인 X가 너비 방향, N은 활 평면 안에서 활 몸에 수직
    const B = new THREE.Vector3(1, 0, 0);
    const N = new THREE.Vector3().crossVectors(B, T).normalize();
    // 쏘는 사람 쪽(+Z)을 향하는 쪽이 안쪽(뿔)
    const bellySign = N.z >= 0 ? 1 : -1;
    const w = widthAt(u);
    const t = thickAt(u);
    for (let j = 0; j < RING; j++) {
      const a = (j / RING) * Math.PI * 2;
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      // 모서리가 살짝 각진 납작한 단면
      const sx = Math.sign(cx) * Math.pow(Math.abs(cx), 0.7);
      const sy = Math.sign(cy) * Math.pow(Math.abs(cy), 0.7);
      const v = p.clone().addScaledVector(B, sx * w * 0.5).addScaledVector(N, sy * t * 0.5);
      pos.push(v.x, v.y, v.z);
      let c;
      if (skin === 'siyah') {
        // 고자: 밝은 뽕나무색, 끝으로 갈수록 조금 진하게
        c = new THREE.Color('#E8D3A2').lerp(new THREE.Color('#C9A46A'), u * 0.6);
      } else if (sy * bellySign > 0.35) {
        c = C.horn.clone().lerp(C.hornHi, Math.max(0, cx) * 0.6);
      } else if (sy * bellySign < -0.35) {
        // 화피: 가로 띠와 점무늬
        const band = 0.5 + 0.5 * Math.sin(u * 70 + Math.sin(u * 13) * 2);
        const speck = Math.sin(u * 517 + j * 3.1) > 0.93 ? 1 : 0;
        c = C.bark.clone().lerp(C.barkLight, band * 0.45).lerp(C.barkDark, speck * 0.8);
      } else {
        c = C.side.clone();
      }
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < RING; j++) {
      const a = i * RING + j;
      const b = i * RING + ((j + 1) % RING);
      const c2 = (i + 1) * RING + j;
      const d = (i + 1) * RING + ((j + 1) % RING);
      idx.push(a, c2, b, b, c2, d);
    }
  }
  // 양 끝 막기
  const capStart = pos.length / 3;
  const p0 = curve.getPointAt(0);
  pos.push(p0.x, p0.y, p0.z);
  col.push(col[0], col[1], col[2]);
  const capEnd = pos.length / 3;
  const p1 = curve.getPointAt(1);
  pos.push(p1.x, p1.y, p1.z);
  const last = segments * RING * 3;
  col.push(col[last], col[last + 1], col[last + 2]);
  for (let j = 0; j < RING; j++) {
    idx.push(capStart, (j + 1) % RING, j);
    const base = segments * RING;
    idx.push(capEnd, base + j, base + ((j + 1) % RING));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const limbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.05, name: 'gakgung-limb' });
const gripMat = new THREE.MeshStandardMaterial({ color: '#8E1B1B', roughness: 0.8, name: 'jumtong-cloth' });
const goldMat = new THREE.MeshStandardMaterial({ color: '#E0B04A', roughness: 0.3, metalness: 0.85, name: 'gold' });
const bridgeMat = new THREE.MeshStandardMaterial({ color: '#5A1E14', roughness: 0.6, name: 'dogoji' });

const bow = new THREE.Group();
bow.name = 'gakgung';

/**
 * 한쪽 장(윗장 sign=+1, 아랫장 sign=-1). len은 장의 길이 배율 (아랫장이 조금 김).
 * 시위가 걸린 모양: 오금은 쏘는 사람 쪽(+Z)으로 휘고, 고자는 과녁 쪽(-Z)으로 꺾인다.
 */
function buildArm(sign, len) {
  const s = (y) => y * len * sign;
  // 오금 (뿔·화피로 된 휘는 부분)
  const limbPts = [
    new THREE.Vector3(0, s(0.07), -0.012),
    new THREE.Vector3(0, s(0.16), 0.004),
    new THREE.Vector3(0, s(0.26), 0.035),
    new THREE.Vector3(0, s(0.35), 0.072),
    new THREE.Vector3(0, s(0.42), 0.1),
  ];
  const limb = new THREE.Mesh(
    limbGeometry(new THREE.CatmullRomCurve3(limbPts), 60, (u) => 0.042 - u * 0.012, (u) => 0.025 - u * 0.008),
    limbMat,
  );
  limb.name = sign > 0 ? 'wit-jang' : 'arae-jang';
  bow.add(limb);

  // 고자: 단단한 끝부분, 과녁 쪽으로 꺾인다 (칼고자 느낌의 납작한 날)
  const siyahPts = [
    new THREE.Vector3(0, s(0.41), 0.098),
    new THREE.Vector3(0, s(0.47), 0.112),
    new THREE.Vector3(0, s(0.525), 0.09),
    new THREE.Vector3(0, s(0.565), 0.045),
    new THREE.Vector3(0, s(0.585), -0.005),
  ];
  const siyahCurve = new THREE.CatmullRomCurve3(siyahPts);
  const siyah = new THREE.Mesh(
    limbGeometry(siyahCurve, 40, (u) => 0.032 - u * 0.012, (u) => 0.024 - u * 0.009, 'siyah'),
    limbMat,
  );
  siyah.name = sign > 0 ? 'goja-top' : 'goja-bottom';
  bow.add(siyah);

  // 도고지: 오금과 고자 사이, 시위가 걸치는 받침
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.016, 0.018), bridgeMat);
  bridge.position.set(0, s(0.43), 0.118);
  bridge.rotation.x = sign * 0.35;
  bridge.name = sign > 0 ? 'dogoji-top' : 'dogoji-bottom';
  bow.add(bridge);

  // 오금과 고자 이음매 금색 띠
  const joint = new THREE.Mesh(new THREE.TorusGeometry(0.019, 0.004, 6, 16), goldMat);
  joint.position.set(0, s(0.41), 0.098);
  joint.rotation.x = Math.PI / 2 - sign * 0.6;
  bow.add(joint);

  // 양냥고자 (시위 거는 끝) 금색 장식
  const tipP = siyahCurve.getPointAt(1);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.011, 10, 8), goldMat);
  tip.position.copy(tipP);
  tip.name = sign > 0 ? 'yangnyang-top' : 'yangnyang-bottom';
  bow.add(tip);

  // 시위 자리 표시 (빈 노드)
  const sNode = new THREE.Object3D();
  sNode.name = sign > 0 ? 'string_top' : 'string_bottom';
  sNode.position.copy(tipP).add(new THREE.Vector3(0, 0, 0.004));
  bow.add(sNode);
  const bNode = new THREE.Object3D();
  bNode.name = sign > 0 ? 'bridge_top' : 'bridge_bottom';
  bNode.position.set(0, s(0.43), 0.128);
  bow.add(bNode);
}

buildArm(1, 1.0);
buildArm(-1, 1.06); // 아랫장이 조금 길다

// 줌통: 붉은 천으로 감싼 손잡이 + 금색 띠
const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.02, 0.14, 16), gripMat);
grip.scale.set(1.15, 1, 1.05);
grip.position.set(0, 0, -0.012);
grip.name = 'jumtong';
bow.add(grip);
for (const y of [-0.066, 0.066]) {
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0215, 0.0215, 0.01, 16), goldMat);
  band.scale.set(1.15, 1, 1.05);
  band.position.set(0, y, -0.012);
  bow.add(band);
}
// 줌통 위 화살 자리 (작은 가죽 덧댐)
const rest = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.02, 0.03), bridgeMat);
rest.position.set(0.02, 0.085, -0.012);
bow.add(rest);
const restNode = new THREE.Object3D();
restNode.name = 'arrow_rest';
restNode.position.set(0.012, 0.09, -0.012);
bow.add(restNode);

// 쉴 때 시위 가운데 (도고지 사이 직선 위)
const nock = new THREE.Object3D();
nock.name = 'nock_point';
nock.position.set(0, 0.09, 0.128);
bow.add(nock);

const scene = new THREE.Scene();
scene.add(bow);

new GLTFExporter().parse(
  scene,
  (result) => {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, Buffer.from(result));
    const box = new THREE.Box3().setFromObject(bow);
    const size = box.getSize(new THREE.Vector3());
    console.log(`wrote ${OUT} (${Buffer.from(result).length} bytes), size ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)} m`);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
  { binary: true },
);
