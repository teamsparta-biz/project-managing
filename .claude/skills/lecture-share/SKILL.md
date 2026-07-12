---
name: lecture-share
description: "노션 교안에 초대해야 할 강사·기술튜터 이메일을 ax-hub에서 조회해 중복 없이 쉼표로 구분된 목록으로 보여줍니다. /lecture-share 명령으로 실행하며, 웹앱의 '교안 공유' 버튼을 누르면 명령이 복사됩니다."
argument-hint: "[기업명:기업명] [교육명:교육명]"
user-invocable: true
allowed-tools: mcp__ax-hub__query_sql
---

# 교안 공유용 이메일 목록 조회 스킬

`/lecture-share` 실행 시, 해당 교육에 배정된 **강사·기술튜터 전원**의 이메일을 ax-hub에서 조회해 중복을 제거하고 쉼표(,)로 구분된 목록으로 보여줍니다. 이 목록은 노션 교안 페이지의 공유 초대창에 붙여넣는 용도입니다.

---

## 1단계: 인자 파싱 및 course 조회

명령 인자에서 `기업명:`, `교육명:`을 추출합니다. (웹앱 버튼은 이 형식으로 명령을 복사합니다.)

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

## 2단계: 배정된 강사·기술튜터 이메일 조회

1단계의 `course_id`로 아래 SQL을 실행합니다. 강사·기술튜터를 구분하지 않고 배정된 전원의 이메일을 한 번에 가져옵니다.

```sql
SELECT DISTINCT COALESCE(i.notion_email, i.email) AS email
FROM course_rounds cr
JOIN course_sessions cs ON cs.round_id = cr.id
JOIN assignments a ON a.course_session_id = cs.id
JOIN instructors i ON a.instructor_id = i.id
WHERE cr.course_id = 'course_id'
  AND COALESCE(i.notion_email, i.email) IS NOT NULL;
```

- 이메일은 `notion_email`이 있으면 우선 사용하고, 없으면 `email`을 사용합니다.
- `DISTINCT`로 중복은 자동 제거됩니다 (한 사람이 여러 회차에 배정돼도 이메일은 한 번만 나옵니다).
- `notion_email`과 `email`이 모두 없는 인원은 목록에서 제외하고, 몇 명이 제외됐는지 사용자에게 안내합니다.

---

## 3단계: 결과 출력

아래 형식으로 출력합니다.

```
{교육명} 교안 공유 대상 이메일 ({N}명)

{이메일1},{이메일2},{이메일3}
```

- 이메일 사이는 쉼표(,)로만 구분하고 공백을 넣지 않습니다.
- 이메일이 없는 인원이 있었다면 아래처럼 별도로 안내합니다:

```
※ 이메일 정보가 없어 제외된 인원: {이름1}, {이름2}
```

- 배정된 강사·기술튜터가 아예 없으면 "배정된 인원이 없습니다"라고 안내합니다.

---

## 사용 예시

```
/lecture-share 기업명:뉴트리원 교육명:AI 활용 실무
→ course 조회 → 배정 인원 이메일 조회 → 중복 제거 후 쉼표 구분 목록 출력
```

---

## 주의사항

- `mcp__ax-hub__query_sql`은 SELECT만 허용됩니다 (read-only).
- 이 스킬은 이메일 목록만 조회해 보여줍니다. 노션에 실제로 초대하는 작업은 하지 않습니다 (노션 초대는 `notion-share` 스킬 사용).
- 교육이 여러 건 검색되면 반드시 선택을 받고 진행합니다.
