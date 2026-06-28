---
name: sync-ax-hub
description: "ax-hub에서 담당자 이름 기준으로 교육 목록을 조회하여 웹앱 state.json에 동기화합니다. 웹앱에서 '교육 가져오기' 버튼을 누르면 /sync-ax-hub 담당자:이름 형태로 명령이 복사됩니다."
user-invocable: true
allowed-tools: mcp__ax-hub__query_sql, mcp__ax-hub__list_tables, mcp__ax-hub__describe_table, Read, Bash
---

# ax-hub 교육 동기화 스킬

`/sync-ax-hub` 실행 시 ax-hub DB에서 담당자 교육을 조회하고, 웹앱 state.json을 업데이트합니다.

---

## 인수 파싱

명령에서 다음 인수를 추출합니다:
- `담당자:이름` → `OWNER_NAME` (예: `이다은`)

인수가 없거나 이름이 없으면 사용자에게 담당자 이름을 물어보세요.

---

## 전체 흐름

```
[0단계] profiles 테이블에서 담당자 이름 → 이메일 조회
    ↓
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

## 0단계: 담당자 이름 → 이메일 조회

아래 SQL을 실행하여 `OWNER_NAME`에 해당하는 이메일(`MANAGER_EMAIL`)을 얻습니다.

```sql
SELECT email FROM profiles
WHERE display_name = 'OWNER_NAME'
  AND email LIKE '%teamsparta.co'
LIMIT 1;
```

- 결과가 없으면 사용자에게 "ax-hub에 등록된 이름과 정확히 일치해야 합니다"라고 안내하고 중단합니다.
- 조회된 `email` 값을 이후 단계에서 `MANAGER_EMAIL`로 사용합니다.

---

## 1단계: 교육 목록 조회

아래 SQL을 `mcp__ax-hub__query_sql`로 실행합니다.  
`MANAGER_EMAIL` 자리에 0단계에서 조회한 이메일을 넣으세요.

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
WHERE c.manager_email = 'MANAGER_EMAIL'
ORDER BY c.lecture_start NULLS LAST;
```

- `course_status` 값 매핑:
  - `setup` → `'세팅중'`
  - `operation` → `'교육중'`
  - `closed` → archived=true (칸반보드에 표시 안 함)
  - `stopped` → archived=true (칸반보드에 표시 안 함)
- **closed / stopped 상태 교육은 이후 단계에서 제외합니다** (진행중·세팅중만 처리).
- `location`: `courses.place` 값을 그대로 사용. NULL이면 `""`

---

## 2단계: 회차별 강사·튜터 조회

1단계에서 얻은 **진행중·세팅중** course_id 목록으로 아래 SQL을 실행합니다.  
`cr.round_number`를 포함시켜 **회차별로 강사/튜터를 구분**합니다.

```sql
SELECT
  cr.course_id,
  cr.round_number,
  i.name            AS instructor_name,
  a.qualification_id
FROM assignments a
JOIN instructors i    ON a.instructor_id     = i.id
JOIN course_sessions cs ON a.course_session_id = cs.id
JOIN course_rounds cr   ON cs.round_id  = cr.id
WHERE cr.course_id IN (/* 1단계 course_id 목록 */)
ORDER BY cr.course_id, cr.round_number, a.qualification_id;
```

qualification_id UUID 앞 8자리 기준 분류:
- **주강사** (`instructorName`): `a7a605e9`, `888ee72c`, `07ecdab5`, `e39eeef7`, `ecdd7d85`, `7db139f7`, `2647f764`
- **기술튜터** (`tutorName`): `30976fac`, `a0af4d4f`, `fc59bde4`

결과를 `course_id → round_number → {main: Set, tutor: Set}` 으로 집계합니다 (중복 이름 제거).

---

## 3단계: 회차별 교육일자·시간 조회

1단계 course_id 목록으로 아래 SQL을 실행합니다. **`round_number`로 그룹화**해 회차별 첫/마지막 날짜를 구합니다.

```sql
SELECT
  cr.course_id,
  cr.round_number,
  MIN(cs.date)       AS start_date,
  MIN(cs.start_time) AS start_time,
  MAX(cs.date)       AS end_date,
  MAX(cs.end_time)   AS end_time
FROM course_sessions cs
JOIN course_rounds cr ON cs.round_id = cr.id
WHERE cr.course_id IN (/* 1단계 course_id 목록 */)
GROUP BY cr.course_id, cr.round_number
ORDER BY cr.course_id, cr.round_number;
```

