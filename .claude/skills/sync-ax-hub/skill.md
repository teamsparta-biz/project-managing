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
[2단계] 세션·강사·튜터 통합 조회 (course_sessions + assignments + instructors — 단일 쿼리)
    ↓
[3단계] 교안 링크 조회 (workbooks — full_url / shorten_url)
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
- 이 쿼리 결과의 **전체 course_id 목록(모든 상태 포함)** 을 "담당자 소유 course_id 집합"으로 보관합니다. 5단계의 **담당자 외 교육 제거**에서 사용합니다.

---

## 2단계: 세션·강사·튜터 통합 조회

1단계에서 얻은 **진행중·세팅중** course_id 목록으로 아래 단일 SQL을 실행합니다.  
날짜/시간 + 강사/튜터를 한 번에 조회합니다 (기존 2단계 + 3단계 통합).

```sql
SELECT
  cr.course_id,
  cr.round_number,
  cs.date,
  cs.start_time,
  cs.end_time,
  i.name            AS instructor_name,
  a.qualification_id
FROM course_sessions cs
JOIN course_rounds cr      ON cs.round_id          = cr.id
LEFT JOIN assignments a    ON a.course_session_id  = cs.id
LEFT JOIN instructors i    ON a.instructor_id       = i.id
WHERE cr.course_id IN (/* 1단계 course_id 목록 */)
ORDER BY cr.course_id, cr.round_number, cs.date;
```

> `LEFT JOIN`을 사용하므로 강사가 배정되지 않은 세션도 날짜 행이 포함됩니다.  
> 한 세션에 강사가 여럿이면 같은 날짜 행이 여러 번 나타납니다 — 날짜 중복 제거가 필요합니다.

조회 결과를 `course_id → round_number → { dates: Set, startTimes: [], endTimes: [], main: Set, tutor: Set }` 으로 집계합니다:

**날짜/시간**
- `dates`: 해당 회차의 모든 날짜를 `"YYYY-MM-DD"` 형식으로 수집 (중복 제거, 오름차순)
- `startTime`: 해당 회차 rows 중 MIN(start_time) → `"HH:MM"` 변환
- `endTime`: 해당 회차 rows 중 MAX(end_time) → `"HH:MM"` 변환

**강사/튜터** (qualification_id UUID 앞 8자리 기준)
- **주강사** (`instructorName`): `a7a605e9`, `888ee72c`, `07ecdab5`, `e39eeef7`, `ecdd7d85`, `7db139f7`, `2647f764`
- **기술튜터** (`tutorName`): `30976fac`, `a0af4d4f`, `fc59bde4`
- 중복 이름 제거 (Set 사용)

시간 변환 규칙:
- `start_time` / `end_time`은 소수 시간 형식 (예: `9` = 09:00, `13.5` = 13:30)
- 간혹 HHMM 정수 형식(`1330`)이 있는 경우: `HH = t ÷ 100`, `MM = t % 100`
- 시간이 null이면 `""` (빈 문자열)
- 세션이 없는 교육은 dates = [], startTime = "", endTime = ""

---

## 3단계: 교안 링크 조회

1단계 course_id 목록으로 아래 SQL을 실행합니다.

