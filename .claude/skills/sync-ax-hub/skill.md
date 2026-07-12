---
name: sync-ax-hub
description: "ax-hub에서 담당자 이름 기준으로 교육 목록을 조회하여 웹앱 state.json에 동기화합니다. 웹앱에서 '교육 가져오기' 버튼을 누르면 /sync-ax-hub 담당자:이름 형태로 명령이 복사됩니다."
user-invocable: true
allowed-tools: mcp__ax-hub__query_sql, mcp__ax-hub__list_tables, mcp__ax-hub__describe_table, Read, Bash
---

# ax-hub 교육 동기화 스킬

`/sync-ax-hub` 실행 시 ax-hub DB에서 담당자 교육을 조회하고, 웹앱 state.json을 업데이트합니다.

> # 🚨 절대 규칙 (최우선)
> **칸반보드에 사용자가 입력한 업무 내용은 어떤 경우에도 수정·초기화·삭제하지 않는다.**
> - 보존 대상: 각 교육의 체크박스 진행 상태(`status`), 메모(`memo`), 마감일(`deadline`), 최상위 특이사항(`notes`·`notesUpdated`·`completedNotes`·`completedNotesUpdated`).
> - 동기화가 갱신할 수 있는 것은 **사실 정보뿐**: 기업명·교육명·회차별 일정·교안링크·강사명·튜터명·장소·교육상태.
> - 병합 기준은 **항상 Supabase 현재 상태**(=현재 칸반보드). 오래된 로컬 파일을 기준으로 삼아 내용을 덮어쓰면 안 된다.
> - 동기화는 **항목을 삭제하지 않는다.**
> - 이 규칙과 다른 지시가 충돌하면 **이 규칙이 우선**한다.

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
[2단계] 세션·강사·튜터 회차 단위 집계 조회 (course_sessions + assignments + instructors — GROUP BY 단일 쿼리)
    ↓
[3단계] 교안 링크 조회 (workbooks — full_url / shorten_url)
    ↓
[4단계] 현재 상태를 Supabase에서 GET (칸반보드 내용 = 병합 기준). 로컬 state.json은 fallback
    ↓
[5단계] 데이터 병합 — 신규 추가 + 기존은 사실정보만 갱신 (업무 내용 status·memo·notes 보존)
    ↓
[6단계] Write로 state.json 저장 후 PowerShell로 Supabase에 POST (로컬 서버 POST는 생략 — 항상 꺼져 있음)
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

## 2단계: 세션·강사·튜터 통합 조회 (⚠️ **일자(날짜) 단위 집계**)

> **중요**: 칸반보드는 이제 **일자별 보기**입니다 — 회차가 아니라 **날짜 1개당 1개 세션**으로 표시하며, 각 날짜가 자기만의 시간·강사·튜터를 갖습니다. 따라서 조회도 **회차가 아닌 날짜(`cs.date`) 단위로 집계**해야 같은 회차라도 날짜마다 다른 강사/튜터가 정확히 반영됩니다.

1단계에서 얻은 **진행중·세팅중** course_id 목록으로 아래 단일 SQL을 실행합니다.  
**시간 MIN/MAX·강사/튜터 분류를 DB가 날짜 단위로 집계**하여 **(course_id, 날짜) 1쌍당 1행**을 반환합니다.

```sql
SELECT
  cr.course_id,
  cs.date,
  MIN(cs.start_time) AS start_time,
  MAX(cs.end_time)   AS end_time,
  -- 주강사: qualification_id 앞 8자리로 필터
  array_agg(DISTINCT i.name) FILTER (
    WHERE left(a.qualification_id::text, 8) IN
      ('a7a605e9','888ee72c','07ecdab5','e39eeef7','ecdd7d85','7db139f7','2647f764')
  ) AS instructors,
  -- 기술튜터
  array_agg(DISTINCT i.name) FILTER (
    WHERE left(a.qualification_id::text, 8) IN
      ('30976fac','a0af4d4f','fc59bde4')
  ) AS tutors
FROM course_sessions cs
JOIN course_rounds cr      ON cs.round_id          = cr.id
LEFT JOIN assignments a    ON a.course_session_id  = cs.id
LEFT JOIN instructors i    ON a.instructor_id       = i.id
WHERE cr.course_id IN (/* 1단계 course_id 목록 */)
GROUP BY cr.course_id, cs.date
ORDER BY cr.course_id, cs.date;
```

각 행이 곧 **한 날짜(하루)의 완성된 집계 결과**입니다 — 모델은 별도 집계 없이 세션 1개로 매핑합니다:

