---
name: padlet-post-upload
description: "교육명(기업명)을 받아 Notion 교안 페이지에서 교안 링크·사전 설문조사·만족도 설문조사 링크를 찾고, 제목이 일치하는 Padlet 보드를 찾아 알맞은 섹션에 게시물로 자동 업로드합니다. 실습 결과물 업로드용 패들렛 단축 URL도 Notion 페이지에 함께 기록합니다. 보드 생성·제목 수정, 단축 URL 실제 등록은 Padlet 웹에서 직접 하고, 그 다음부터를 자동화합니다. /padlet-post-upload 명령으로 실행하며, 검수 후 업로드합니다."
argument-hint: "[교육명 또는 기업명, 또는 board_id/URL]"
user-invocable: true
allowed-tools: Read, PowerShell, mcp__claude_ai_Notion__notion-search, mcp__claude_ai_Notion__notion-fetch, mcp__claude_ai_Notion__notion-update-page
---

# 패들렛 게시물 업로드 스킬

Padlet 공식 API(`docs.padlet.dev`)는 **보드를 템플릿으로 복제하거나 제목을 수정하는 기능, 게시물 수정/삭제를 지원하지 않습니다** (2026-07-12 확인: 게시물 수정·삭제는 `401 You must use a zapier integration` 반환). 그래서 이 스킬은 **"Notion에서 링크 수집 → 알맞은 보드/섹션에 게시물 업로드"까지만** 자동화합니다. 보드 생성(템플릿 복제)과 제목 수정은 사용자가 Padlet 웹에서 먼저 완료해야 합니다.

> **트리거**: "패들렛에 게시물 올려줘", "이 교육 패들렛 채워줘", "노션 링크 패들렛에 붙여줘" 등 요청 시, 또는 `/padlet-post-upload` 명령 입력 시.

---

## 사전 준비

1. Padlet 웹에서 템플릿 보드를 복제하고 제목을 `[기업명] ...` 형태로 수정 완료 (API 불가 영역, 사용자가 먼저 처리)
2. `.env`에 `PADLET_API_KEY` 설정 (루트 `.env`)
3. Notion에 해당 교육의 교안 페이지가 존재하고, 본문에 "교안 링크", "교육 사전 설문조사", "교육 만족도 설문조사" 항목이 링크와 함께 있어야 함

---

## 전체 흐름

```
[1] 교육명/기업명 확인 (인자 또는 질문)
    ↓
[2] Notion에서 교안 페이지 검색 → 3개 링크 추출 (교안 링크 / 사전 설문조사 / 만족도 설문조사)
    ↓
[3] "실습 결과물 업로드" 오른쪽에 패들렛 단축 URL 작성 (Notion 페이지 수정)
    ↓
[4] Padlet 보드 검색: GET /v1/me?include=boards → title에 교육명/기업명 포함된 보드 찾기
    (동명 다건이면 createdAt 최신순으로 후보 제시 → 사용자 확인)
    ↓
[5] 보드 섹션 조회: GET /v1/boards/{board_id}?include=sections
    → title에 "교안" 포함 섹션, "만족도" 포함 섹션 각각 매칭
    ↓
[6] 게시물 구성 미리보기 → 사용자 검수
    ↓
[7] "검수완료" 입력 → PowerShell로 Padlet API POST (게시물별 순차 호출)
    ↓
[8] 결과 요약 출력
```

---

## 1단계: 교육명 확인

명령 인자로 교육명/기업명이 오면 그 값을 사용. 없으면 사용자에게 물어봅니다. board_id를 이미 알고 있다면 3~4단계를 건너뛰고 바로 5단계(섹션 조회)로 갑니다.

---

## 2단계: Notion에서 링크 수집