```sql
SELECT
  course_id,
  title       AS workbook_title,
  shorten_url AS workbook_url,
  full_url
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

> 2단계 집계 결과(`course_id → round_number → { dates, startTime, endTime, main, tutor }`)와 3단계 교안 URL을 함께 사용합니다.

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
- `startAt`: sessions[0].dates[0] + "T" + sessions[0].startTime (첫 회차 첫 날짜 + 시작시간), 없으면 `""`
- `endAt`: 마지막 회차 마지막 날짜 + "T" + 마지막 회차 endTime, 없으면 `""`
- `workbookUrl`: 교안 단축 URL (없으면 `""`)
- `memo`: `""`
- `deadline`: `""`
- `archived`: `false` (closed/stopped는 이미 제외됨)
- `status`: 현재 state의 tasks 전부 0으로 초기화
- `sessions`: 회차별 상세 배열 (아래 참조)

#### `sessions` 배열 항목 구조
```json
{
  "id": "session_[companyId]_[roundNumber]",
  "dates": ["2026-03-17", "2026-03-24", "2026-03-31"],
  "startTime": "09:00",
  "endTime": "18:00",
  "instructorName": "채진백",
  "tutorName": "구현, 황석현"
}
```
- `id`: `"session_" + companyId + "_" + roundNumber` 형식 (예: `"session_3_1"`)
- `dates`: 해당 회차의 모든 수업 날짜 배열 (3단계에서 수집한 dates)
- `startTime` / `endTime`: `"HH:MM"` 형식 (3단계에서 변환)
- 강사/튜터 정보가 없는 회차는 `""` 으로 채웁니다.
- 회차별로 강사/튜터가 동일해도 sessions 배열에 항목을 추가합니다.
- 세션 정보가 없는 교육은 `sessions: [{ id: "session_[id]_1", dates: [], startTime: "", endTime: "", instructorName: "", tutorName: "" }]`

### 기존 교육 (ax_hub_course_id로 매칭되는 항목)
아래 필드만 갱신하고 나머지(status, memo 등 사용자가 편집한 내용)는 유지합니다:
- `trainingName`, `instructorName`, `tutorName`, `location`, `trainingStatus`, `startAt`, `endAt`, `archived`, `workbookUrl`, `sessions`
- `name` (client_name이 변경된 경우)

### ax_hub_course_id가 없는 기존 항목
사용자가 수동으로 추가한 항목이므로 건드리지 않습니다.

### ⚠️ 담당자 외 교육 제거 (필수)
state.json은 **해당 담당자 1명의 보드**입니다. 따라서 담당자가 맡지 않은 ax-hub 교육이 섞이면 안 됩니다.

병합을 마친 뒤, companies 배열에서 아래 조건을 **모두 만족하지 않는** 항목은 **삭제**합니다:
- `ax_hub_course_id`가 없음 (사용자 수동 추가 항목 → 보존), **또는**
- `ax_hub_course_id`가 **이 담당자의 course_id 집합**에 포함됨

즉, `ax_hub_course_id`가 있는데 그 값이 **담당자 소유 course_id 집합에 없으면 다른 담당자의 교육**이므로 제거합니다.

> **담당자 소유 course_id 집합**: 1단계 쿼리를 `WHERE c.manager_email = 'MANAGER_EMAIL'` 조건만으로(상태 필터 없이) 실행해 얻은 **전체 course_id 목록**입니다. closed/stopped 교육은 칸반보드에 표시하지 않지만(제외 대상), 소유 집합 판정에는 포함하므로 "내 종료 교육"이 남아 있더라도 삭제되지 않습니다. 칸반보드 표시 제외는 `archived=true`로 처리합니다.

이 제거는 PowerShell로 일괄 처리하는 것이 안전합니다 (대량 항목 필터링). 처리 전 `state.json.bak`로 백업한 뒤, 보존/제거 건수와 제거된 항목 목록을 사용자에게 보고합니다.

---

## 6단계: API POST

### 6-1. Write 도구로 state.json 파일 저장

**Write 도구**를 사용하여 병합된 state JSON을 아래 경로에 저장합니다.  
(PowerShell 인라인 문자열로 한글을 넘기면 인코딩이 깨지므로, 파일 쓰기는 반드시 Write 도구를 사용합니다.)

- 경로: `G:\내 드라이브\Project_managing_tool\data\state.json`
- 내용: 병합된 state JSON (pretty-print, 들여쓰기 2칸)

### 6-2. PowerShell로 파일에서 읽어 POST

Write 도구로 파일 저장이 완료된 후, 아래 PowerShell을 **PowerShell 도구**로 실행합니다.  
JSON은 파일에서 읽으므로 한글 인코딩 문제가 없습니다.

```powershell
$ownerName = '<OWNER_NAME>'  # 예: '이다은', '송찬호'
$statePath = "G:\내 드라이브\Project_managing_tool\data\state.json"

# 파일에서 UTF-8로 읽기
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$json = [System.IO.File]::ReadAllText($statePath, $utf8NoBom)

# ① 로컬 서버 POST
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
    Write-Host "로컬 서버 미실행 — 파일은 이미 저장됨"
}

# ② Supabase POST (Vercel 앱 동기화)
$envPath = "G:\내 드라이브\Project_managing_tool\.env"
$supabaseUrl = ""
$supabaseKey = ""
Get-Content $envPath | ForEach-Object {
    if ($_ -match '^SUPABASE_URL=(.+)$') { $supabaseUrl = $Matches[1].Trim() }
    if ($_ -match '^SUPABASE_KEY=(.+)$') { $supabaseKey = $Matches[1].Trim() }
}

if ($supabaseUrl -and $supabaseKey) {
    try {
        $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        $sbBody = '{"owner":' + ('"' + $ownerName + '"') + ',"data":' + $json + ',"updated_at":"' + $ts + '"}'
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
- **한글 인코딩 주의**: MCP 쿼리 결과가 크면 하네스가 UTF-8 파일로 저장합니다. PowerShell에서 읽을 때 `Get-Content` 기본 인코딩(CP949)으로 읽으면 한글이 깨집니다. 반드시 `[System.IO.File]::ReadAllText(path, [System.Text.Encoding]::UTF8)`을 사용하세요.
- 2단계 통합 쿼리는 LEFT JOIN이므로 강사 미배정 세션도 포함됩니다. 날짜 집계 시 반드시 중복 제거(Set)를 적용하세요.
- `start_time` / `end_time`은 소수 시간(double). 변환 공식: `HH = Math.floor(t)`, `MM = Math.round((t % 1) * 60)`
- HHMM 정수(`1330` 등) 판별: `t >= 100` 이면 HHMM 형식으로 처리.
- 세션이 없는 교육은 `startAt`/`endAt` = `""`, `sessions` 배열은 dates가 빈 항목 1개로 초기화합니다.
- `sessions[i].id`는 `"session_" + companyId + "_" + (i+1)` 형식으로 생성합니다.
- 서버가 실행 중이지 않으면 파일 직접 쓰기로 fallback합니다.
- 브라우저 새로고침(F5) 전까지는 변경 내용이 화면에 반영되지 않습니다.
- **담당자 외 교육 금지**: state.json은 담당자 1명의 보드이므로, 5단계의 "담당자 외 교육 제거"를 반드시 수행해 다른 담당자의 ax-hub 교육이 섞이지 않게 합니다.