- `date`: 수업일 `"YYYY-MM-DD"` (행 1개 = 날짜 1개)
- `start_time`: 그 날짜의 최소 시작시간(`double`) → `"HH:MM"` 변환
- `end_time`: 그 날짜의 최대 종료시간(`double`) → `"HH:MM"` 변환
- `instructors`: 그 날짜의 주강사 이름 배열 (배정 없으면 `null` → `""`). 여럿이면 `", "`로 join
- `tutors`: 그 날짜의 기술튜터 이름 배열 (배정 없으면 `null` → `""`). 여럿이면 `", "`로 join

시간 변환 규칙 (`start_time` / `end_time`):
- 소수 시간 형식: `9` = `"09:00"`, `13.5` = `"13:30"` → `HH = Math.floor(t)`, `MM = Math.round((t % 1) * 60)`
- HHMM 정수 형식(`t >= 100`, 예 `1330`): `HH = ⌊t ÷ 100⌋`, `MM = t % 100`
- `null`이면 `""` (빈 문자열)
- 세션이 없는 교육은 쿼리 결과에 행이 없으므로, `sessions`는 `dates = []`인 빈 항목 1개로 처리

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

## 4단계: 현재 상태 읽기 (⚠️ 병합 기준은 반드시 Supabase)

> **왜 중요한가**: 사용자는 웹앱(Vercel)에서 칸반보드를 편집하며, 그 내용(메모·체크 상태·특이사항)은 **Supabase에만** 저장됩니다. 로컬 `data\state.json`은 로컬 서버가 꺼져 있으면 갱신되지 않아 **오래된 빈 데이터**입니다. 로컬 파일을 병합 기준으로 삼으면 '교육 가져오기' 시 **보드 내용이 전부 지워집니다.** 따라서 병합 기준은 **반드시 Supabase의 현재 데이터**여야 합니다.

### 4-1. Supabase에서 현재 상태 GET (기준 데이터)

아래 PowerShell을 실행해 담당자의 현재 state를 Supabase에서 받아 `data\state.json`에 **덮어쓴 뒤** 그 파일을 Read 도구로 읽습니다. 이 값이 병합의 기준(base)입니다.

```powershell
$ownerName = '<OWNER_NAME>'  # 예: '송찬호'
$statePath = "G:\내 드라이브\Project_managing_tool\data\state.json"
$envPath   = "G:\내 드라이브\Project_managing_tool\.env"
$supabaseUrl = ""; $supabaseKey = ""
Get-Content $envPath | ForEach-Object {
    if ($_ -match '^SUPABASE_URL=(.+)$') { $supabaseUrl = $Matches[1].Trim().Trim("'").Trim('"') }
    if ($_ -match '^SUPABASE_KEY=(.+)$') { $supabaseKey = $Matches[1].Trim().Trim("'").Trim('"') }
}
$headers = @{ apikey = $supabaseKey; Authorization = "Bearer $supabaseKey" }
$url = "$supabaseUrl/rest/v1/user_states?owner=eq." + [Uri]::EscapeDataString($ownerName) + "&select=data"
$rows = Invoke-RestMethod -Uri $url -Headers $headers -Method GET -UserAgent "PowerShell-SyncAxHub/1.0"
if ($rows -and $rows.Count -gt 0 -and $rows[0].data) {
    # 백업 후 Supabase 데이터를 로컬에 반영 (병합 기준)
    if (Test-Path $statePath) { Copy-Item $statePath "$statePath.bak" -Force }
    $json = ($rows[0].data | ConvertTo-Json -Depth 100)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($statePath, $json, $utf8NoBom)
    Write-Host "Supabase 현재 상태를 기준으로 로드함 (companies: $($rows[0].data.companies.Count)건)"
} else {
    Write-Host "Supabase에 데이터 없음 — 로컬 state.json을 기준으로 사용"
}
```

- **성공(Supabase에 데이터 있음)**: 로컬 `state.json`이 방금 Supabase 내용으로 채워졌습니다. 이 파일을 Read 도구로 읽어 병합 기준으로 씁니다.
- **데이터 없음(신규 담당자 등)**: 기존 로컬 `state.json`을 그대로 기준으로 씁니다.
- **어떤 경우에도 메모·체크 상태·notes를 빈 값으로 덮어쓰지 마세요.**

### 4-2. 기존 항목 식별

읽어들인 companies 배열에서 **ax_hub_course_id** 필드 또는 **기업명+교육명 조합**으로 기존 항목을 식별합니다.

