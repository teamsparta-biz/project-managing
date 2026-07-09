---
name: parking-check-inquiry
description: "교육 진행 전 고객사 담당자에게 강사·기술튜터 주차 지원이 가능한지 확인하는 메일 초안을 작성합니다. /parking-check-inquiry 명령으로 실행하며, ax-hub에서 일자별 강사·튜터 연락처·차량번호를 조회해 인원정보/일자별 배정 표를 만들고, 정보를 수집해 Gmail 임시보관함에 저장합니다."
argument-hint: "[기업명:기업명] [교육명:교육명] [담당자이메일:이메일]"
user-invocable: true
allowed-tools: Read, Write, Glob, mcp__ax-hub__query_sql
---

# 주차 지원 확인 메일 초안 생성 스킬

사용자가 `/parking-check-inquiry`를 실행하면, **교육 진행 전 고객사 담당자에게 강사·기술튜터 주차 지원이 가능한지 확인하는 메일** 초안을 작성합니다.
연락처·차량번호·일자별 강사/튜터 배정은 **ax-hub DB에서 직접 조회**해 채우고, 사용자에게는 수신자 정보만 확인받습니다.
사용자가 '검수 완료'라고 입력하면 Gmail 임시보관함에 저장합니다.

---

## 전체 흐름 요약

```
[0단계] 발신자 이름 자동 조회
    ↓
[1단계] 인자에서 기업명/교육명 파싱 → ax-hub에서 course 조회
    ↓
[2단계] ax-hub에서 일자별 강사·튜터 배정 + 연락처·차량번호 조회
    ↓
[3단계] 수신자 정보 수집 (이름·직함·이메일, 한 번에)
    ↓
[4단계] 인원정보 표 + 일자별 배정 표로 메일 초안 출력
    → 사용자 확인 및 수정 요청 반영
    ↓
[5단계] 사용자가 "검수 완료"라고 입력하면 Gmail 임시보관함에 저장 (HTML 표 포함)
    → 완료
```

---

## 0단계: 발신자 이름 자동 조회

1. `G:\내 드라이브\Project_managing_tool\.env` 파일을 Read 도구로 읽어 `USER_EMAIL` 값을 파싱합니다.
2. `USER_EMAIL`이 있으면 아래 SQL로 ax-hub에서 display_name을 조회합니다:

```sql
SELECT display_name FROM profiles
WHERE email = 'USER_EMAIL'
LIMIT 1;
```

3. 조회된 `display_name`을 `{발신자이름}`으로 사용합니다.
4. `USER_EMAIL`이 없거나 조회 결과가 없으면 사용자에게 이름을 질문합니다.

---

## 1단계: 인자 파싱 및 course 조회

명령 인자에서 `기업명:`, `교육명:`, `교육일정:`, `담당자이메일:`을 추출합니다. (웹앱 버튼은 이 형식으로 명령을 복사합니다.)

`기업명`이 있으면 아래 SQL로 course를 찾습니다 (교육명이 있으면 함께 필터링해 동명 기업의 여러 교육 중 정확히 매칭):

```sql
SELECT
  c.id AS course_id,
  c.title AS training_name,
  c.status AS course_status
FROM courses c
JOIN deals d ON c.deal_id = d.id
JOIN clients cl ON d.client_id = cl.id
WHERE cl.name = '기업명'
ORDER BY c.lecture_start DESC NULLS LAST
LIMIT 5;
```

- 결과가 1건이면 해당 `course_id` 사용.
- 여러 건이면 `교육명`(부분 일치)으로 좁히고, 그래도 여러 건이면 사용자에게 어떤 교육인지 물어봅니다.
- `기업명`이 없거나 course를 찾지 못하면 2단계를 건너뛰고, 인자로 받은 `교육일정` 텍스트만으로 4단계 메일을 작성합니다(이 경우 연락처·차량번호 없이 일정만 안내).

---

## 2단계: 일자별 강사·튜터 배정 + 연락처·차량번호 조회

1단계에서 얻은 `course_id`로 아래 SQL을 실행해 **날짜별** 강사/튜터 이름을 조회합니다.

```sql
SELECT
  cs.date,
  array_agg(DISTINCT i.name) FILTER (
    WHERE left(a.qualification_id::text, 8) IN
      ('a7a605e9','888ee72c','07ecdab5','e39eeef7','ecdd7d85','7db139f7','2647f764')
  ) AS instructors,
  array_agg(DISTINCT i.name) FILTER (
    WHERE left(a.qualification_id::text, 8) IN
      ('30976fac','a0af4d4f','fc59bde4')
  ) AS tutors
FROM course_sessions cs
JOIN course_rounds cr ON cs.round_id = cr.id
LEFT JOIN assignments a ON a.course_session_id = cs.id
LEFT JOIN instructors i ON a.instructor_id = i.id
WHERE cr.course_id = 'course_id'
GROUP BY cs.date
ORDER BY cs.date;
```

이 결과에서 등장하는 **모든 강사·튜터 이름의 중복 없는 집합**을 모은 뒤, 아래 SQL로 연락처·차량 정보를 한 번에 조회합니다.

```sql
SELECT name, phone, car_model, car_color, car_plate
FROM instructors
WHERE name IN (/* 위에서 모은 이름들 */);
```

