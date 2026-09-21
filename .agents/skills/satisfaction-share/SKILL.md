---
name: satisfaction-share
description: "교육 종료 후 만족도조사 결과를 교육 담당자(고객사)와 담당 주강사에게 전달합니다. /satisfaction-share 명령으로 실행하며, ax-satisfaction-check 스킬로 계산된 결과를 그대로 받아 고객사 담당자에게는 Gmail 임시보관함 메일로, 담당 주강사에게는 Slack DM으로 동일한 내용을 전달합니다."
argument-hint: "[기업명:기업명] [교육명:교육명]"
user-invocable: true
allowed-tools: Read, Skill, mcp__ax-hub__query_sql, mcp__claude_ai_Slack__slack_search_users, mcp__claude_ai_Slack__slack_send_message, mcp__claude_ai_Gmail__create_draft
---

# 만족도결과전달 스킬

사용자가 `/satisfaction-share`를 실행하면, **교육 종료 후 만족도조사 결과**를 고객사 담당자와 담당 주강사에게 동일한 내용으로 전달합니다.
만족도 계산은 직접 하지 않고, **ax-satisfaction-check 스킬을 그대로 호출**해 받은 결과를 사용합니다.

---

## 전체 흐름 요약

```
[1단계] 인자에서 기업명/교육명 파싱
    ↓
[2단계] ax-satisfaction-check 스킬 호출 → 만족도 결과(문장형 요약) 확보
    ↓
[3단계] ax-hub에서 고객사 담당자 이메일 + 담당 주강사 조회 (담당 주강사가 여럿이면 확인)
    ↓
[4단계] 담당 주강사 이름으로 Slack 사용자 ID 조회
    ↓
[5단계] 메일·Slack 동일 내용으로 미리보기 출력
    → 사용자 확인 및 수정 요청 반영
    ↓
[6단계] 사용자가 "검수 완료" 입력 시 Gmail 임시보관함 저장 + Slack DM 전송
    → 완료
```

---

## 1단계: 인자 파싱

명령 인자에서 `기업명:`, `교육명:`을 추출합니다. (웹앱 "만족도결과전달" 버튼은 이 형식으로 명령을 복사합니다.)

- `기업명`이 없으면 사용자에게 기업명(및 필요 시 교육명)을 질문합니다.

---

## 2단계: ax-satisfaction-check 호출

`Skill` 도구로 `ax-satisfaction-check`를 아래와 동일한 인자로 실행합니다.

```
교육명(기업명) = {기업명} {교육명}
```

- ax-satisfaction-check가 반환하는 **문장형 요약**(6문항 평균, KPI(4.6 이상) 충족 여부, 저점 문항, 개선 의견)을 그대로 3단계 이후 메시지 본문에 사용합니다.
- ax-satisfaction-check가 시트를 찾지 못하거나 오류를 반환하면, 그 내용을 사용자에게 그대로 전달하고 스킬을 종료합니다(다음 단계로 진행하지 않음).

---

## 3단계: 고객사 담당자 + 담당 주강사 조회

아래 SQL로 course와 담당자 정보를 조회합니다 (교육명이 있으면 함께 필터링).

```sql
SELECT
  c.id AS course_id,
  c.title AS training_name,
  cl.name AS client_name
FROM courses c
JOIN deals d   ON c.deal_id    = d.id
JOIN clients cl ON d.client_id = cl.id
WHERE cl.name = '기업명'
ORDER BY c.lecture_start DESC NULLS LAST
LIMIT 5;
```

- 결과가 여러 건이면 `교육명`(부분 일치)으로 좁히고, 그래도 여러 건이면 사용자에게 물어봅니다.

`course_id`로 담당 주강사를 조회합니다 (qualification_id 앞 8자리로 주강사 판별, 회차 전체에서 가장 많이 배정된 강사를 우선 후보로 계산):

