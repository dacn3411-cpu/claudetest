# 인계 문서 (HANDOFF)

이 저장소는 원본 `eyehandcordinationgame`을 복사해서 **기존 3D 게임을 웹캠 손 추적으로 조작**하도록 바꾼 작업 공간이에요. 원본 저장소는 건드리지 않았어요.

## 지금 게임 흐름

1. 메인 메뉴 → **손 인식 테스트**: "카메라 켜고 손 인식 테스트 시작" → 화면의 점 5개(가운데·왼쪽·오른쪽·위·아래)에 검지를 0.5초씩 대면 통과
   - 통과하면 그동안의 손가락 위치로 팔 뻗기 범위를 보정하고 **게임 시작 버튼이 켜져요** (통과 전에는 잠김)
2. 난이도 **1~5단계** 선택 (모드 선택 없음)
3. 게임: 검지 끝이 조준점, **과녁에 0.5초 대면 명중**, 손을 **화면 좌우 가장자리**에 두면 시점이 그쪽으로 돌아요 (제자리 기준 **좌우 ±90°**). **WASD 이동**은 그대로예요.
   - 레이저 트랙: 시작점에 0.5초 → 손가락으로 따라 그리기
   - 손이 0.3초 이내로 잠깐 끊겨도 머무르기 진행은 유지

## 바뀐 것

| 항목 | 위치 |
|---|---|
| 손 조작 규칙 (조준점 변환, 가장자리 회전, 0.5초 머무르기, 손 인식 테스트) + 테스트 | `src/hand/handControl.ts`, `src/hand/handControl.test.ts` |
| 손 인식 테스트 패널 (메뉴) | `src/hand/HandTestPanel.tsx` |
| 국궁(각궁) 모델: **Blender(bpy 4.2)**로 모델링 — 서브디비전·베벨, 코드로 만든 텍스처(화피 껍질눈, 고자 나뭇결, 줌통 천 짜임), 물소뿔 광택 → `public/assets/models/weapons/gakgung.glb` (800KB). 다시 만들기: `venv/bin/python tools/bow/build_gakgung_blender.py` (Blender 없을 때 간단한 버전: `node tools/bow/build_gakgung.mjs`) | `tools/bow/` |
| 활 쏘기 손동작: **엄지·검지 붙이고 나머지 손가락 주먹 → 시위 당김(1.2초에 최대) → 엄지·검지 떼면 발사**. 조준점은 손바닥 중심. 1~4단계는 당긴 정도와 상관없이 곧게(낙차 없이) 날아가 바로 판정, **5단계는 당긴 정도에 따라 탄속 16~60m/s + 중력 낙차**로 날아가 맞은 곳에서 판정. 레이저 트랙만 시작점에 0.5초 대면 따라 그리기 | `src/hand/handControl.ts` (`BowGesture`, `arrowLaunchSpeed`), `src/game/bowRig.ts` (`releaseBallistic`), `src/App.tsx` |
| 손 인식 테스트에 "활 쏘기 연습" 단계 추가 (점 5개 → 당겼다 떼기) | `src/hand/HandTestPanel.tsx` |
| 맵 1.5배 확대 (사람 키 그대로, 모든 모드), 걷는 속도 7→8.5m/s | `src/game/glbMapLoader.ts` `ATOWER_MAP_SCALE_BOOST` 1.4→2.1 |
| 총 숨김·발사 막기, 가운데 십자선 숨김 | `src/game/weaponSystem.ts` `setHiddenByMode`, `src/App.tsx` |
| 웹캠 손 추적 (MediaPipe, 카메라 영상은 안 보임) | `src/hand/handTracker.ts` |
| 떨림 보정·팔 뻗기 범위 보정 수학 | `src/hand/handRules.ts` |
| 메뉴: 모드 카드 → 손 인식 테스트, 난이도 1~5, 시작 버튼 잠금 / 게임 중 손 조작 루프·커서·가장자리 표시 / 수평 시야 90°→100° / 무기 버튼 막대 숨김 / 마우스 잠금 안 함 | `src/App.tsx` |
| 설정 창: 모드 선택 제거, 난이도 1~5 | `src/components/Modals.tsx` |
| MODE 1 = 손 조작 모드: 좌우 ±90°, WASD 가능, 조이스틱 숨김, 과녁이 좌우 ±90° 안(옆쪽 포함)·보이는 곳에만 | `src/game/rules.ts`, `src/game/entities.ts` |
| 맵 가운데(시작 위치 바로 앞) 보급품 묶음(천막·화물 상자·금속 상자) 제거 | `src/game/glbMapLoader.ts` `removeCenterCargoProps` |
| 3D 맵 파일을 프로젝트 안에 포함 + 못 읽으면 `dddd` 저장소에서 받기 | `public/assets/models/map/`, `src/game/glbMapLoader.ts` |
| 종료 시 "일시정지 0:00" 버그, 레이저 트랙 채점, 복합미션 테두리 | 이전 커밋 |
| 2D 손 치료 모드 | 삭제 |

## 확인한 것

- 단위 테스트 34개 통과, 타입 검사 통과, `vite build` 성공
- 브라우저 자동 테스트(가짜 손가락 위치 주입): 테스트 통과 → 시작 버튼 켜짐 → 과녁 0.5초 조준으로 점수 상승 → 오른쪽 가장자리에서 -90°까지 회전 후 멈춤, 왼쪽으로 복귀 → W키 이동 → 마우스 잠금 없음

## 남은 것

1. **실제 웹캠과 손으로 확인**: 가장자리 회전 속도(초당 최대 75°), 머무르기 0.5초 느낌, 보정 점 위치
2. 게임 설명·조작 방법 창의 문구가 아직 예전(모드 4개, 10단계, 마우스) 기준
3. 타이틀의 "발로란트 전술 사격장" 문구 (상표) 정리
4. AI 스튜디오에서 맵을 보려면 `dddd` 저장소를 공개로 유지

## 테스트 실행

```bash
npm install --legacy-peer-deps
npx tsx --test src/game/rules.test.ts src/hand/handControl.test.ts
npx tsc --noEmit
```

자동 테스트용 디버그: 브라우저 콘솔에서 `__ehmDebug.handFakeRunning()`, `__ehmDebug.handInject(x, y)` (거울 화면 이미지 좌표 0~1), `__ehmDebug.probeAt(ndcX, ndcY)`, `__ehmDebug.pickAt(ndcX, ndcY)`
