---
name: tutor-info-share
description: "남은 교육 일자에 대한 강사·기술튜터의 연락처와 차량번호를 ax-hub DB에서 조회해 화면에 표로 보여줍니다. /tutor-info-share 명령으로 실행하며, 메일 작성이나 별도 저장 없이 조회 결과만 출력합니다."
argument-hint: "[기업명:기업명] [교육명:교육명]"
user-invocable: true
allowed-tools: Read, mcp__ax-hub__query_sql
---

# 튜터정보전달 조회 스킬

사용자가 `/tutor-info-share`를 실행하면, **오늘 이후 남은 교육 일자**에 배정된 강사·기술튜터의 **연락처와 차량번호**를 ax-hub DB에서 조회해 표로 출력합니다.
메일 초안 작성이나 Gmail 저장은 하지 않고, 조회 결과를 대화창에 바로 보여주는 것으로 끝나는 조회 전용 스킬입니다.

---

## 전체 흐름 요약

```
[1단계] 인자에서 기업명/교육명 파싱 → ax-hub에서 course 조회
    ↓
[2단계] ax-hub에서 오늘 이후 날짜의 강사·튜터 배정 + 연락처·차량번호 조회
    ↓
[3단계] 인원정보 표 + 일자별 배정 표로 결과 출력
    → 완료 (메일 작성/저장 없음)
```

---

## 1단계: 인자 파싱 및 course 조회

명령 인자에서 `기업명:`, `교육명:`을 추출합니다. (웹앱 "튜터정보전달" 버튼은 이 형식으로 명령을 복사합니다.)

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
- `기업명`이 없으면 사용자에게 기업명(및 필요 시 교육명)을 질문합니다.
- course를 찾지 못하면 오류를 안내하고 종료합니다.

---

## 2단계: 남은 일자의 강사·튜터 배정 + 연락처·차량번호 조회

1단계에서 얻은 `course_id`로 아래 SQL을 실행해 **오늘 이후(오늘 포함) 날짜**의 강사/튜터 이름을 조회합니다.

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
  AND cs.date >= CURRENT_DATE
GROUP BY cs.date
ORDER BY cs.date;
```

- 결과가 없으면 "남은 교육 일자가 없습니다"라고 안내하고 종료합니다.

이 결과에서 등장하는 **모든 강사·튜터 이름의 중복 없는 집합**을 모은 뒤, 아래 SQL로 연락처·차량 정보를 한 번에 조회합니다.

```sql
SELECT name, phone, car_plate
FROM instructors
WHERE name IN (/* 위에서 모은 이름들 */);
```

- `car_plate`가 있으면 차량번호로 표시. 없으면 "대중교통 이용"으로 표시합니다.
- `phone`이 없으면 해당 인원 연락처 칸은 공란으로 둡니다.
- 강사/튜터가 여러 날짜에 반복 배정된 경우에도, 인원 정보는 **사람당 1행만** 만듭니다 (중복 제거, [[feedback_dedupe_person_tables]] 규칙과 동일).

---

## 3단계: 결과 출력

아래 형식으로 대화창에 출력하고 종료합니다 (메일 작성이나 Gmail 저장은 하지 않음):

```
📋 {기업명} {교육명} — 남은 교육 일자 강사·튜터 정보

[인원 정보]
| 구분 | 성명 | 연락처 | 차량번호 |
|---|---|---|---|
(2단계에서 조회한 사람당 1행, 강사/튜터 구분 표시, 차량 없으면 "대중교통 이용")

[일자별 배정]
| 일정 | 강사 | 튜터 |
|---|---|---|
(2단계 날짜별 결과 — 날짜는 "M/D(요일)" 형식, 강사·튜터 이름만 쉼표로 나열)
```

- 분반(A반/B반 등)이 여러 개인 교육이면 일자별 배정 표에 분반 열을 추가합니다.

---

## 사용 예시

```
/tutor-info-share 기업명:뉴트리원 교육명:AI 활용 실무
→ ax-hub 조회 → 남은 일자 인원정보/일자별 배정 표 출력 → 종료
```

```
/tutor-info-share
→ 기업명 없음 → 사용자에게 기업명(및 교육명) 질문 후 동일 단계 진행
```

---

## 주의사항

- `mcp__ax-hub__query_sql`은 SELECT만 허용됩니다 (read-only).
- 인원 정보는 사람당 1행만 — 여러 날짜에 반복 배정돼도 연락처·차량번호를 중복 나열하지 않습니다 ([[feedback_dedupe_person_tables]]).
- 지난 날짜(오늘 이전)는 조회 대상에서 제외합니다 — "남은 교육 일자" 기준.
- 메일 초안 작성, Gmail 저장, 파일 저장은 하지 않습니다 — 조회 결과 출력만 제공합니다.
