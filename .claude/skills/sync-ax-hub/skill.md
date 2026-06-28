---
name: sync-ax-hub
description: "ax-hub에서 송찬호(chanho.song@teamsparta.co) 담당 교육 목록을 조회하여 웹앱 state.json에 동기화합니다. /sync-ax-hub 명령으로 실행."
user-invocable: true
allowed-tools: mcp__ax-hub__query_sql, mcp__ax-hub__list_tables, mcp__ax-hub__describe_table, Read, Bash
---

# ax-hub 교육 동기화 스킬

`/sync-ax-hub` 실행 시 ax-hub DB에서 송찬호 담당 교육을 조회하고, 웹앱 state.json을 업데이트합니다.

---

## 전체 흐름

```
[1단계] ax-hub에서 교육 목록 조회 (courses + deals + clients)
    ↓
[2단계] 각 교육의 강사·튜터 조회 (assignments + instructors)
    ↓
[3단계] 교육일자·시간 조회 (course_sessions — 첫/마지막 세션 기준)
    ↓
[3.5단계] 교안 링크 조회 (workbooks — full_url / shorten_url)
    ↓
[4단계] 현재 state.json 읽기 (기존 진행 상태 보존)
    ↓
[5단계] 데이터 병합 — 새 교육 추가, 기존 교육 정보 갱신
    ↓
[6단계] PowerShell로 http://localhost:3000/api/state 에 POST
    ↓
[7단계] 동기화 결과 요약 출력
```

---

## 1단계: 교육 목록 조회

아래 SQL을 `mcp__ax-hub__query_sql`로 실행합니다.

```sql
SELECT
  c.id          AS course_id,
  c.title       AS training_name,
  c.status      AS course_status,
  c.place       AS location,
  cl.name       AS client_name,
  c.lecture_start AS start_at,
  c.lecture_end   AS end_at
FROM courses c
JOIN deals d   ON c.deal_id    = d.id
JOIN clients cl ON d.client_id = cl.id
WHERE c.manager_email = 'chanho.song@teamsparta.co'
ORDER BY c.lecture_start NULLS LAST;
```

- `course_status` 값 매핑:
  - `setup` → `'세팅중'`
  - `operation` → `'교육중'`
  - `closed` → `''` (빈 문자열, 교육 완료)
- `location`: `courses.place` 값을 그대로 사용. NULL이면 `""`

---

## 2단계: 강사·튜터 조회


1단계에서 얻은 course_id 목록으로 아래 SQL을 실행합니다.  
course_id가 여러 개면 `IN (id1, id2, ...)` 형태로 한 번에 조회합니다.

```sql
SELECT
  cr.course_id,
  i.name            AS instructor_name,
  a.qualification_id
FROM assignments a
JOIN instructors i    ON a.instructor_id     = i.id
JOIN course_sessions cs ON a.course_session_id = cs.id
JOIN course_rounds cr   ON cs.round_id  = cr.id
WHERE cr.course_id IN (/* 1단계 course_id 목록 */)
ORDER BY cr.course_id, a.qualification_id;
```

- `qualification_id`가 `main_l3`, `main_l5`, `mentor_l1` → **주강사** (`instructorName`)
- `qualification_id`가 `tutor_l1`, `tutor_l2`, `tutor_l3` → **기술튜터** (`tutorName`)
- 중복 이름은 제거합니다.
- 각 course_id별로:
  - `instructorName`: 주강사 이름을 `", "` 로 연결
  - `tutorName`: 튜터 이름을 `", "` 로 연결 (없으면 `""`)

---

## 3단계: 교육일자·시간 조회

1단계 course_id 목록으로 아래 SQL을 실행합니다.

```sql
SELECT
  cr.course_id,
  cs.date,
  cs.start_time,
  cs.end_time
FROM course_sessions cs
JOIN course_rounds cr ON cs.round_id = cr.id
WHERE cr.course_id IN (/* 1단계 course_id 목록 */)
ORDER BY cr.course_id, cs.date, cs.start_time;
```

- `start_time` / `end_time`은 소수 시간 형식 (예: `9` = 09:00, `13.5` = 13:30, `17.5` = 17:30)
- 각 course_id별로:
  - `startAt`: 날짜 오름차순 첫 번째 세션의 `date` + `start_time` → `"YYYY-MM-DDTHH:MM"`
  - `endAt`: 날짜 내림차순 마지막 세션의 `date` + `end_time` → `"YYYY-MM-DDTHH:MM"`
- 소수 시간 → HH:MM 변환: 정수부 = 시, 소수부 × 60 = 분 (예: `13.5` → `"13:30"`)
- 세션이 없으면 `startAt` / `endAt` 모두 `""`

---