> 사용자 편집 필드(**절대 보존**): 각 company의 `status`(모든 체크값), `memo`, `deadline`, 그리고 최상위 `notes`·`notesUpdated`·`completedNotes`·`completedNotesUpdated`. 병합 시 이 값들은 기준 데이터에서 그대로 유지하고 ax-hub 정보로 덮어쓰지 않습니다.

---

## 5단계: 데이터 병합 규칙 (⚠️ 업무 내용 절대 불변 · 사실 정보만 갱신)

> **핵심 원칙 (2가지)**:
> 1. **업무 내용은 절대 바꾸지 않는다** — 각 company의 `status`(모든 체크박스 값), `memo`, `deadline`, 그리고 최상위 `notes`·`notesUpdated`·`completedNotes`·`completedNotesUpdated`는 기준 데이터의 값을 **그대로 보존**한다. 동기화가 이 값을 건드리거나 초기화하는 일은 없다.
> 2. **사실 정보만 갱신한다** — 기존 교육이든 신규 교육이든, ax-hub에서 가져오는 값은 **기업명·교육명·회차별 일정(sessions/시작·종료일)·교안링크·강사명·튜터명·장소·교육상태**뿐이다.
>
> **갱신 대상(ax-hub 정보) 필드**: `name`(기업명), `trainingName`(교육명), `sessions`(회차별 일정), `startAt`/`endAt`(일정에서 파생), `workbookUrl`(교안링크), `instructorName`(강사명), `tutorName`(튜터명), `location`(장소), `trainingStatus`(교육상태), `archived`.
> **보존 대상(업무 내용) 필드**: `status`, `memo`, `deadline`, `notes`, `notesUpdated`, `completedNotes`, `completedNotesUpdated`. — 절대 덮어쓰지 않음.

> 2단계 쿼리 결과(**날짜 1행** = `{ course_id, date, start_time, end_time, instructors[], tutors[] }`)와 3단계 교안 URL을 함께 사용합니다. **날짜 1행 → 세션 1개**로 매핑합니다(일자별 보기).

### 새 교육 (기준 데이터에 없는 course_id) — 신규 추가
- companies 배열에 새 항목 추가
- `id`: 현재 companies 최대 id + 1씩 증가
- `ax_hub_course_id`: ax-hub의 course_id 저장 (향후 재동기화 시 매칭용)
- `name`: client_name (기업명)
- `trainingName`: training_name (교육명)
- `instructorName`: 전체 날짜의 주강사 **고유 이름 집합**을 `", "`로 join (없으면 `""`) — 참고용 요약값
- `tutorName`: 전체 날짜의 기술튜터 **고유 이름 집합**을 `", "`로 join (없으면 `""`) — 참고용 요약값
- `location`: courses.place 값 (없으면 `""`)
- `trainingStatus`: course_status 매핑값
- `startAt`: 첫 날짜 + "T" + 그 날짜 startTime, 없으면 `""`
- `endAt`: 마지막 날짜 + "T" + 그 날짜 endTime, 없으면 `""`
- `workbookUrl`: 교안 단축 URL (없으면 `""`)
- `memo`: `""`
- `deadline`: `""`
- `archived`: `false` (closed/stopped는 이미 제외됨)
- `status`: 현재 state의 tasks 전부 0으로 초기화
- `sessions`: **날짜별 상세 배열** (아래 참조)

#### `sessions` 배열 항목 구조 (⚠️ 날짜 1개 = 항목 1개)
```json
{
  "id": "session_[companyId]_[n]",
  "dates": ["2026-03-17"],
  "startTime": "09:00",
  "endTime": "18:00",
  "instructorName": "채진백",
  "tutorName": "구현, 황석현"
}
```
- 2단계 쿼리 결과의 **날짜(행) 1개당 세션 1개**를 만듭니다. 날짜순 정렬.
- `id`: `"session_" + companyId + "_" + n` 형식 (n = 날짜 정렬 순서, 1부터). 예: `"session_3_1"`
- `dates`: `[해당 날짜]` — **원소 1개짜리 배열** (예: `["2026-03-17"]`)
- `startTime` / `endTime`: `"HH:MM"` 형식 (2단계 `start_time`/`end_time` 변환)
- `instructorName` / `tutorName`: **그 날짜의** 강사/튜터. 없으면 `""`. 여럿이면 `", "`로 join
- 세션 정보가 없는 교육은 `sessions: [{ id: "session_[id]_1", dates: [], startTime: "", endTime: "", instructorName: "", tutorName: "" }]`