1. `mcp__claude_ai_Notion__notion-search`로 교육명을 검색해 교안 페이지를 찾습니다 (보통 워크북/교안 카드 데이터소스 안의 페이지).
2. `mcp__claude_ai_Notion__notion-fetch`로 본문을 가져와 아래 세 항목을 키워드로 찾아 링크를 추출합니다 (제목 이모지·문구는 교육마다 조금씩 다를 수 있으니 키워드 포함 여부로 매칭):
   - **교안 링크** (예: `### 📚 교안 링크 : [url](url)`)
   - **교육 사전 설문조사** (예: `### 🖥️ 교육 사전 설문조사 : [url](url)`)
   - **교육 만족도 설문조사** (예: `### ⭐ 교육 만족도 설문조사 : [url](url)`)
3. 셋 중 못 찾은 항목이 있으면 사용자에게 어떤 항목이 없는지 알리고, 나머지만 진행할지 확인합니다.
4. 검색 결과가 0건이면 사용자에게 정확한 Notion 페이지 URL을 물어봅니다. 여러 건이면(동명의 다른 교육 등) 후보 제목·URL 목록을 보여주고 어떤 페이지인지 확인받습니다 (4단계 보드 다건 매칭과 동일한 방식).

---

## 3단계: "실습 결과물 업로드" 단축 URL 작성 (Notion)

Padlet 보드에는 `padlet.com/biz14/{영문 슬러그}` 형태의 단축 URL을 직접 설정할 수 있습니다(보드 설정 > 고급 > URL 단축, 사용자가 Padlet 웹에서 직접 처리 — API로는 불가능). 이 스킬은 그 단축 URL을 **Notion 페이지의 "실습 결과물 업로드" 줄 오른쪽에 미리 적어두는 것**까지만 자동화합니다.

1. 기업명을 영문 슬러그로 변환합니다 (예: 삼성증권 → `samsung`, `samsungpop` 등). 한글 기업명의 로마자 표기는 여러 후보가 나올 수 있으므로, **추정한 슬러그를 사용자에게 보여주고 확정받습니다** (임의로 확정하지 않음). 이미 같은 회사로 과거에 사용한 슬러그가 있으면(예: 이전 교육에서 `samsung_finance` 사용 이력) 그 값을 우선 후보로 제시합니다.
2. 최종 URL은 `https://padlet.com/biz14/{확정된 슬러그}` 형태입니다.
3. `mcp__claude_ai_Notion__notion-fetch`로 가져온 본문에서 "실습 결과물 업로드" 줄의 기존 텍스트(`old_str`)를 그대로 복사해두고, `mcp__claude_ai_Notion__notion-update-page`를 `command: "update_content"`로 호출해 그 줄만 새 URL이 포함된 텍스트로 교체합니다. 예:
   ```
   old_str: "### 🎨 실습 결과물 업로드 : [https://padlet.com/biz14/old](https://padlet.com/biz14/old)"
   new_str: "### 🎨 실습 결과물 업로드 : [https://padlet.com/biz14/samsungpop](https://padlet.com/biz14/samsungpop)"
   ```
   해당 줄에 아직 URL이 없다면(빈 값) `insert_content`나 `update_content`로 줄 끝에 링크를 추가합니다.
4. **반드시 사용자에게 안내**: "Notion에는 적어뒀지만, 실제로 이 주소가 동작하려면 Padlet 보드 설정 > 고급 > URL 단축에서 `{슬러그}`를 직접 등록해주세요." (API로 자동 등록 불가 — 2026-07-12 확인)

---

## 4단계: Padlet 보드 검색

board_id를 모르면 전체 보드 목록에서 제목으로 찾습니다.

```powershell
$envPath = "G:\내 드라이브\Project_managing_tool\.env"
$apiKey = ""
Get-Content $envPath | ForEach-Object {
    if ($_ -match '^PADLET_API_KEY=(.+)$') { $apiKey = $Matches[1].Trim().Trim("'").Trim('"') }
}

[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
$request = [System.Net.HttpWebRequest]::Create("https://api.padlet.dev/v1/me?include=boards")
$request.Method = "GET"
$request.Headers.Add("x-api-key", $apiKey)
$request.UserAgent = "PowerShell-PadletLookup/1.0"
$response = $request.GetResponse()
$reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
$text = $reader.ReadToEnd()
$reader.Close(); $response.Close()

$obj = $text | ConvertFrom-Json
$boards = $obj.included | Where-Object { $_.type -eq "board" }
$matches = $boards | Where-Object { $_.attributes.title -match "키워드" } |
    Sort-Object { [datetime]$_.attributes.createdAt } -Descending

$outPath = "임시경로\board_matches.json"
($matches | ForEach-Object { [PSCustomObject]@{ id=$_.id; title=$_.attributes.title; createdAt=$_.attributes.createdAt } }) |
    ConvertTo-Json -Depth 5 | Out-File -FilePath $outPath -Encoding utf8
```

