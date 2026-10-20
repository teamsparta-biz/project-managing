---
name: contract-consent-check
description: "지정한 달(예: 9월)에 수업이 있는 담당 교육 중 '배정은 있는데 계약이 없는' 강사·튜터와 '계약은 있는데 동의완료를 안 누른' 강사·튜터를 ax-hub에서 찾아 보여주고, 사용자가 고른 사람에게 강사포털 동의 요청 슬랙 개인 DM을 보냅니다. /contract-consent-check 월:9 형태로 실행."
argument-hint: "월:9 [연도:2026] [담당자:송찬호]"
user-invocable: true
allowed-tools: mcp__ax-hub__query_sql, mcp__claude_ai_Slack__slack_search_users, mcp__claude_ai_Slack__slack_send_message
---

# 계약 동의 점검 + 동의 요청 DM 스킬

특정 달에 수업이 있는 담당 교육의 **계약 누락**과 **동의 미완료**를 찾아 보여주고, 사용자가 이름을 고르면 그 사람에게 슬랙 개인 DM으로 "강사포털에서 금액 확인 후 동의완료를 눌러달라"는 요청을 보냅니다.

---

## 전체 흐름

```
[1단계] 인자 파싱 (월 필수, 연도·담당자 기본값)
    ↓
[2단계] 해당 월에 수업이 있는 담당 교육 조회
    ↓
[3단계] ① 계약 없음  ② 동의 미완료  두 목록 출력 → 종료하고 사용자 지시 대기
    ↓ (사용자가 "OOO한테 보내줘")
[4단계] 대상자 계약 재확인 + 슬랙 사용자 찾기
    ↓
[5단계] DM 초안 보여주기 → 승인("보내" 등) 받은 뒤 전송
```

---

## 1단계: 인자 파싱

- `월:` — **필수**. `9`, `9월`, `2026-09` 모두 허용. 없으면 어느 달을 볼지 물어봅니다.
- `연도:` — 없으면 오늘 날짜 기준 올해.
- `담당자:` — 없으면 `송찬호`.

월의 첫날·마지막 날을 `{start}`, `{end}`(YYYY-MM-DD)로 정합니다.

---

## 2단계: 대상 교육 조회

해당 월에 **수업일이 하루라도 있는** 교육 중 담당자가 active 매니저(주담당·서브 모두)인 교육입니다.

```sql
SELECT c.id, c.title, c.status, cl.name AS client,
       min(s.date) AS first_d, max(s.date) AS last_d
FROM courses c
JOIN course_managers cm ON cm.course_id = c.id AND cm.status = 'active'
JOIN profiles p ON p.id = cm.profile_id
LEFT JOIN deals d ON d.id = c.deal_id
LEFT JOIN clients cl ON cl.id = d.client_id
JOIN course_rounds r ON r.course_id = c.id
JOIN course_sessions s ON s.round_id = r.id
WHERE p.display_name LIKE '%{담당자}%'
GROUP BY c.id, c.title, c.status, cl.name
HAVING bool_or(s.date BETWEEN '{start}' AND '{end}')
ORDER BY first_d;
```

---

## 3단계: 두 목록 조회 후 출력

계약 상태(`engagements.status`): `draft` = 동의 전, `signed`·`completed` = 동의완료, `cancelled` = 취소(무시).

### ① 배정은 있는데 계약이 없는 사람

```sql
WITH my AS ( {2단계 쿼리에서 c.id만} )
SELECT c.title, cl.name AS client, c.status, i.name,
       string_agg(DISTINCT to_char(s.date, 'MM-DD'), ', ') AS dates
FROM my
JOIN courses c ON c.id = my.id
LEFT JOIN deals d ON d.id = c.deal_id
LEFT JOIN clients cl ON cl.id = d.client_id
JOIN course_rounds r ON r.course_id = c.id
JOIN course_sessions s ON s.round_id = r.id
JOIN assignments a ON a.course_session_id = s.id
JOIN instructors i ON i.id = a.instructor_id
WHERE NOT EXISTS (
  SELECT 1 FROM engagements e
  WHERE e.course_id = c.id AND e.instructor_id = i.id AND e.status <> 'cancelled')
GROUP BY c.id, c.title, cl.name, c.status, i.id, i.name
ORDER BY c.title, i.name;
```

### ② 계약은 있는데 동의완료 전인 사람