### 기존 교육 (기준 데이터에 이미 있는 ax_hub_course_id) — 사실 정보만 갱신
**갱신 대상 필드만** ax-hub 최신 값으로 덮어씁니다:
- `name`, `trainingName`, `instructorName`, `tutorName`, `sessions`, `startAt`, `endAt`, `workbookUrl`, `location`, `trainingStatus`, `archived`

**업무 내용 필드는 기준 데이터 값을 그대로 유지**합니다 (절대 변경·초기화 금지):
- `status`(모든 체크박스), `memo`, `deadline`, 그리고 최상위 `notes`·`notesUpdated`·`completedNotes`·`completedNotesUpdated`

> 구현 방법: 기존 항목 객체를 복사한 뒤 **갱신 대상 필드만** 새 값으로 교체하고, 업무 내용 필드는 원래 객체 값을 그대로 둡니다. `sessions`는 **날짜별 항목**으로 재생성하며 `id`는 `"session_" + companyId + "_" + n`(날짜 정렬 순서) 형식입니다.

### ax_hub_course_id가 없는 기존 항목
사용자가 수동으로 추가한 항목이므로 **어떤 필드도** 건드리지 않습니다.

### 담당자 외 교육 — 삭제하지 말고 보고만
동기화는 **절대 항목을 삭제하지 않습니다.** 다른 담당자 소유로 보이는 항목(`ax_hub_course_id`가 있으나 이 담당자의 course_id 집합에 없음)이 발견되면, **삭제하지 말고** 결과 요약에 "확인 필요 항목"으로 목록만 알려줍니다. 실제 제거 여부는 사용자가 웹앱에서 직접 판단합니다.

> **담당자 소유 course_id 집합**: 1단계 쿼리를 `WHERE c.manager_email = 'MANAGER_EMAIL'` 조건만으로(상태 필터 없이) 실행해 얻은 **전체 course_id 목록**입니다.

---

## 6단계: API POST

### 6-1. Write 도구로 state.json 파일 저장

**Write 도구**를 사용하여 병합된 state JSON을 아래 경로에 저장합니다.  
(PowerShell 인라인 문자열로 한글을 넘기면 인코딩이 깨지므로, 파일 쓰기는 반드시 Write 도구를 사용합니다.)

- 경로: `G:\내 드라이브\Project_managing_tool\data\state.json`
- 내용: 병합된 state JSON (pretty-print, 들여쓰기 2칸)

### 6-2. PowerShell로 파일에서 읽어 Supabase POST

Write 도구로 파일 저장이 완료된 후, 아래 PowerShell을 **PowerShell 도구**로 실행합니다.  
JSON은 파일에서 읽으므로 한글 인코딩 문제가 없습니다.

> **로컬 서버 POST는 시도하지 않습니다.** 사용자 환경에서는 로컬 서버(`localhost:3000`)가 항상 꺼져 있는 것이 일상이라, 매번 연결을 시도했다 실패하는 데만 수 초가 낭비됩니다(2026-07-11 실측: `localhost` 기준 4236ms). 웹앱은 Vercel에 배포되어 있고 Supabase만 실제 동기화 대상이므로, 파일 저장(6-1) 후 곧바로 Supabase POST만 수행합니다.

```powershell
$ownerName = '<OWNER_NAME>'  # 예: '이다은', '송찬호'
$statePath = "G:\내 드라이브\Project_managing_tool\data\state.json"

# 파일에서 UTF-8로 읽기
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$json = [System.IO.File]::ReadAllText($statePath, $utf8NoBom)

# Supabase POST (Vercel 앱 동기화)
$envPath = "G:\내 드라이브\Project_managing_tool\.env"
$supabaseUrl = ""
$supabaseKey = ""
Get-Content $envPath | ForEach-Object {
    if ($_ -match '^SUPABASE_URL=(.+)$') { $supabaseUrl = $Matches[1].Trim().Trim("'").Trim('"') }
    if ($_ -match '^SUPABASE_KEY=(.+)$') { $supabaseKey = $Matches[1].Trim().Trim("'").Trim('"') }
}

if ($supabaseUrl -and $supabaseKey) {
    try {
        $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        $sbBody = '{"owner":' + ('"' + $ownerName + '"') + ',"data":' + $json + ',"updated_at":"' + $ts + '"}'
        $sbHeaders = @{
            apikey = $supabaseKey
            Authorization = "Bearer $supabaseKey"
            "Content-Type" = "application/json; charset=utf-8"
            Prefer = "resolution=merge-duplicates,return=representation"
        }
        # on_conflict=owner 필수: 없으면 PostgREST가 upsert 대상을 알 수 없어 갱신 없이 200을 반환할 수 있음
        # -UserAgent 필수: 기본 Invoke-RestMethod User-Agent는 Supabase가 "브라우저에서의 secret key 사용"으로 오인해 403 처리함
        $sbResp = Invoke-RestMethod -Uri "$supabaseUrl/rest/v1/user_states?on_conflict=owner" -Method POST -Headers $sbHeaders -Body ([System.Text.Encoding]::UTF8.GetBytes($sbBody)) -UserAgent "PowerShell-SyncAxHub/1.0"
        $companyCount = $sbResp[0].data.companies.Count
        Write-Host "Supabase POST 성공 — companies: $companyCount 건 반영 확인, Vercel 앱 동기화 완료"
    } catch {
        Write-Host "Supabase POST 실패: $($_.Exception.Message)"
        if ($_.ErrorDetails) { Write-Host $_.ErrorDetails.Message }
    }
} else {
    Write-Host "Supabase 자격증명 없음 — Vercel 동기화 건너뜀"
}
```

