---
name: ax-edu-day-before-remind
description: |
  매일 실행되어, ax-hub DB에서 내일 시작하는 교육 세션을 찾아 강사·기술튜터에게 시간·장소를 재안내하는
  리마인드 메시지를 Slack #ax교육팀_교육운영 채널의 해당 교육 스레드(ax-edu-slack-share가 보낸 원본 공유
  메시지)에 댓글로 남긴다.
  내일 세션이 없으면 아무 것도 하지 않는다.
argument-hint: ""
user-invocable: true
allowed-tools: mcp__ax-hub__query_sql, mcp__plugin_slack_slack__slack_search_public_and_private, mcp__plugin_slack_slack__slack_search_channels, mcp__plugin_slack_slack__slack_send_message, mcp__claude_ai_Slack__slack_search_users
---

# 교육 하루 전 리마인드 스킬

매일 자동 실행되어 **내일 시작하는 교육 세션**을 찾고, 이미 `ax-edu-slack-share`로 `#ax교육팀_교육운영`
채널에 올라가 있는 해당 교육의 공유 메시지 스레드에 리마인드 댓글을 답니다.

> **원칙**: 자동(cron) 트리거로 실행되므로 사용자 확인 없이 바로 조회 → 스레드 탐색 → 전송까지 수행합니다.
> (`/ax-edu-day-before-remind` 형태로 사용자가 직접 실행한 경우도 동일하게 바로 전송합니다.)

---

## 1단계 — 내일 시작하는 세션 조회

`mcp__ax-hub__query_sql`로 실행합니다. 날짜는 한국 시간(KST) 기준 "내일"입니다.

```sql
SELECT
  cs.id                AS session_id,
  cs.date,
  cs.start_time,
  cs.end_time,
  COALESCE(cs.place, c.place) AS session_place,
  c.id                  AS course_id,
  c.title               AS course_title,
  cl.name                AS client_name
FROM course_sessions cs
JOIN course_rounds cr ON cr.id = cs.round_id
JOIN courses c        ON c.id  = cr.course_id
LEFT JOIN deals d     ON d.id  = c.deal_id
LEFT JOIN clients cl  ON cl.id = d.client_id
WHERE cs.date = (CURRENT_DATE AT TIME ZONE 'Asia/Seoul') + INTERVAL '1 day'
  AND c.status IN ('setup', 'operation')
ORDER BY cs.start_time
```

- 결과가 0건이면 **여기서 종료**합니다. 아무 메시지도 남기지 않고 조용히 끝냅니다.
- 결과가 여러 건이면(여러 교육이 내일 동시에 시작) 세션마다 2~5단계를 반복합니다.

시간 포맷 변환 규칙 (start_time / end_time 은 double precision):
- `9` → `09:00`, `9.5` → `09:30`, `13` → `13:00` (정수는 `HH:00`, 소수점은 `HH:분(×60)`)

날짜 표기 포맷: `YY/MM/DD (요일)`

---

## 2단계 — 해당 세션의 강사·기술튜터 조회

```sql
SELECT
  i.name,
  i.slack_id,
  qc.category::text AS role_category
FROM assignments a
JOIN qualification_catalog qc ON qc.id = a.qualification_id
JOIN instructors i            ON i.id  = a.instructor_id
WHERE a.course_session_id = '{session_id}'
ORDER BY qc.category, i.name
```

역할 분류:
- `main_instructor` → 강사
- `tech_tutor`, `mentor` → 기술튜터

**Slack ID 확보:**
- DB의 `slack_id`가 있으면 그대로 사용합니다.
- 없으면 `mcp__claude_ai_Slack__slack_search_users`로 이름을 검색해 user_id를 가져옵니다.
- 그래도 못 찾으면 이름을 plain text로 표기합니다.

멘션 포맷: `<@{slack_user_id}>`

배정이 하나도 없으면(강사·튜터 모두 없음) 해당 세션은 건너뛰고, 완료 보고 시 "배정 없음"으로 안내합니다.

---

## 3단계 — 원본 공유 스레드 탐색

`mcp__plugin_slack_slack__slack_search_channels`로 `ax교육팀_교육운영` 채널 ID를 확인한 뒤,
`mcp__plugin_slack_slack__slack_search_public_and_private`로 원본 공유 메시지를 찾습니다.

```
query: "in:#ax교육팀_교육운영 [{client_name}] {course_title}"
```

- 검색 결과 중 `[{client_name}] {course_title}` 로 시작하는 메시지를 원본으로 판단하고, 그 메시지의
  `ts`(타임스탬프)를 `thread_ts`로 사용합니다.
- 결과가 여러 건이면 가장 최근 메시지를 사용합니다.
- 검색어로 못 찾으면 `client_name`만으로 다시 검색합니다.
- 그래도 못 찾으면 이 세션은 스레드 댓글을 남기지 않고, 최종 보고 시 "원본 공유 메시지를 찾지 못해 리마인드
  전송 실패"로 안내합니다. (채널에 새 글로 올리지 않습니다 — 반드시 기존 스레드에만 답니다.)

---

## 4단계 — 리마인드 메시지 작성

```
[내일 교육 리마인드] {client_name} {course_title}

일정: {YY/MM/DD (요일)} {HH:MM~HH:MM}
장소: {session_place}

강사: <@{main_instructor slack_user_id}> (없으면 "미배정")
기술튜터: <@{tech_tutor+mentor slack_user_id}> (없으면 "미배정")

내일 교육 준비 잘 부탁드립니다!
```

---

## 5단계 — 스레드에 전송

`mcp__plugin_slack_slack__slack_send_message`를 `channel_id`(3단계에서 확인한 `#ax교육팀_교육운영` 채널 ID)와
`thread_ts`(3단계에서 찾은 원본 메시지 ts)로 호출해 스레드 댓글로 전송합니다. 새 메시지로 올리지 않습니다.

---

## 완료 후 보고

모든 세션 처리가 끝나면 다음을 요약해 알립니다:
- 리마인드를 보낸 교육 목록 (스레드 링크 포함)
- 원본 스레드를 못 찾아 실패한 교육
- 강사/튜터 미배정으로 "미배정" 표기된 항목
- 내일 시작 세션이 없었다면 "내일 시작하는 교육 없음"

## 주의 사항

- 채널에 새 메시지로 올리지 않고 반드시 기존 스레드 댓글로만 남깁니다.
- cron 자동 실행이므로 전송 전 사용자 확인을 받지 않습니다.
- 하루에 여러 교육이 내일 시작하면 교육마다 별도로 스레드를 찾아 각각 리마인드를 답니다.