**배정 여부와 상관없이 계약 기준**으로 조회합니다. 배정 없이 계약만 있는 사람도 빠지면 안 됩니다.

```sql
WITH my AS ( {2단계 쿼리에서 c.id만} )
SELECT c.title, cl.name AS client, c.status, i.name, e.total_amount, e.created_at::date,
       (SELECT string_agg(DISTINCT to_char(s.date, 'MM-DD'), ', ')
          FROM course_rounds r JOIN course_sessions s ON s.round_id = r.id
          JOIN assignments a ON a.course_session_id = s.id
         WHERE r.course_id = c.id AND a.instructor_id = i.id) AS dates
FROM my
JOIN courses c ON c.id = my.id
LEFT JOIN deals d ON d.id = c.deal_id
LEFT JOIN clients cl ON cl.id = d.client_id
JOIN engagements e ON e.course_id = c.id AND e.status = 'draft'
JOIN instructors i ON i.id = e.instructor_id
ORDER BY c.title, i.name;
```

### 출력

- 두 섹션을 표로 출력합니다. 열은 교육(기업명), 교육 상태, 강사·튜터, 배정일이고, ②에는 금액도 넣습니다.
- 계약도 배정도 없는 교육은 따로 한 줄로 알립니다. 중단(stopped) 교육이면 그렇다고 표시합니다.
- 배정일이 조회한 달 밖에 있는 사람은 그렇다고 짚어 줍니다. 교육은 그 달에 걸리지만 그 사람은 다른 달에만 수업하는 경우입니다.
- 출력 후 멈추고, 누구에게 DM을 보낼지 사용자 지시를 기다립니다.

---

## 4단계: 대상자 확인

사용자가 이름을 지정하면 사람마다 다음을 확인합니다.

1. **계약 재확인**: 해당 교육·강사의 `engagements`를 다시 조회합니다. ①에 있던 사람은 그사이 계약이 생성됐을 수 있습니다.
   - `draft`가 있으면 진행합니다. 금액·생성일은 초안 확인용으로만 보여주고 메시지에는 넣지 않습니다.
   - 계약이 아직 없거나 이미 `signed`이면 보내지 말고 사용자에게 알립니다.
2. **기업명**: `deals → clients.name`.
3. **슬랙 사용자**: `slack_search_users`(keywords: 이름, response_format: concise)로 찾습니다.
   - 결과가 1명이고 표시명에 (강사)/(기술튜터)가 붙어 있으면 그 사람으로 봅니다.
   - 역할 표시가 없거나 여러 명이면 `instructors.email`과 슬랙 이메일을 대조해 맞는 사람을 고릅니다. 그래도 불확실하면 사용자에게 물어봅니다.
4. 같은 교육에서 동의 전인 다른 사람이 있으면 함께 보낼지 한 줄로 물어봅니다.

---

## 5단계: DM 초안 → 승인 → 전송

### 메시지 템플릿 (교육마다 1개, 받는 사람에게 각각 같은 내용)

```
안녕하세요, 스파르타 기업교육팀 송찬호입니다.

**[{기업명}] {교육명}** 계약이 강사포털에 생성되었습니다.
강사포털에서 계약 금액을 확인해 주시고, 이상이 없으면 **'동의완료'** 버튼을 눌러주세요.

궁금한 점이 있으시면 편하게 말씀 부탁드립니다. 감사합니다!
```

- 담당자 인자가 송찬호가 아니면 인사말 이름을 그 담당자로 바꿉니다.
- 교육명에 기업명이 이미 들어 있어도 `[기업명] 교육명` 형식을 그대로 씁니다.

### 승인 규칙 (CLAUDE.md "Draft Review Before Saving")

- 전송 전에 **받는 사람(이름·역할·슬랙 ID)과 메시지 전문**을 보여주고 명시적 승인("보내", "전송", "동의완료" 등)을 기다립니다.
- 승인 후 문구가 바뀌면(교육명·기업명 포함) 다시 승인을 받습니다. 이미 승인된 문구와 똑같은 메시지를 다른 사람에게 보낼 때만 재승인 없이 보냅니다.
- 전송은 `slack_send_message`에 `channel_id` = 사용자 ID로 개인 DM을 보냅니다.
- 전송 후 사람별 메시지 링크를 목록으로 보여줍니다.
