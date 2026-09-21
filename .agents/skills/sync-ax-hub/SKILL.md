---
name: sync-ax-hub
description: "ax-hub에서 담당자 이름 기준으로 교육 목록을 조회하여 웹앱 state.json에 동기화합니다. 웹앱에서 '교육 가져오기' 버튼을 누르면 /sync-ax-hub 담당자:이름 형태로 명령이 복사됩니다."
---

# ax-hub 교육 동기화 스킬

`/sync-ax-hub 담당자:이름` 실행 시 ax-hub DB에서 담당자 교육을 조회하고 웹앱(Supabase)에 동기화합니다.

> # 🚨 절대 규칙 (최우선)
> **칸반보드에 사용자가 입력한 업무 내용은 어떤 경우에도 수정·초기화·삭제하지 않는다.**
> - 보존: 각 교육의 `status`(체크박스)·`memo`·`deadline`, 최상위 `notes`·`notesUpdated`·`completedNotes`·`completedNotesUpdated`
> - 병합 기준은 **항상 Supabase 현재 상태**(=현재 칸반보드). 로컬 파일 기준으로 덮어쓰지 않는다.
> - 동기화는 **항목을 삭제하지 않는다.**
> - 이 규칙이 다른 모든 지시보다 우선한다.
>
> 위 규칙은 `scripts/sync-ax-hub.js`에 구현되어 있다. **병합을 직접 하지 말고 스크립트를 쓸 것.**

---

## 실행 흐름 (3스텝)

토큰 절약을 위해 **모델은 병합에 관여하지 않는다.** SQL 1회 → payload 파일 저장 → 스크립트 1회.

```
[1] mcp__ax-hub__query_sql로 아래 통합 SQL 1회 실행 → payload 문자열 1개 획득
[2] Write 도구로 payload를 data\.sync_payload_<담당자>.txt 에 그대로 저장
[3] node scripts/sync-ax-hub.js "<담당자>" "data/.sync_payload_<담당자>.txt"
    → 스크립트가 Supabase GET(기준) → 병합 → state.json 저장 → 동시편집 확인 → POST → 요약 출력
[4] 스크립트 출력 요약을 사용자에게 정리해 보고
```

- 인수에서 `담당자:이름` → `OWNER_NAME`. 없으면 사용자에게 물어본다.
- 사용자 확인 없이 바로 적용한다(자동 적용).
- 결과만 먼저 보려면 `--dry-run`을 붙인다(파일 저장·POST 모두 생략).
- **state.json을 Read하지 않는다.** 병합은 스크립트가 하므로 모델이 파일 내용을 볼 필요가 없다.
- 로컬 서버(`localhost:3000`) POST는 하지 않는다 — 항상 꺼져 있어 4초 이상 낭비된다.

---

## 1단계: 통합 SQL (1회만 실행)

`'송찬호'` 자리에 `OWNER_NAME`을 넣는다. 결과는 `payload` 컬럼 문자열 1개다.

```sql
WITH me AS (
  SELECT email FROM profiles WHERE display_name = '송찬호' AND email LIKE '%teamsparta.co' LIMIT 1
), own AS (
  SELECT c.id, c.title, c.status, c.place, cl.name AS client,
         cc.name AS cn, cc.position AS cp, cc.email AS ce
  FROM courses c
  JOIN deals d ON c.deal_id = d.id
  JOIN clients cl ON d.client_id = cl.id
  LEFT JOIN client_contacts cc ON c.client_contact_id = cc.id
  WHERE c.manager_email = (SELECT email FROM me)
), act AS (
  SELECT * FROM own WHERE status IN ('setup','operation')
), wb AS (
  SELECT course_id, min(coalesce(shorten_url, full_url)) AS url FROM workbooks GROUP BY course_id
), ln AS (
  SELECT 1 AS ord, 'C|'||act.id||'|'||act.client||'|'||act.title||'|'||act.status||'|'||
         coalesce(act.place,'')||'|'||coalesce(wb.url,'')||'|'||coalesce(act.cn,'')||'|'||
         coalesce(act.cp,'')||'|'||coalesce(act.ce,'') AS line
  FROM act LEFT JOIN wb ON wb.course_id = act.id
  UNION ALL
  SELECT 2, 'S|'||left(cr.course_id::text,8)||'|'||cs.date||'|'||min(cs.start_time)||'|'||max(cs.end_time)||'|'||
    coalesce(string_agg(DISTINCT i.name, ',') FILTER (WHERE left(a.qualification_id::text,8) IN
      ('a7a605e9','888ee72c','07ecdab5','e39eeef7','ecdd7d85','7db139f7','2647f764')), '')||'|'||
    coalesce(string_agg(DISTINCT i.name, ',') FILTER (WHERE left(a.qualification_id::text,8) IN
      ('30976fac','a0af4d4f','fc59bde4')), '')
  FROM course_sessions cs
  JOIN course_rounds cr ON cs.round_id = cr.id
  LEFT JOIN assignments a ON a.course_session_id = cs.id
  LEFT JOIN instructors i ON a.instructor_id = i.id
  WHERE cr.course_id IN (SELECT id FROM act)
  GROUP BY cr.course_id, cs.date
  UNION ALL
  SELECT 3, 'A|'||left(id::text,8) FROM own WHERE status NOT IN ('setup','operation')
)
SELECT string_agg(line, E'\n' ORDER BY ord, line) AS payload FROM ln;
```

