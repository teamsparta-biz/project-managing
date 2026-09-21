---
name: ax-edu-slack-share
description: >
  AX-hub DB에서 기업명·교육명으로 교육 정보를 조회하고,
  Slack #ax교육팀_교육운영 채널에 교육 공유 메시지를 작성하여 전송한다.
metadata:
  author: chanho.song@teamsparta.co
  version: "1.0.0"
---

## 개요

사용자가 **기업명**과 **교육명**을 입력하면:
1. AX-hub DB에서 교육 상세 정보(일정·장소·교안링크·강사·기술튜터)를 조회한다.
2. 아래 메시지 포맷으로 초안을 만든다.
3. 사용자에게 확인 후 Slack `#ax교육팀_교육운영` 채널로 전송한다.

## 실행 절차

### 1단계 — 교육 기본 정보 조회

`mcp__ax-hub__query_sql`로 아래 쿼리를 실행한다.
`{기업명}`과 `{교육명}`은 사용자 입력값으로 대체한다.

```sql
SELECT
  c.id,
  c.title,
  c.place             AS course_place,
  c.special_notes,
  c.lecture_start,
  c.lecture_end,
  cl.name             AS client_name,
  w.shorten_url       AS workbook_url,
  w.full_url          AS workbook_full_url
FROM courses c
LEFT JOIN deals d   ON d.id = c.deal_id
LEFT JOIN clients cl ON cl.id = d.client_id
LEFT JOIN workbooks w ON w.course_id = c.id
WHERE
  cl.name  ILIKE '%{기업명}%'
  AND c.title ILIKE '%{교육명}%'
  AND c.status IN ('setup', 'operation')
ORDER BY c.lecture_start DESC
LIMIT 5
```

결과가 여러 건이면 사용자에게 목록을 보여주고 하나를 선택하게 한다.
결과가 0건이면 검색 조건을 완화하거나 정확한 이름을 다시 확인한다.

### 2단계 — 세션 일정 조회

1단계에서 선택한 `course_id`로 세션 정보를 가져온다.

```sql
SELECT
  cs.date,
  TO_CHAR(cs.date, 'IW') AS iso_week,
  EXTRACT(DOW FROM cs.date) AS dow,   -- 0=일, 1=월 ... 6=토
  cs.start_time,
  cs.end_time,
  COALESCE(cs.place, c.place) AS session_place
FROM course_sessions cs
JOIN course_rounds  cr ON cr.id = cs.round_id
JOIN courses        c  ON c.id  = cr.course_id
WHERE c.id = '{course_id}'
ORDER BY cs.date ASC
```

시간 포맷 변환 규칙 (start_time / end_time 은 double precision):
- `9`   → `09:00`
- `9.5` → `09:30`
- `13`  → `13:00`
- 정수이면 `HH:00`, 소수점이 있으면 `HH:분(×60)` 으로 계산

요일 변환 (EXTRACT DOW 기준):
- 0=일, 1=월, 2=화, 3=수, 4=목, 5=금, 6=토

날짜 표기 포맷: `YY/MM/DD (요일)` (예: `26/06/15 (월)`)

**회차 그룹핑:**
- `round_id` 기준으로 세션을 그룹핑한다.
- 회차 번호는 각 round의 가장 빠른 날짜 기준 오름차순으로 부여한다 (1회차, 2회차, ...).
- 세션이 1개 round만 있으면 회차 헤더 없이 날짜 목록만 나열한다.

### 3단계 — 회차별 강사·기술튜터 배정 조회

```sql
SELECT
  cr.id AS round_id,
  cs.date,
  i.name,
  i.slack_id,
  i.affiliation,
  qc.category::text AS role_category
FROM course_rounds cr
JOIN course_sessions cs ON cs.round_id = cr.id
JOIN assignments a ON a.course_session_id = cs.id
JOIN qualification_catalog qc ON qc.id = a.qualification_id
JOIN instructors i ON i.id = a.instructor_id
WHERE cr.course_id = '{course_id}'
ORDER BY cr.id, cs.date, qc.category
```

각 `round_id`별로 `DISTINCT`하게 강사·기술튜터를 묶어 회차별 목록을 구성한다.