```sql
SELECT i.name, COUNT(*) AS cnt
FROM course_sessions cs
JOIN course_rounds cr ON cs.round_id = cr.id
JOIN assignments a    ON a.course_session_id = cs.id
JOIN instructors i    ON a.instructor_id = i.id
WHERE cr.course_id = 'course_id'
  AND left(a.qualification_id::text, 8) IN
    ('a7a605e9','888ee72c','07ecdab5','e39eeef7','ecdd7d85','7db139f7','2647f764')
GROUP BY i.name
ORDER BY cnt DESC;
```

- 결과가 1명이면 그 강사를 담당 주강사로 사용합니다.
- 여러 명이고 배정 횟수가 동률이거나 애매하면, 목록을 보여주고 사용자에게 누구에게 전달할지 확인합니다.
- 결과가 없으면 사용자에게 담당 주강사 이름을 직접 물어봅니다.

고객사 담당자 이메일은 웹앱 companies 데이터의 `contactEmail`을 우선 사용합니다(명령 인자나 사용자 입력으로 받은 값이 있으면 그것을 우선). 없으면 사용자에게 질문합니다.

---

## 4단계: 담당 주강사 Slack 사용자 조회

`slack_search_users` 툴로 3단계에서 확정한 강사 이름을 검색해 Slack user_id를 확보합니다.

- 찾지 못하면 사용자에게 정확한 이름 또는 이메일을 재확인 요청합니다.

---

## 5단계: 미리보기 출력

메일과 Slack 모두 **동일한 내용**으로 아래 형식으로 미리보기를 출력합니다.

**메일 제목**: `[팀스파르타] {교육명} 만족도조사 결과 안내`

**본문(메일·Slack 공통)**:
```
{수신자 호칭}, 안녕하세요.
팀스파르타 {발신자이름}입니다.

{기업명} {교육명} 교육의 만족도조사 결과를 안내드립니다.

{ax-satisfaction-check 결과 요약 전체 — 6문항 평균, KPI(4.6 이상) 충족 여부, 저점 문항, 개선 의견}

확인 부탁드립니다. 감사합니다.
{발신자이름} 드림
```

- 메일 수신자 호칭: "{고객사 담당자 이름} {직함}님" (이름·직함이 없으면 질문)
- Slack 수신자 호칭: "{강사 이름} 강사님"
- 발신자 이름은 parking-check-inquiry 스킬의 0단계와 동일하게 `.env`의 `USER_EMAIL` → ax-hub `profiles.display_name` 조회로 확보합니다.

출력 후 아래 문구로 마무리합니다:

> **수정할 내용이 있으면 말씀해 주세요. 확인되셨으면 "검수 완료"라고 입력해 주시면 메일 임시보관함 저장과 Slack 전송을 진행합니다.**

---

## 6단계: 발송

사용자가 "검수 완료"를 입력하면:

1. 고객사 담당자 이름·직함·이메일이 없는 경우 이 시점에 요청합니다.
2. Gmail `create_draft`로 임시보관함에 저장합니다.
3. Slack `slack_send_message`로 담당 주강사에게 DM을 전송합니다.
4. 완료 후 아래 메시지를 출력합니다:

> **✅ 메일 초안이 Gmail 임시보관함에 저장되고, Slack DM으로 강사님께 전송되었습니다.**

메일 저장 또는 Slack 전송이 실패하면 어떤 쪽이 실패했는지 명시하고 재시도 여부를 묻습니다(한쪽만 성공한 경우에도 성공한 쪽은 완료로 안내).

---

## 사용 예시

```
/satisfaction-share 기업명:뉴트리원 교육명:AI 마스터클래스
→ ax-satisfaction-check 호출 → 담당자/강사 조회 → 미리보기 출력 → "검수 완료" → 메일 저장 + Slack 전송
```

---

## 주의사항

- `mcp__ax-hub__query_sql`은 SELECT만 허용됩니다 (read-only).
- 만족도 계산 로직은 절대 이 스킬에서 재구현하지 않습니다 — 항상 `ax-satisfaction-check`를 호출한 결과를 사용합니다.
- 메일·Slack 두 채널의 본문 내용은 동일해야 합니다(호칭만 다름).
- 사용자 확인("검수 완료") 전까지는 어떤 발송도 하지 않습니다.