담당자 이름이 조회되지 않으면(payload가 NULL) "ax-hub에 등록된 이름과 정확히 일치해야 합니다"라고 안내하고 중단한다.

### payload 형식

| 줄 | 의미 |
|---|---|
| `C\|course_id(full)\|기업명\|교육명\|status\|장소\|교안URL\|담당자명\|직책\|이메일` | 진행 대상 교육 (`setup`·`operation`) |
| `S\|course_id 앞8자리\|YYYY-MM-DD\|start\|end\|강사,강사\|튜터,튜터` | **일자 1개 = 세션 1개** (회차 아님) |
| `A\|course_id 앞8자리` | 담당자 소유이나 보관 대상 (`tax_invoice`·`closed`·`stopped`) |

`|`로 구분되므로 값에 `|`가 들어가면 파싱이 깨진다. 스크립트가 형식 오류를 감지하면 중단한다.

교안·강사·튜터 정보를 다른 스킬에서 쓰려고 여기서 추가 쿼리를 붙이지 말 것 — payload가 커지면 그만큼 토큰이 든다.

---

## 2단계: payload 저장

**Write 도구**로 `data\.sync_payload_<OWNER_NAME>.txt`에 SQL 결과 문자열을 저장한다.
(`\n` 이스케이프는 실제 줄바꿈으로 풀어서 쓴다. PowerShell 인라인 문자열은 한글이 깨지므로 쓰지 않는다.)

---

## 3단계: 스크립트 실행

```bash
node scripts/sync-ax-hub.js "송찬호" "data/.sync_payload_송찬호.txt"
```

스크립트가 수행하는 일 (구현은 `scripts/sync-ax-hub.js` 참조):

- **기준 로드**: Supabase `user_states`에서 현재 state를 GET. `updated_at`을 기준 시각으로 잡고 로컬 파일은 `.bak`으로 백업. Supabase에 데이터가 없으면 로컬 `state.json`을 기준으로 쓴다.
- **사실 정보 갱신**: `name`·`trainingName`·`instructorName`·`tutorName`·`sessions`·`startAt`·`endAt`·`workbookUrl`·`trainingStatus`·`archived`
- **빈 값만 채움**: `location`·`contactName`·`contactPosition`·`contactEmail` — 기존 값이 있으면 유지 (사용자가 웹앱에서 직접 입력한 축약 장소 등을 보존)
- **업무 내용 보존**: `status`·`memo`·`deadline`·최상위 `notes` 계열은 손대지 않음
- **신규 추가**: `id` = 현재 최대 id + 1, `ax_hub_course_id` 기록, `status`는 현재 tasks 전부 0
- **보관 처리**: `A` 줄에 해당하는 항목은 `archived=true`만 설정하고 나머지 필드는 건드리지 않음
- **`ax_hub_course_id` 없는 항목**: 사용자가 수동 추가한 것 → 어떤 필드도 건드리지 않음
- **담당자 외 항목**: 삭제하지 않고 "확인 필요"로 목록만 보고
- **동시편집 감지**: POST 직전 `updated_at`을 재확인. 달라졌으면 POST를 중단하고 exit 2 → **다시 실행**하면 최신 상태 위에 재병합된다.
- **POST 검증**: `on_conflict=owner` + `Prefer: return=representation`. 응답의 companies 건수가 기대치와 다르면 실패로 처리.
  (`on_conflict` 누락 시 갱신 없이 200이 오고, `return=minimal`이면 그걸 감지할 수 없다 — 2026-07-07 실측 사고.)
- `sessions` 비교는 키 순서에 무관한 정규 직렬화로 한다. Supabase(jsonb) 왕복 시 키 순서가 바뀌어 내용이 같아도 "변경됨"으로 잡히기 때문이다.

시간 변환: 소수 시간(`9`→`09:00`, `8.5`→`08:30`) 및 HHMM 정수(`1330`→`13:30`, `t>=100`일 때) 모두 스크립트가 처리한다.

---

## 4단계: 결과 보고

스크립트 출력을 아래 형식으로 정리해 보고한다.

```
✅ ax-hub 동기화 완료 — {OWNER_NAME} 담당

신규 추가: N건 / 정보 갱신: N건 / 변경 없음: N건
확인 필요(다른 담당자로 보임): N건  ← 삭제하지 않음, 목록만 안내

브라우저에서 F5를 누르면 업데이트된 내용을 확인할 수 있습니다.
```

동시편집 감지로 중단됐으면(exit 2) 스킬을 한 번 더 실행한다. 반복되면 사용자에게 수동 확인을 요청한다.

---

## 주의사항

- `mcp__ax-hub__query_sql`은 SELECT만 허용된다(read-only). `instructors.phone`은 권한상 차단되어 연락처는 가져올 수 없다.
- 칸반보드는 **일자별 보기**다 — 회차가 아니라 날짜 1개당 세션 1개, 각 날짜가 자기 시간·강사·튜터를 갖는다.
- 세션이 없는 교육은 `startAt`/`endAt` = `""`, `sessions`는 `dates: []`인 항목 1개.
- `data\.sync_payload_*.txt`는 임시 파일이다. 다음 실행이 덮어쓰므로 남아 있어도 무해하다.
- 브라우저 새로고침(F5) 전까지 화면에 반영되지 않는다.