- **반드시 `HttpWebRequest` + `StreamReader(..., UTF8)`로 응답 문자열을 직접 읽습니다.** `Invoke-RestMethod`/`Invoke-WebRequest`의 결과를 그대로 `ConvertTo-Json`해서 파일로 쓰면 한글이 깨지거나(모지바케) 바이트 배열처럼 출력되는 경우가 있었습니다.
- 매칭이 여러 건이면 제목·생성일 목록을 사용자에게 보여주고 어떤 보드인지 확인받습니다. 1건이면 그대로 진행.
- **매칭이 0건이면** 키워드를 넓혀 한 번 더 시도하고, 그래도 없으면 사용자에게 보드 URL 또는 board_id를 직접 물어봅니다.
- `createdAt`이 없거나 파싱 불가능한 보드가 섞여 있으면 `Sort-Object`가 예외를 던질 수 있으니, 정렬 전에 `Where-Object { $_.attributes.createdAt }`로 값이 있는 항목만 남기세요.
- URL을 사용자가 준 경우, Padlet 공유 URL의 마지막 슬러그가 대개 `board_id`와 동일합니다 (예: `.../ai-2026-7-12-jdyc0o06rcz2znp6` → `jdyc0o06rcz2znp6`). 다만 확실하지 않으면 위 방법으로 교차 확인하세요.

---

## 5단계: 섹션 조회 및 매칭

```powershell
$boardId = "..."
$uri = "https://api.padlet.dev/v1/boards/$boardId`?include=sections"
# 위와 동일하게 HttpWebRequest + StreamReader(UTF8)로 조회
```

응답의 `included` 중 `type: "section"`인 항목의 `attributes.title`을 확인해 아래처럼 매칭합니다 (이모지 접두어는 무시하고 텍스트 키워드로 매칭):

- `title -match "교안"` → 교안 링크용 섹션
- `title -match "만족도"` → 사전 설문조사 + 만족도 설문조사용 섹션

매칭되는 섹션이 없으면 사용자에게 전체 섹션 목록을 보여주고 어디에 넣을지 확인받습니다. 반대로 같은 키워드에 섹션이 2개 이상 걸리면(예: "교안"이 포함된 섹션이 2개) 후보를 보여주고 어떤 섹션인지 확인받습니다 — 임의로 첫 번째를 고르지 않습니다.

사전 설문조사와 만족도 설문조사는 같은 "만족도" 섹션에 각각 별도 게시물로 들어갑니다 (섹션 하나에 게시물 여러 개, 정상). 2단계에서 둘 중 하나만 찾았다면 찾은 것만 업로드 대상에 포함합니다.

---

## 6단계: 미리보기 및 검수

```
board_id: {board_id} ({보드 제목})

업로드할 게시물 (N건)
1. 제목: {subject} / 섹션: {section 제목} / 첨부: {url}
2. ...

확인되셨으면 "검수완료"라고 입력해 주세요.
```

> **중요**: 사용자가 "검수완료"를 입력하기 전까지 업로드하지 않습니다.

---

## 7단계: Padlet API 업로드

**Post 생성 요청 바디는 `attributes.content` 하위에 subject/body/attachment를 중첩해야 합니다** (플랫 구조로 보내면 `400 Subject and body and attachment cannot all be blank` 에러 발생 — 2026-07-12 실제 확인됨). 섹션 지정은 `relationships.section.data.id`.

5단계에서 확정한 게시물 목록을, 각 항목이 `subject`(제목) / `url`(첨부, 선택) / `boardId` / `sectionId`를 갖는 배열로 구성합니다. 예:

```powershell
$posts = @(
    @{ subject = "📚 교안 링크"; url = "https://..."; boardId = $boardId; sectionId = $lectureSectionId },
    @{ subject = "🖥️ 교육 사전 설문조사"; url = "https://..."; boardId = $boardId; sectionId = $satisfactionSectionId },
    @{ subject = "⭐ 교육 만족도 설문조사"; url = "https://..."; boardId = $boardId; sectionId = $satisfactionSectionId }
)
```

```powershell
$headers = @{ "x-api-key" = $apiKey; "Content-Type" = "application/json; charset=utf-8" }

