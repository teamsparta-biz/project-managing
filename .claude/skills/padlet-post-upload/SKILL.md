---
name: padlet-post-upload
description: "Padlet 보드(패들렛)에 게시물(post)을 자동으로 업로드합니다. 보드 생성·제목 수정은 Padlet 웹에서 직접 하고, board_id만 알려주면 게시물들을 API로 한 번에 올려줍니다. /padlet-post-upload 명령으로 실행하며, 검수 후 업로드합니다."
argument-hint: "[board_id 또는 padlet URL]"
user-invocable: true
allowed-tools: Read, PowerShell
---

# 패들렛 게시물 업로드 스킬

Padlet 공식 API(`docs.padlet.dev`)는 **보드를 특정 템플릿 그대로 복제하거나 제목을 수정하는 기능을 지원하지 않습니다.** (2026-07-12 확인: board 생성은 자연어 지침으로 새로 만드는 AI recipe 엔드포인트만 있고, title을 지정/수정하는 PATCH 엔드포인트 자체가 없음)

그래서 이 스킬은 **게시물 업로드만 자동화**합니다. 보드 생성(템플릿 복제)과 제목 수정은 사용자가 Padlet 웹에서 직접 하고, 완성된 보드의 `board_id`만 알려주면 이 스킬이 게시물들을 API로 한 번에 올립니다.

> **트리거**: 사용자가 "패들렛에 게시물 올려줘", "패들렛 업로드" 등으로 요청하거나 `/padlet-post-upload` 명령을 입력할 때.

---

## 사전 준비 (사용자가 미리 완료해야 하는 것)

1. Padlet 웹에서 원하는 템플릿 보드를 복제하고 제목을 원하는 대로 수정 (API로는 불가능하므로 수동 진행)
2. 그 보드의 `board_id` 확인 — Padlet 대시보드 > Settings > Developer > API 섹션에서 확인하거나, 보드 URL/공유 링크로 알 수 없는 경우 사용자에게 직접 물어봅니다.
3. `.env`에 `PADLET_API_KEY`가 설정되어 있어야 합니다 (루트 `.env` 파일).

---

## 전체 흐름

```
[1단계] board_id 확인 (인자 또는 질문)
    ↓
[2단계] 업로드할 게시물 목록 수집 (제목/본문/첨부링크)
    ↓
[3단계] 업로드 내용 미리보기 → 사용자 검수
    ↓
[4단계] 사용자가 "검수완료" 입력 → PowerShell로 Padlet API POST (게시물별 순차 호출)
    ↓
[5단계] 결과 요약 출력 (성공/실패 건수, 실패 사유)
```

---

## 1단계: board_id 확인

명령 인자로 board_id 또는 padlet URL이 오면 그 값을 사용합니다. board_id를 바로 알 수 없는 형태(예: 공유용 padlet.com 짧은 URL)면, 사용자에게 API용 `board_id`를 직접 물어봅니다.

- 인자도 없고 사용자가 모른다면: "Padlet 대시보드 > Settings > Developer 메뉴에서 board_id를 확인해 주세요"라고 안내하고 대기합니다.

---

## 2단계: 게시물 목록 수집

사용자에게 업로드할 게시물들을 한 번에 받습니다. 각 게시물은 아래 항목으로 구성됩니다 (제목·본문·첨부 중 최소 하나 필수):

| 항목 | 필수 여부 | 설명 |
|------|-----------|------|
| 제목 (subject) | 선택 | 게시물 제목 |
| 본문 (body) | 선택 | 게시물 내용 |
| 첨부 링크 (attachment) | 선택 | URL 링크 첨부 |
| 색상 (color) | 선택 | red/orange/green/blue/purple 중 하나 |

사용자가 여러 게시물을 한 번에 붙여넣을 수 있도록, "제목 | 본문 | 링크(선택)" 형식으로 한 줄에 하나씩 입력받거나, 자유 형식으로 받은 뒤 항목별로 정리해 되묻습니다.

---

## 3단계: 미리보기 및 검수

수집한 게시물 목록을 아래 형식으로 출력합니다.

```
board_id: {board_id}

업로드할 게시물 (N건)
1. 제목: {subject} / 본문: {body} / 첨부: {attachment}
2. ...

수정할 내용이 있으면 말씀해 주세요. 확인되셨으면 "검수완료"라고 입력해 주시면 업로드합니다.
```