## 3.5단계: 교안 링크 조회

1단계 course_id 목록으로 아래 SQL을 실행합니다.

```sql
SELECT
  course_id,
  title       AS workbook_title,
  shorten_url AS workbook_url
FROM workbooks
WHERE course_id IN (/* 1단계 course_id 목록 */);
```

- `shorten_url`을 `workbookUrl` 필드로 사용합니다 (예: `"https://b2bsparta.com/0608-551"`).
- `shorten_url`이 NULL인 경우 `full_url`을 사용합니다. 둘 다 NULL이면 `""`.
- 교안이 없는 교육(workbooks 행이 없는 course_id)은 `workbookUrl: ""`.

---

## 4단계: 현재 state.json 읽기

`G:\내 드라이브\Project_managing_tool\data\state.json` 을 Read 도구로 읽습니다.

기존 companies 배열에서 **ax_hub_course_id** 필드 또는 **기업명+교육명 조합**으로 기존 항목을 식별합니다.

---

## 5단계: 데이터 병합 규칙

### 새 교육 (기존 state에 없는 course_id)
- companies 배열에 새 항목 추가
- `id`: 현재 companies 최대 id + 1씩 증가
- `ax_hub_course_id`: ax-hub의 course_id 저장 (향후 재동기화 시 매칭용)
- `name`: client_name (기업명)
- `trainingName`: training_name (교육명)
- `instructorName`: 주강사 이름
- `tutorName`: 기술튜터 이름을 `", "` 로 연결 (없으면 `""`)
- `location`: courses.place 값 (없으면 `""`)
- `trainingStatus`: course_status 매핑값
- `startAt`: `"YYYY-MM-DDTHH:MM"` 형식 (없으면 `""`)
- `endAt`: `"YYYY-MM-DDTHH:MM"` 형식 (없으면 `""`)
- `workbookUrl`: 교안 단축 URL (없으면 `""`)
- `memo`: 튜터 정보
- `deadline`: `""`
- `archived`: `course_status === 'closed'`이면 `true`, 아니면 `false`
- `status`: 현재 state의 tasks 전부 0으로 초기화

### 기존 교육 (ax_hub_course_id로 매칭되는 항목)
아래 필드만 갱신하고 나머지(status, memo 등 사용자가 편집한 내용)는 유지합니다:
- `trainingName`, `instructorName`, `tutorName`, `location`, `trainingStatus`, `startAt`, `endAt`, `archived`, `workbookUrl`
- `name` (client_name이 변경된 경우)

### ax_hub_course_id가 없는 기존 항목
사용자가 수동으로 추가한 항목이므로 건드리지 않습니다.

---

## 6단계: API POST

아래 PowerShell을 Bash 도구로 실행합니다.  
`$json` 변수에 병합된 state 전체를 JSON 문자열로 넣어 POST합니다.

```powershell
$json = '<병합된 state JSON>'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$req = [System.Net.WebRequest]::Create("http://localhost:3000/api/state")
$req.Method = "POST"
$req.ContentType = "application/json; charset=utf-8"
$req.ContentLength = $bytes.Length
$stream = $req.GetRequestStream()
$stream.Write($bytes, 0, $bytes.Length)
$stream.Close()
$resp = $req.GetResponse()
Write-Host "HTTP $([int]$resp.StatusCode) $($resp.StatusDescription)"
$resp.Close()
```

POST 실패 시 (서버가 꺼져 있는 경우):  
파일에 직접 쓰는 fallback으로 `[System.IO.File]::WriteAllText("G:\내 드라이브\Project_managing_tool\data\state.json", $json, [System.Text.Encoding]::UTF8)` 를 실행하고 사용자에게 안내합니다.

---

## 7단계: 결과 요약 출력

동기화 완료 후 아래 형식으로 출력합니다:

```
✅ ax-hub 동기화 완료

신규 추가: N건
  - 기업명 | 교육명 | 강사명
  ...

갱신됨: N건
  - 기업명 | 교육명 | 변경 내용
  ...

변경 없음: N건

브라우저에서 F5를 누르면 업데이트된 내용을 확인할 수 있습니다.
```

---

## 주의사항

- `mcp__ax-hub__query_sql`은 SELECT만 허용됩니다 (read-only).
- `start_time` / `end_time`은 소수 시간(double). 변환 공식: `HH = Math.floor(t)`, `MM = Math.round((t % 1) * 60)`
- 세션이 없는 교육은 `startAt` / `endAt` 모두 `""`으로 처리합니다.
- 서버가 실행 중이지 않으면 파일 직접 쓰기로 fallback합니다.
- 브라우저 새로고침(F5) 전까지는 변경 내용이 화면에 반영되지 않습니다.
