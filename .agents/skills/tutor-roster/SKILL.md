---
name: tutor-roster
description: "교육의 강사·기술튜터 이름·연락처·차량번호와 일자별 참여 배정을 ax-hub DB에서 조회해 화면에 표로 보여줍니다. /tutor-roster 명령으로 실행하며, 메일 작성이나 별도 저장 없이 조회 결과만 출력합니다."
argument-hint: "[기업명:기업명] [교육명:교육명]"
user-invocable: true
allowed-tools: Read, mcp__ax-hub__query_sql
---

# 강사·튜터 명단 조회 스킬

사용자가 `/tutor-roster`를 실행하면, 해당 교육의 **강사·기술튜터 이름·연락처·차량번호**와 **일자별로 누가 참여하는지**를 ax-hub DB에서 조회해 표로 출력합니다.
메일 초안 작성이나 Gmail 저장은 하지 않고, 조회 결과를 대화창에 바로 보여주는 것으로 끝나는 조회 전용 스킬입니다.

> **tutor-info-share와 차이**: tutor-info-share는 연락처만(차량번호 제외, 남은 일자만) 보여줍니다 ([[feedback_tutor_info_no_car]]). 이 스킬은 차량번호까지 포함하고, 지난 일자를 포함한 **교육 전체 일정**을 대상으로 합니다.

---

## 전체 흐름 요약

```
[1단계] 인자에서 기업명/교육명 파싱 → ax-hub에서 course 조회
    ↓
[2단계] ax-hub에서 일자별 강사·튜터 배정 조회
    ↓
[3단계] 등장 인원의 연락처·차량번호 조회 (사람당 1행)
    ↓
[4단계] 인원정보 표 + 일자별 배정 표로 결과 출력
    → 완료 (메일 작성/저장 없음)
```

---

## 1단계: 인자 파싱 및 course 조회

명령 인자에서 `기업명:`, `교육명:`을 추출합니다.

```sql
SELECT c.id AS course_id, c.title AS training_name
FROM courses c
JOIN deals d ON c.deal_id = d.id
JOIN clients cl ON d.client_id = cl.id
WHERE cl.name ILIKE '%{기업명}%'
ORDER BY c.lecture_start DESC NULLS LAST
LIMIT 5;
```

- 결과가 1건이면 해당 `course_id` 사용.
- 여러 건이면 `교육명`(부분 일치)으로 좁히고, 그래도 여러 건이면 사용자에게 어떤 교육인지 물어봅니다.
- `기업명`이 없으면 사용자에게 기업명(및 필요 시 교육명)을 질문합니다.
- course를 찾지 못하면 오류를 안내하고 종료합니다.

---

## 2단계: 일자별 강사·튜터 배정 조회

1단계에서 얻은 `course_id`로 아래 SQL을 실행해 **날짜별**(지난 일자 포함, 교육 전체 일정) 강사/튜터 이름을 조회합니다.

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

- 결과가 없으면 "이 교육에는 등록된 일정이 없습니다"라고 안내하고 종료합니다.
- 강사·튜터 배정이 모두 없는 날짜는 "(미배정)"으로 표시할 수 있도록 그대로 둡니다.

---

## 3단계: 인원 연락처·차량번호 조회

2단계 결과에서 등장하는 **모든 강사·튜터 이름의 중복 없는 집합**을 모은 뒤, 아래 SQL로 연락처·차량번호를 한 번에 조회합니다.

```sql
SELECT name, phone, car_plate
FROM instructors
WHERE name IN (/* 위에서 모은 이름들 */);
```

- 먼저 이 쿼리를 실행해 실제로 값이 오는지 확인합니다. ax-hub의 컬럼 접근 권한은 시점에 따라 열리고 닫힐 수 있으므로 ([[project_axhub_phone_blocked]]), `permission denied` 오류가 나면 해당 컬럼(phone 또는 car_plate)은 조회 불가로 안내하고 나머지 컬럼만으로 계속 진행합니다.
- `phone`이 없으면 연락처 칸은 "(연락처 없음)", `car_plate`가 없으면 차량번호 칸은 "(차량 없음)"으로 표시합니다.
- 강사·튜터가 여러 날짜에 반복 배정돼도 인원 정보는 **사람당 1행만** 만듭니다 (중복 제거).

---

## 4단계: 결과 출력

두 개의 표로 나눠 출력하고 종료합니다 (메일 작성이나 Gmail 저장은 하지 않음):

```
📋 {기업명} {교육명} — 강사·튜터 명단

[인원 정보]
| 구분 | 성명 | 연락처 | 차량번호 |
|---|---|---|---|
(3단계에서 조회한 사람당 1행, 강사/튜터 구분 표시)

[일자별 참여]
| 일정 | 강사 | 튜터 |
|---|---|---|
(2단계 날짜별 결과 — 날짜는 "M/D(요일)" 형식, 이름만 쉼표로 나열. 배정 없으면 "(미배정)")
```

- 분반(A반/B반 등)이 여러 개인 교육이면 일자별 참여 표에 분반 열을 추가합니다.

---

## 사용 예시

```
/tutor-roster 기업명:삼성생명 교육명:신입사원 AI리더십
→ ax-hub 조회 → 인원정보/일자별 참여 표 출력 → 종료
```

```
/tutor-roster
→ 기업명 없음 → 사용자에게 기업명(및 교육명) 질문 후 동일 단계 진행
```

---

## 주의사항

- `mcp__ax-hub__query_sql`은 SELECT만 허용됩니다 (read-only).
- 인원 정보는 사람당 1행만 — 여러 날짜에 반복 배정돼도 연락처·차량번호를 중복 나열하지 않습니다 ([[feedback_dedupe_person_tables]]).
- phone/car_plate 컬럼 접근이 막혀 있으면(권한 오류) 그 사실을 그대로 안내하고, 가능한 컬럼만으로 표를 완성합니다 — 임의로 값을 지어내지 않습니다.
- 메일 초안 작성, Gmail 저장, 파일 저장은 하지 않습니다 — 조회 결과 출력만 제공합니다.
- 지난 일자도 포함한 교육 전체 일정을 대상으로 합니다 (tutor-info-share는 남은 일자만 대상인 것과 다름).