- `car_plate`가 있으면 차량 정보로 사용. `car_model`/`car_color`는 메일에는 사용하지 않습니다 ([[feedback_dedupe_person_tables]] 확인 결과 차종·색깔은 생략, 차량번호만 유지).
- `car_plate`가 없으면 "대중교통 이용"으로 표시합니다.
- `phone`이 없으면 해당 인원 연락처 칸은 공란으로 둡니다.
- 강사/튜터가 여러 날짜에 반복 배정된 경우에도, 인원 정보는 **사람당 1행만** 만듭니다 (중복 제거).

---

## 3단계: 수신자 정보 수집

인자로 제공되지 않은 항목은 **한 번에 모아서** 질문합니다.

| 항목 | 필수 여부 | 설명 |
|------|----------|------|
| 수신자 이름 | 필수 | 고객사 담당자 이름 |
| 수신자 직함 | 필수 | 담당자 직함 |
| 수신자 이메일 | 권장 | Gmail 임시저장 수신자 주소. 없으면 '검수 완료' 직전에 요청 |

> 발신자 이름은 0단계 조회값 사용. 기업명·교육명은 1단계 인자값 사용.

---

## 4단계: 메일 초안 출력

**제목**: `[팀스파르타] 주차 지원 관련 문의드립니다`

**본문 형식** (2단 표 구조 — [[feedback_dedupe_person_tables]] 규칙 적용, 인원 반복 시 연락처·차량번호를 일자마다 다시 쓰지 않음):

```
{수신자이름} {수신자직함}님, 안녕하세요.
팀스파르타 {발신자이름}입니다.

{교육명} 교육 진행 시 강사 및 기술튜터가 자차로 방문하는 일정이 있어, 주차 지원 가능 여부를 문의드립니다.

[인원 정보]
| 구분 | 성명 | 연락처 | 차량번호 |
|---|---|---|---|
(2단계에서 조회한 사람당 1행, 강사/튜터 구분 표시, 차량 없으면 "대중교통 이용")

[일자별 배정]
| 일정 | 강사 | 튜터 |
|---|---|---|
(2단계 날짜별 결과 — 날짜는 "M/D(요일)" 형식, 강사·튜터 이름만 쉼표로 나열)

주차 지원이 가능한지, 가능하시다면 별도로 준비해야 할 사항이 있는지 확인 부탁드립니다.

감사합니다.
{발신자이름} 드림
```

- course를 찾지 못해 2단계를 건너뛴 경우, 표 없이 인자로 받은 `교육일정` 문자열만 문장에 넣어 안내합니다.
- 분반(A반/B반 등)이 여러 개인 교육이면 일자별 배정 표에 분반 열을 추가합니다.

메일 초안 출력 후 반드시 아래 문구로 마무리합니다:

> **수정할 내용이 있으면 말씀해 주세요. 내용이 확인되셨으면 "검수 완료"라고 입력해 주시면 Gmail 임시보관함에 저장합니다.**

사용자가 수정을 요청하면 반영 후 다시 출력하고 같은 문구로 대기합니다.

---

## 5단계: Gmail 임시보관함 저장

사용자가 "검수 완료"를 입력하면:

1. 수신자 이메일이 없는 경우 이 시점에 요청합니다.
2. Gmail `create_draft` 도구로 임시보관함에 저장합니다. `htmlBody`에는 인원정보/일자별 배정 표를 실제 HTML `<table>`로 만들어 포함하고, `body`에는 텍스트 버전을 함께 넣습니다.
3. 저장 완료 후 아래 메시지를 출력합니다:

> **✅ 메일 초안이 Gmail 임시보관함에 저장되었습니다. 추가 수정이 필요하면 말씀해 주세요.**

Gmail 저장 실패 시 오류 내용을 안내하고 재시도 여부를 묻습니다.

---

## 사용 예시

```
/parking-check-inquiry 기업명:뉴트리원 교육명:AI 활용 실무 담당자이메일:daniel@nutrione.co.kr
→ ax-hub 조회 → 인원정보/일자별 배정 표 출력 → 수신자 이름·직함 질문 → "검수 완료" → Gmail 임시보관함 저장
```

```
/parking-check-inquiry
→ 기업명 없음 → 사용자에게 기업명 또는 교육 일정 직접 질문 후 동일 단계 진행
```

---

## 주의사항

- `mcp__ax-hub__query_sql`은 SELECT만 허용됩니다 (read-only).
- 인원 정보는 사람당 1행만 — 여러 날짜에 반복 배정돼도 연락처·차량번호를 중복 나열하지 않습니다 ([[feedback_dedupe_person_tables]]).
- 차종·색깔은 메일에 포함하지 않습니다. 차량번호만 표시합니다.
- 메일 초안은 사용자 확인 전까지 Gmail에 저장하지 않습니다 — 출력과 동시에 자동 저장 금지.
- 수정 요청 시 해당 메일만 재출력하고, 확인 문구로 다시 대기.
- 입력되지 않은 항목은 추가로 묻지 않고 해당 항목 자체를 메일에서 생략 (빈 칸이나 "(미정)" 등으로 채우지 않음).
- 파일 저장은 하지 않음 — Gmail 임시보관함 저장 외에는 출력만 제공.