> **중요**: 사용자가 "검수완료"를 입력하기 전까지 절대 업로드하지 않습니다.

---

## 4단계: Padlet API 업로드

사용자가 "검수완료"를 입력하면, 게시물 목록을 JSON 파일로 먼저 저장한 뒤 PowerShell로 순차 업로드합니다. (한글 인코딩 깨짐 방지를 위해 인라인 문자열이 아닌 파일 경유)

### 4-1. Write 도구로 게시물 목록 저장

`G:\내 드라이브\Project_managing_tool\data\_padlet_upload_tmp.json` 경로에 아래 형태로 저장합니다.

```json
{
  "boardId": "{board_id}",
  "posts": [
    { "subject": "...", "body": "...", "attachment": "...", "color": "" }
  ]
}
```

값이 없는 항목은 빈 문자열 `""`로 둡니다.

### 4-2. PowerShell로 순차 POST

```powershell
$tmpPath = "G:\내 드라이브\Project_managing_tool\data\_padlet_upload_tmp.json"
$envPath = "G:\내 드라이브\Project_managing_tool\.env"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$payload = [System.IO.File]::ReadAllText($tmpPath, $utf8NoBom) | ConvertFrom-Json

$apiKey = ""
Get-Content $envPath | ForEach-Object {
    if ($_ -match '^PADLET_API_KEY=(.+)$') { $apiKey = $Matches[1].Trim().Trim("'").Trim('"') }
}
if (-not $apiKey) { Write-Host "PADLET_API_KEY가 .env에 없습니다."; exit }

$headers = @{ "x-api-key" = $apiKey; "Content-Type" = "application/json; charset=utf-8" }
$boardId = $payload.boardId
$successCount = 0
$failures = @()

foreach ($post in $payload.posts) {
    $attributes = @{}
    if ($post.subject)    { $attributes.subject    = $post.subject }
    if ($post.body)       { $attributes.body       = $post.body }
    if ($post.attachment) { $attributes.attachment = @{ url = $post.attachment } }
    if ($post.color)      { $attributes.color      = $post.color }

    $body = @{ data = @{ type = "post"; attributes = $attributes } } | ConvertTo-Json -Depth 10
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)

    try {
        $resp = Invoke-RestMethod -Uri "https://api.padlet.dev/v1/boards/$boardId/posts" -Method POST -Headers $headers -Body $bodyBytes -UserAgent "PowerShell-PadletUpload/1.0"
        $successCount++
        Write-Host "성공: $($post.subject)"
    } catch {
        $failures += "$($post.subject) — $($_.Exception.Message)"
        Write-Host "실패: $($post.subject) — $($_.Exception.Message)"
    }
}

Write-Host "완료: 성공 $successCount / 실패 $($failures.Count)"
```

- 실패 사유가 401/403이면 API 키 또는 보드 관리자 권한 문제일 가능성이 큽니다.
- 실패 사유가 404면 board_id가 잘못됐을 가능성이 큽니다.

### 4-3. 임시 파일 정리

업로드 완료 후 `_padlet_upload_tmp.json`은 삭제합니다 (Bash 또는 PowerShell로 `Remove-Item`).

---

## 5단계: 결과 요약 출력

```
✅ 패들렛 게시물 업로드 완료 — board_id: {board_id}

성공: N건
실패: N건
  - {제목} — {실패 사유}
  ...
```

---

## 주의사항

- **보드 생성/템플릿 복제/제목 수정은 이 스킬의 범위가 아닙니다.** Padlet API가 지원하지 않으므로 사용자가 Padlet 웹에서 직접 처리해야 합니다.
- 게시물 업로드는 **board_id에 대한 관리자(admin) 권한**이 있어야 성공합니다. 공유만 받은 보드는 실패할 수 있습니다.
- `PADLET_API_KEY`는 Padlet 유료 플랜 사용자만 발급 가능합니다.
- 인증 헤더는 `x-api-key`이며 `Authorization: Bearer`가 아닙니다 (Supabase 등 다른 스킬과 헤더 형식이 다름에 유의).
- 사용자가 "검수완료"를 입력하기 전까지 업로드하지 않습니다.
