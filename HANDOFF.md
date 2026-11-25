# 인계 문서 (HANDOFF)

이 저장소는 원본 `eyehandcordinationgame`을 복사해서 **손 추적 치료 모드**를 추가하는 작업 공간이에요. 원본 저장소는 건드리지 않았어요.

## 완료된 것

| 항목 | 위치 |
|---|---|
| 훈련 종료 시 결과 대신 "일시정지 0:00"이 뜨던 버그 수정 | `src/App.tsx` `finishGameSession` |
| 레이저 트랙(H) 채점: 무조건 PERFECT → 경로 이탈 평균으로 PERFECT/GOOD, 반응시간에서 그리는 시간 제외 | `src/game/rules.ts` `gradeLaserTrace`, `src/App.tsx` |
| 복합미션(G) 빨간 테두리: Lv1~4 항상, Lv5+ 1초만 표시 + 화면 위 "찾을 과녁" 안내 | `src/game/rules.ts` `computeMissionBracketVisualState`, `src/App.tsx` `gMissionHud` |
| 손 모드 순수 로직 (레벨표 10단계, 떨림 보정, 도달 범위 보정, 과녁 배치, 집기·뻗기 감지, 반응/움직임시간 분리, 경로 효율, 지나침, 따라 그리기 채점, 자동 난이도, 피로 감지, 실물 과제 추천, 아동 프로필·기록) | `src/hand/handRules.ts` + 테스트 `src/hand/handRules.test.ts` |
| 웹캠 손 추적 (MediaPipe Hands, 카메라 영상은 화면에 안 보임) | `src/hand/handTracker.ts` |
| 손 치료 모드 화면: 아동 프로필 → 설정 → 팔 뻗기 범위 보정(6초) → 블록 플레이 ↔ 휴식 → 결과 리포트(CSV, 따라그리기 시트 인쇄, 회기별 추이) | `src/hand/HandTherapyMode.tsx` |
| 메인 메뉴 "손 치료 모드 (웹캠)" 버튼, 손 모드가 열린 동안 3D 렌더링·단축키 정지 | `src/App.tsx` |
| AI 스튜디오 미리보기에서 웹캠을 쓰도록 카메라 권한 선언 | `metadata.json` |
| 3D 맵(원본 51MB + 압축본 16MB)을 외부 `dddd` 저장소 대신 프로젝트 안에 포함, 무기 예비 주소도 제거 → `dddd`를 지워도 맵이 사라지지 않음 | `public/assets/models/map/`, `src/game/glbMapLoader.ts`, `src/game/weaponSystem.ts` |

## 확인한 것

- 단위 테스트 42개 통과 (기존 27 + 손 모드 15), 타입 검사 통과, `vite build` 성공
- 브라우저 자동 플레이(마우스 체험 입력): Lv1, Lv7 두 판을 끝까지 → 결과 리포트·자동 레벨 업 확인
- 가짜 카메라로 웹캠 경로: 손 인식 모델 로딩 → 보정 화면까지 확인 (실제 손 인식은 실제 웹캠으로 확인 필요)
- 3D 게임: 포인터락 상태로 10초 훈련 종료 → 결과 화면 정상 표시

## 남은 것

1. **실제 웹캠과 아이 손으로 확인**: 팔 뻗기 범위 보정, 집기·뻗기 감지 민감도(`isPinching` 35%, `PushDetector` 15%), 양손 모드의 왼손/오른손 판별
2. 타이틀의 "발로란트 전술 사격장" 문구 (상표) 정리

## 테스트 실행

```bash
npm install --legacy-peer-deps
npx tsx --test src/game/rules.test.ts src/hand/handRules.test.ts
npx tsc --noEmit
```

## (참고) 처음 계획할 때 AI 스튜디오용으로 써 둔 프롬프트

```
src/hand/handRules.ts에 손 치료 모드 로직이 이미 있어. 이걸 그대로 써서 다음을 만들어줘.
1) src/hand/handTracker.ts: @mediapipe/tasks-vision HandLandmarker로 웹캠에서 손을 최대 2개 추적. 카메라 영상은 화면에 보여주지 말고, 거울처럼 좌우 반전한 검지 끝 좌표, 손 크기(손목-중지 뿌리 거리), 엄지-검지 거리, 왼손/오른손을 매 프레임 넘겨줘.
2) src/hand/HandTherapyMode.tsx: 전체 화면 2D 캔버스 게임. 순서는 [아동 프로필·설정] → [팔 뻗기 범위 보정 6초(computeReachCalibration)] → [블록 플레이 60~90초 × N, 사이 20초 휴식] → [결과 리포트].
   - 레벨표는 HAND_LEVELS, 과녁 배치 placeReachTarget, 커서 떨림 OneEuroFilter2D, 자석 applyMagnet, 발사 resolveFireRule(머무르기/집기 isPinching/뻗기 PushDetector).
   - 과제: reach, trace(stepTrace), depth(뻗기 필수), choice(buildChoiceOptions), bimanual(양손 설정일 때).
   - Lv5+는 과녁이 0.5초 반짝인 뒤 활성화(LOOK_FIRST_CUE_SEC), 그 전에 들어가면 "기다려요".
   - 명중 후 computeMovementMetrics와 getKpFeedback으로 동작 과정 피드백을 1초 보여줘.
   - AutoDifficulty, FatigueMonitor 사용. 결과는 buildHandSessionSummary로 만들고 CSV 복사, 따라그리기 시트 인쇄, 아동별 기록(appendHandHistory) 추이 그래프를 보여줘.
   - 카메라가 없으면 마우스로 체험(클릭 = 집기/뻗기).
3) App.tsx 메인 메뉴에 "손 치료 모드 (웹캠)" 버튼을 넣고, 누르면 HandTherapyMode를 전체 화면으로 띄워줘. 기존 3D 게임은 그대로 둬.
```

## 동기화 테스트

- 2026-11-25: GitHub → AI 스튜디오 가져오기 확인용 기록
