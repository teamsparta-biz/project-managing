---
name: padlet-share
description: "패들렛 보드에 초대해야 할 강사·기술튜터 이메일을 ax-hub에서 회차별로 조회해 이름과 함께 줄바꿈으로 구분된 목록으로 보여줍니다. /padlet-share 명령으로 실행합니다."
argument-hint: "[기업명:기업명] [교육명:교육명]"
user-invocable: true
allowed-tools: mcp__ax-hub__query_sql
---

# 패들렛 공유용 이메일 목록 조회 스킬

`/padlet-share` 실행 시, 해당 교육에 배정된 강사·기술튜터의 이메일을 ax-hub에서 **회차별로** 조회해, 누구의 이메일인지 알 수 있도록 이름과 함께 회차마다 구분해 줄바꿈(개행)으로 보여줍니다. 이 목록은 패들렛 보드의 회차별 섹션 초대창에 붙여넣는 용도입니다.

---

## 1단계: 인자 파싱 및 course 조회

명령 인자에서 `기업명:`, `교육명:`을 추출합니다.

```sql
SELECT
  c.id AS course_id,
  c.title AS training_name
FROM courses c
JOIN deals d ON c.deal_id = d.id
JOIN clients cl ON d.client_id = cl.id
WHERE cl.name = '기업명'
ORDER BY c.lecture_start DESC NULLS LAST
LIMIT 5;
```

- 결과가 1건이면 해당 `course_id`를 사용합니다.
- 여러 건이면 `교육명`(부분 일치)으로 좁히고, 그래도 여러 건이면 사용자에게 어떤 교육인지 물어봅니다.
- `기업명`이 없으면 사용자에게 기업명 또는 교육명을 질문합니다.

---

## 2단계: 회차별 배정 강사·기술튜터 이메일 조회

1단계의 `course_id`로 아래 SQL을 실행합니다. 회차(`round_number`) 단위로 배정된 인원의 이름·이메일을 가져옵니다.

```sql
SELECT DISTINCT cr.round_number, i.name, i.email
FROM course_rounds cr
JOIN course_sessions cs ON cs.round_id = cr.id
JOIN assignments a ON a.course_session_id = cs.id
JOIN instructors i ON a.instructor_id = i.id
WHERE cr.course_id = 'course_id'
ORDER BY cr.round_number, i.name;
```

- `DISTINCT`로 같은 회차 내 중복은 제거됩니다 (같은 사람이 같은 회차의 여러 세션에 배정돼도 한 번만 나옵니다). 단, 같은 사람이 여러 회차에 배정된 경우 회차마다 각각 표시합니다.
- `round_number` 기준으로 그룹핑해 회차별로 묶어 출력을 준비합니다.
- `email`이 없는 인원은 해당 회차 목록에서 제외하고, 몇 명이 제외됐는지 사용자에게 안내합니다.

---

## 3단계: 결과 출력

회차별로 구분하여 아래 형식으로 출력합니다. 이름과 이메일도 각각 줄을 바꿔 표시합니다.

```
{교육명} 패들렛 초대 대상 (회차별)

[{round_number}회차]
{이름1}
{이메일1}
{이름2}
{이메일2}

[{round_number}회차]
{이름3}
{이메일3}
{이름4}
{이메일4}
```

- 이메일이 없는 인원이 있었다면 아래처럼 별도로 안내합니다:

```
※ 이메일 정보가 없어 제외된 인원: {이름1}({round_number}회차), {이름2}({round_number}회차)
```

- 배정된 강사·기술튜터가 아예 없으면 "배정된 인원이 없습니다"라고 안내합니다.

---

## 사용 예시

```
/padlet-share 기업명:뉴트리원 교육명:AI 활용 실무
→ course 조회 → 회차별 배정 인원 이름·이메일 조회 → 회차별로 묶어 이름과 함께 줄바꿈 목록 출력
```

---

## 주의사항

- `mcp__ax-hub__query_sql`은 SELECT만 허용됩니다 (read-only).
- 이 스킬은 이메일 목록만 조회해 보여줍니다. 패들렛에 실제로 초대하는 작업은 하지 않습니다.
- 교육이 여러 건 검색되면 반드시 선택을 받고 진행합니다.