역할 분류:
- `main_instructor` → 강사 라인
- `tech_tutor`      → 기술튜터 라인
- `mentor`          → 기술튜터 라인 (tech_tutor와 함께 표시)

**Slack ID 확보:**
- DB의 `slack_id`가 있으면 그대로 사용한다.
- DB의 `slack_id`가 없으면 `mcp__claude_ai_Slack__slack_search_users`로 이름을 검색해 user_id를 가져온다.
- 검색으로도 찾지 못하면 이름을 plain text로 표기하고 사용자에게 알린다.

멘션 포맷: 항상 `<@{slack_user_id}>` 형식을 사용한다. Slack이 표시명을 자동 렌더링하므로 별도 괄호 표기는 불필요하다.

### 4단계 — 메시지 초안 작성

아래 포맷을 사용한다. 교안 링크는 `shorten_url`을 우선 사용하고 없으면 `full_url`을 사용한다.

**준비 사항 블록은 항상 포함한다.**
- `special_notes`가 있으면: special_notes 내용을 먼저 쓰고, 그 다음 줄에 고정 문구를 추가한다.
- `special_notes`가 없으면: 고정 문구만 표시한다.
- 고정 문구: `패들릿 및 설문조사 폼도 확인부탁드리겠습니다.`

**회차가 2개 이상인 경우** — 각 회차 블록 안에 강사·기술튜터를 함께 표시:

```
[{client_name}] {course_title}

일정
1회차
- {YY/MM/DD (요일) HH:MM~HH:MM}
강사: <@{1회차 main_instructor slack_user_id}>
기술튜터: <@{1회차 tech_tutor+mentor slack_user_id}>

2회차
- {YY/MM/DD (요일) HH:MM~HH:MM}
강사: <@{2회차 main_instructor slack_user_id}>
기술튜터: <@{2회차 tech_tutor+mentor slack_user_id}>

교육 준비를 위해 20분 일찍 도착 부탁드립니다.

교육 장소 : {session_place 또는 course_place}
교안 링크: {workbook_url}

준비 사항
{special_notes (있을 때만)}
패들릿 및 설문조사 폼도 확인부탁드리겠습니다.

교육 진행 중 공유 내용은 해당 스레드 댓글을 통해 공유해주세요!
```

**회차가 1개인 경우** — 강사·기술튜터를 하단에 표시:

```
[{client_name}] {course_title}

일정
- {YY/MM/DD (요일) HH:MM~HH:MM}

교육 준비를 위해 20분 일찍 도착 부탁드립니다.

교육 장소 : {session_place 또는 course_place}
교안 링크: {workbook_url}

준비 사항
{special_notes (있을 때만)}
패들릿 및 설문조사 폼도 확인부탁드리겠습니다.

강사: <@{main_instructor slack_user_id}>
기술튜터: <@{tech_tutor+mentor slack_user_id}>

교육 진행 중 공유 내용은 해당 스레드 댓글을 통해 공유해주세요!
```

### 5단계 — 확인 및 전송

1. 작성한 메시지 초안을 사용자에게 보여주고 수정 여부를 묻는다.
2. 사용자가 확인하면 `mcp__claude_ai_Slack__slack_search_channels`로 `ax교육팀_교육운영` 채널을 검색하여 채널 ID를 확인한다.
3. `mcp__claude_ai_Slack__slack_send_message`로 해당 채널에 전송한다.

## 실행 예시

사용자 발화:
- `/ax-edu-slack-share`
- "KB인베스트먼트 투자부문 교육 슬랙에 공유해줘"
- "현대카드 AI교육 교육운영채널에 올려줘"

## 주의 사항

- 교육이 여러 건 검색되면 반드시 선택을 받고 진행한다.
- 강사/튜터 배정이 없으면 해당 라인을 "미배정"으로 표시하고 사용자에게 알린다.
- 전송 전에 반드시 메시지 초안을 사용자에게 보여준다. 자동 전송하지 않는다.
- `special_notes`(준비 사항)는 선택 항목이므로 없으면 해당 블록 전체를 생략한다.