- `start_time` / `end_time`은 소수 시간 형식 (예: `9` = 09:00, `13.5` = 13:30)
- 간혹 HHMM 정수 형식(`1330`)이 있는 경우: `HH = t ÷ 100`, `MM = t % 100`
- 회차별 `startAt` = `start_date` + `T` + `start_time` → `"YYYY-MM-DDTHH:MM"`
- 회차별 `endAt`   = `end_date`   + `T` + `end_time`   → `"YYYY-MM-DDTHH:MM"`
- 시간이 null이면 날짜만 사용 (`"YYYY-MM-DD"`)
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
- `instructorName`: 회차가 1개면 강사명 그대로, 여러 회차면 `"1회차: A / 2회차: B"` 형식
- `tutorName`: 회차가 1개면 튜터명 그대로, 여러 회차면 `"1회차: X / 2회차: Y"` 형식 (없으면 `""`)
- `location`: courses.place 값 (없으면 `""`)
- `trainingStatus`: course_status 매핑값
- `startAt`: 전체 교육의 첫 회차 startAt
- `endAt`: 전체 교육의 마지막 회차 endAt
- `workbookUrl`: 교안 단축 URL (없으면 `""`)
- `memo`: `""`
- `deadline`: `""`
- `archived`: `false` (closed/stopped는 이미 제외됨)
- `status`: 현재 state의 tasks 전부 0으로 초기화
- `rounds`: 회차별 상세 배열 (아래 참조)

#### `rounds` 배열 항목 구조
```json
{
  "roundNumber": 1,
  "instructorName": "채진백",
  "tutorName": "구현, 황석현",
  "startAt": "2026-03-17T09:00",
  "endAt": "2026-06-30T18:00"
}
```
- 회차별로 강사/튜터가 동일해도 rounds 배열에 항목을 추가합니다.
- 강사/튜터 정보가 없는 회차는 `""` 으로 채웁니다.

### 기존 교육 (ax_hub_course_id로 매칭되는 항목)
아래 필드만 갱신하고 나머지(status, memo 등 사용자가 편집한 내용)는 유지합니다:
- `trainingName`, `instructorName`, `tutorName`, `location`, `trainingStatus`, `startAt`, `endAt`, `archived`, `workbookUrl`, `rounds`
- `name` (client_name이 변경된 경우)

### ax_hub_course_id가 없는 기존 항목
사용자가 수동으로 추가한 항목이므로 건드리지 않습니다.

---

## 6단계: API POST

아래 PowerShell을 **PowerShell 도구**로 실행합니다.  
`$json` 변수에 병합된 state 전체를 JSON 문자열로 넣고,  
`$ownerName` 변수에 파싱한 `OWNER_NAME`을 넣어 **① 로컬 서버**, **② Supabase(Vercel 앱)** 두 곳에 순서대로 POST합니다.

```powershell
$json = '<병합된 state JSON>'
$ownerName = '<OWNER_NAME>'  # 예: '이다은', '송찬호'
$statePath = "G:\내 드라이브\Project_managing_tool\data\state.json"

# ① 로컬 서버 POST (실패 시 파일 직접 쓰기)
try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $req = [System.Net.WebRequest]::Create("http://localhost:3000/api/state?owner=" + [Uri]::EscapeDataString($ownerName))
    $req.Method = "POST"
    $req.ContentType = "application/json; charset=utf-8"
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $resp = $req.GetResponse()
    Write-Host "로컬 POST 성공: HTTP $([int]$resp.StatusCode)"
    $resp.Close()
} catch {
    Write-Host "로컬 서버 미실행 — 파일 직접 쓰기로 fallback"
    [System.IO.File]::WriteAllText($statePath, $json, [System.Text.Encoding]::UTF8)
    Write-Host "파일 쓰기 완료: $statePath"
}

# ② Supabase POST (Vercel 앱 동기화)
# .env에서 자격증명 읽기
$envPath = "G:\내 드라이브\Project_managing_tool\.env"
$supabaseUrl = ""
$supabaseKey = ""
Get-Content $envPath | ForEach-Object {
    if ($_ -match '^SUPABASE_URL=(.+)$') { $supabaseUrl = $Matches[1].Trim() }
    if ($_ -match '^SUPABASE_KEY=(.+)$') { $supabaseKey = $Matches[1].Trim() }
}

if ($supabaseUrl -and $supabaseKey) {
    try {
        $sbBody = "{`"owner`":`"$ownerName`",`"data`":$json,`"updated_at`":`"$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffZ')`"}"
        $sbBytes = [System.Text.Encoding]::UTF8.GetBytes($sbBody)
        $sbReq = [System.Net.WebRequest]::Create("$supabaseUrl/rest/v1/user_states")
        $sbReq.Method = "POST"
        $sbReq.ContentType = "application/json; charset=utf-8"
        $sbReq.ContentLength = $sbBytes.Length
        $sbReq.Headers.Add("apikey", $supabaseKey)
        $sbReq.Headers.Add("Authorization", "Bearer $supabaseKey")
        $sbReq.Headers.Add("Prefer", "resolution=merge-duplicates,return=minimal")
        $sbStream = $sbReq.GetRequestStream()
        $sbStream.Write($sbBytes, 0, $sbBytes.Length)
        $sbStream.Close()
        $sbResp = $sbReq.GetResponse()
        Write-Host "Supabase POST 성공: HTTP $([int]$sbResp.StatusCode) — Vercel 앱 동기화 완료"
        $sbResp.Close()
    } catch {
        Write-Host "Supabase POST 실패: $($_.Exception.Message)"
    }
} else {
    Write-Host "Supabase 자격증명 없음 — Vercel 동기화 건너뜀"
}
```

---

## 7단계: 결과 요약 출력

동기화 완료 후 아래 형식으로 출력합니다:

```
✅ ax-hub 동기화 완료 — {OWNER_NAME} 담당

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