foreach ($post in $posts) {   # 각 post: subject, url(선택), sectionId
    $attributes = @{ content = @{} }
    if ($post.subject) { $attributes.content.subject = $post.subject }
    if ($post.body)    { $attributes.content.body    = $post.body }
    if ($post.url)     { $attributes.content.attachment = @{ url = $post.url } }

    $data = @{ data = @{ type = "post"; attributes = $attributes } }
    if ($post.sectionId) {
        $data.data.relationships = @{ section = @{ data = @{ id = $post.sectionId } } }
    }
    $body = $data | ConvertTo-Json -Depth 10
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)

    try {
        $resp = Invoke-WebRequest -Uri "https://api.padlet.dev/v1/boards/$($post.boardId)/posts" `
            -Method POST -Headers $headers -Body $bodyBytes `
            -UserAgent "PowerShell-PadletUpload/1.0" -UseBasicParsing -ErrorAction Stop
        Write-Host "성공: $($post.subject) - $($resp.StatusCode)"
    } catch {
        if ($_.Exception.Response) {
            $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            Write-Host "실패: $($post.subject) - $($sr.ReadToEnd())"
        } else {
            Write-Host "실패: $($post.subject) - $($_.Exception.Message)"
        }
    }
}
```

**`-UseBasicParsing`은 필수입니다.** 이 플래그 없이 `Invoke-WebRequest`를 쓰면 Windows PowerShell이 응답을 IE 엔진으로 파싱하려다 `Windows PowerShell is in NonInteractive mode. Read and Prompt functionality is not available.` 예외를 던집니다. **이때도 요청 자체는 서버에 이미 도달해 게시물이 생성된 상태**라서, 이 예외를 보고 재시도하면 같은 게시물이 중복 생성됩니다 (2026-07-12 실제로 3중 업로드 발생). 재시도 전에 반드시 보드에서 중복 여부를 확인하세요.

- 실패 사유가 401/403이면 API 키 또는 보드 관리자 권한 문제.
- 실패 사유가 404면 board_id 또는 section id가 잘못됨.
- 게시물 **수정·삭제는 API로 불가능**합니다 (`401 You must use a zapier integration`). 잘못 올라간 게시물은 사용자가 Padlet 웹에서 직접 삭제해야 합니다.

---

## 8단계: 결과 요약

```
✅ 패들렛 게시물 업로드 완료 — {보드 제목} ({board_id})

성공: N건
실패: N건
  - {제목} — {실패 사유}
```

---

## 주의사항

- 보드 생성/템플릿 복제/제목 수정은 이 스킬의 범위가 아닙니다 (Padlet API 미지원).
- 게시물 업로드는 board_id에 대한 **관리자(admin) 권한** 필요.
- `PADLET_API_KEY`는 Padlet 유료 플랜 사용자만 발급 가능.
- 인증 헤더는 `x-api-key`이며 `Authorization: Bearer`가 아님.
- API 응답을 파일로 저장할 땐 `HttpWebRequest` + `StreamReader(UTF8)`로 직접 읽을 것 (한글 인코딩 깨짐 방지).
- POST 바디는 `attributes.content.subject/body/attachment` 중첩 구조 사용.
- `Invoke-WebRequest`는 반드시 `-UseBasicParsing`과 함께 사용 (안 그러면 중복 업로드 위험).
- 게시물 수정/삭제는 API로 불가 (Zapier 연동 전용).
- 사용자가 "검수완료"를 입력하기 전까지 업로드하지 않습니다.
