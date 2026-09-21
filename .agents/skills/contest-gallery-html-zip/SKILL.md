---
name: contest-gallery-html-zip
description: "contest-platform-production.up.railway.app 전시관(갤러리) 페이지 URL을 받아, 해당 전시관에 제출된 HTML 결과물을 모두 내려받아 \"이름(부서명).html\" 형식으로 파일명을 통일한 뒤 zip 하나로 묶습니다. \"전시관 html 모아서 zip\", \"제출물 다운로드해서 압축\" 같은 요청에 사용."
argument-hint: "[전시관 gallery URL]"
user-invocable: true
allowed-tools: Bash, Read
---

# 콘테스트 전시관 HTML 결과물 zip 스킬

`/contest-gallery-html-zip [전시관 gallery URL]` 실행 시, contest-platform 전시관(gallery) 페이지에 올라온 제출물 중 HTML 결과물을 모두 내려받아 `이름(부서명).html` 형식으로 파일명을 통일하고 zip 파일 하나로 묶습니다.

> 트리거: `/contest-gallery-html-zip`, 또는 "이 전시관 html 결과물 모아서 zip으로 묶어줘", "제출물 다운로드해서 압축해줘" 같은 표현. URL은 `https://contest-platform-production.up.railway.app/{tenantSlug}/{contestSlug}/gallery` 형태.

---

## 0단계: URL에서 tenantSlug / contestSlug 추출

전달받은 gallery URL 경로에서 `/{tenantSlug}/{contestSlug}/gallery` 부분을 파싱합니다. URL이 없거나 이 형태가 아니면 사용자에게 전시관 URL을 다시 요청합니다.

## 1단계: 제출물 목록 조회

내부 API를 직접 호출합니다 (페이지는 클라이언트에서 렌더링되므로 HTML을 긁지 말고 API를 사용):

```
GET https://contest-platform-production.up.railway.app/api/gallery?slug={tenantSlug}&contestSlug={contestSlug}
```

응답 JSON의 `submissions` 배열을 사용합니다. 각 항목은 다음을 포함합니다:
- `file_url`: 제출 파일의 실제 다운로드 URL (Supabase storage). `.html`로 끝나지 않으면(다른 파일 형식이거나 `external_link`만 있는 경우) 이번 스킬 범위(HTML 결과물)에서 제외합니다.
- `user.display_name`: 대개 `이름(부서명)` 형태지만, `이름/부서`, `이름 부서`(공백 구분), `이름 (부서명)`(공백+괄호) 등 표기가 제각각일 수 있습니다.

`is_hidden`, `status`가 비정상인 항목(예: 숨김 처리)도 특별히 걸러야 한다는 요청이 없는 한 API가 반환하는 전체 submissions를 그대로 사용합니다.

## 2단계: 파일명 정규화 — `이름(부서명)`

각 제출물의 `user.display_name`을 다음 규칙으로 `이름(부서명)` 형태로 통일합니다:

1. 이미 `이름(부서명)` 형태(끝이 괄호로 닫힘)면 이름/부서명 사이 공백만 정리.
2. `이름/부서명`처럼 슬래시 구분이면 슬래시를 기준으로 분리해 `이름(부서명)`으로 변환.
3. `이름 부서명`처럼 공백 구분(괄호 없음)이면 첫 공백을 기준으로 분리해 `이름(부서명)`으로 변환.
4. 위 규칙으로도 분리가 안 되면 (부서 정보 없음) display_name을 그대로 파일명으로 사용.
5. 부서명 안에 `/`가 포함된 경우(예: `차세대ERP추진T/F`) 파일 경로에 쓸 수 없으므로 `_`로 치환.
6. 동일한 `이름(부서명)`이 중복되면 `_2`, `_3`처럼 뒤에 번호를 붙여 구분.

## 3단계: 다운로드 및 zip

세션 스크래치패드 디렉토리 아래에 임시 폴더를 만들고, 각 제출물의 `file_url`을 `{정규화된 이름(부서명)}.html`로 저장한 뒤, 전체를 zip 하나로 묶습니다. Python(`urllib.request` + `zipfile`) 또는 동등한 Bash/Node 방식 아무거나 사용 가능합니다.

## 4단계: 결과 저장 및 안내

완성된 zip을 `~/Downloads/{tenantSlug}_{contestSlug}_전시관_HTML.zip` 으로 복사합니다 (Google Drive로 동기화되는 프로젝트 작업 디렉토리에는 남기지 않습니다).

사용자에게 다음을 보고합니다:
- 저장 위치
- 내려받은 파일 개수 (조회된 전체 submissions 수 대비 HTML 결과물만 포함했다면 그 사실도 함께)
- `display_name` 표기가 제각각이라 `이름(부서명)`으로 통일했다는 점 (있었던 경우)