> **주의**: `return=representation`으로 실제 저장된 데이터를 응답받아 `companies` 건수를 확인해야 한다. `return=minimal`은 본문 없이 HTTP 200만 반환하므로, `on_conflict` 누락 등으로 데이터가 실제로 갱신되지 않았어도 "성공"처럼 보일 수 있다(2026-07-07 실측: 신규 교육 2건이 로컬 파일에는 저장됐으나 Supabase에는 반영되지 않은 채 200이 반환됨).

---

## 7단계: 결과 요약 출력

동기화 완료 후 아래 형식으로 출력합니다:

```
✅ ax-hub 동기화 완료 — {OWNER_NAME} 담당

신규 추가: N건
  - 기업명 | 교육명 | 강사명
  ...

정보 갱신: N건 (업무 내용은 보존, 사실 정보만 변경)
  - 기업명 | 교육명 | 변경된 항목(예: 튜터명, 회차 일정)
  ...

변경 없음: N건

확인 필요(다른 담당자로 보임): N건  ← 삭제하지 않음, 목록만 안내
  - 기업명 | 교육명
  ...

브라우저에서 F5를 누르면 업데이트된 내용을 확인할 수 있습니다.
```

---

## 주의사항

- `mcp__ax-hub__query_sql`은 SELECT만 허용됩니다 (read-only).
- **한글 인코딩 주의**: MCP 쿼리 결과가 크면 하네스가 UTF-8 파일로 저장합니다. PowerShell에서 읽을 때 `Get-Content` 기본 인코딩(CP949)으로 읽으면 한글이 깨집니다. 반드시 `[System.IO.File]::ReadAllText(path, [System.Text.Encoding]::UTF8)`을 사용하세요.
- 2단계 쿼리는 `GROUP BY cr.course_id, cs.date`로 **(교육, 날짜)당 1행**을 반환합니다(일자별 보기) — 시간 MIN/MAX·강사/튜터 분류가 DB에서 끝나므로 모델이 다시 집계하지 마세요. `date`는 스칼라, `instructors`/`tutors`는 배열로 옵니다(배정 없으면 `null`). **날짜 1행 → 세션 1개**로 매핑합니다.
- `array_agg(...) FILTER`와 `left(qualification_id::text, 8)`로 주강사/기술튜터를 분리합니다. qualification_id는 `uuid` 타입이라 `::text` 캐스팅이 필요합니다.
- `start_time` / `end_time`은 소수 시간(double). 변환 공식: `HH = Math.floor(t)`, `MM = Math.round((t % 1) * 60)`
- HHMM 정수(`1330` 등) 판별: `t >= 100` 이면 HHMM 형식으로 처리.
- 세션이 없는 교육은 `startAt`/`endAt` = `""`, `sessions` 배열은 dates가 빈 항목 1개로 초기화합니다.
- `sessions[i].id`는 `"session_" + companyId + "_" + (i+1)` 형식으로 생성합니다.
- **로컬 서버 POST는 시도하지 않습니다.** 사용자 환경에서 로컬 서버는 항상 꺼져 있어(2026-07-11 확인), `localhost:3000` 연결 시도는 실패까지 4초 이상 걸리는 순수 낭비입니다. 6-1에서 Write 도구로 파일만 저장하고, 6-2는 Supabase POST만 수행합니다.
- 브라우저 새로고침(F5) 전까지는 변경 내용이 화면에 반영되지 않습니다.
- **담당자 외 교육 금지**: state.json은 담당자 1명의 보드이므로, 5단계의 "담당자 외 교육 제거"를 반드시 수행해 다른 담당자의 ax-hub 교육이 섞이지 않게 합니다.
