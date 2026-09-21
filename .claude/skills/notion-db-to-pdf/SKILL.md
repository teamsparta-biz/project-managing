---
name: notion-db-to-pdf
description: "노션 인라인 데이터베이스(교안 카드 등)에 들어있는 하위 페이지들을 뷰에 설정된 순서 그대로 모아 하나의 PDF로 변환합니다. /notion-db-to-pdf 명령으로 실행하며, 노션 데이터베이스 URL을 인자로 받습니다. URL을 2개 이상 전달하면 여러 데이터베이스를 순서대로 이어붙여 하나의 PDF로 합칩니다 (예: Day 1 + Day 2 통합 교안)."
argument-hint: "[노션 데이터베이스 URL] [URL2 ...]"
user-invocable: true
allowed-tools: Read, Write, Bash, mcp__plugin_Notion_notion__notion-fetch, mcp__plugin_Notion_notion__notion-query-data-sources, mcp__claude_ai_Notion__notion-fetch, mcp__claude_ai_Notion__notion-query-data-sources
---

# 노션 데이터베이스 → PDF 변환 스킬

`/notion-db-to-pdf [노션 데이터베이스 URL]` 실행 시, 해당 데이터베이스에 들어있는 하위 페이지(카드)들을 **뷰에 표시된 순서 그대로** 모아 텍스트 기반의 PDF 1개로 만듭니다. 교안 카드 데이터베이스처럼 회차·순서 컬럼이 있는 강의 자료를 인쇄/공유용 PDF로 뽑을 때 사용합니다.

URL을 **2개 이상** 전달받으면(예: Day 1 데이터베이스 URL + Day 2 데이터베이스 URL), 각 데이터베이스를 전달받은 순서대로 처리해 **하나의 PDF**로 합칩니다. 여러 날짜/차수로 나뉜 교안을 통합 교안 1부로 뽑을 때 사용합니다.

> 트리거 명령어: `/notion-db-to-pdf`, 또는 "노션 데이터베이스를 pdf로 변환해줘", "이 두 데이터베이스를 합쳐서 하나의 pdf로 만들어줘" 같은 표현.

---

## 전체 흐름 요약

```
[0단계] 인자로 받은 URL 개수 확인 → 1개면 단일 처리, 2개 이상이면 병합 모드
    ↓
[1단계] URL(들)마다 데이터베이스/뷰 조회 (notion-fetch)
    ↓
[2단계] URL(들)마다 뷰 순서대로 하위 페이지 목록 조회 (notion-query-data-sources, view 모드)
    ↓
[3단계] 전체 페이지 목록(여러 DB 합산)에 대해 본문 조회 (notion-fetch) → 텍스트 정리(이미지/영상 URL 제거)
    ↓
[4단계] DB 순서 → 그 안에서 뷰 순서로 정리된 내용을 이어붙여 Markdown 1개로 합치기 (헤딩 레벨 규칙 준수)
    ↓
[5단계] Markdown → HTML → PDF 변환 (Node: marked + puppeteer-core로 Chrome 인쇄, 페이지 번호 포함)
    ↓
[6단계] 결과 저장 위치 안내 + 제외된 항목(이미지/영상/하위 DB) 안내 + 임시파일 삭제
```

---

## 0단계: 단일/병합 모드 판단

- 인자에서 노션 데이터베이스 URL을 모두 추출합니다. URL이 **1개**면 기존과 동일하게 단일 데이터베이스 처리(병합 로직 건너뜀).
- URL이 **2개 이상**이면 **병합 모드**로 진행합니다. 이때:
  - 각 URL을 **전달받은 순서 그대로** 최종 PDF의 앞뒤 순서로 사용합니다 (순서를 임의로 바꾸지 않음).
  - 사용자가 통합 교안의 표지 제목·파일명을 별도로 지정하지 않았다면, 1단계에서 조회한 각 데이터베이스 제목을 순서대로 이어 붙여 기본 제목을 만듭니다 (예: `Day 1(개발차수) + Day 2(비개발차수) 교안`). 애매하면 사용자에게 통합 제목을 확인합니다.
  - 계열사·고객사 접두어는 여러 DB의 상위 경로에서 확인한 접두어가 **서로 다르면** 사용자에게 어떤 접두어를 쓸지 확인합니다. 같으면 그 접두어를 그대로 사용합니다.

---

## 1단계: 대상 데이터베이스 조회 (URL마다 반복)

병합 모드에서는 아래 1~2단계를 **URL마다 각각** 수행하고, 그 결과(데이터베이스 제목, 하위 페이지 목록)를 URL 순서대로 리스트에 보관해 둡니다. 3단계부터는 전체를 합쳐서 처리합니다.

인자로 받은 노션 URL을 `mcp__plugin_Notion_notion__notion-fetch`로 조회합니다.

- 결과 `metadata.type`이 `database`가 아니면(예: 일반 페이지) 사용자에게 데이터베이스 URL을 다시 요청합니다.
- 응답의 `<data-source url="collection://...">` 값을 저장합니다 (2단계에서 사용).
- 응답의 `<view url="view://...">` 값도 저장합니다. 뷰가 여러 개면 사용자에게 어떤 뷰(정렬 기준)를 쓸지 물어봅니다. 뷰가 1개뿐이면 그대로 사용합니다.
- 데이터베이스 제목을 저장해둡니다 (단일 모드에서는 PDF 표지 제목으로, 병합 모드에서는 0단계의 통합 제목 조합에 사용).
- **계열사·고객사 접두어 확인**: `<ancestor-path>`를 따라 올라가며 `[코오롱베니트_비개발]`, `[삼성전자로지텍]`처럼 대괄호로 시작하는 상위 페이지 제목을 찾습니다. 찾으면 그 대괄호 접두어를 PDF 파일명 맨 앞에 그대로 붙입니다 (예: `[코오롱베니트_비개발] Day 2 교안.pdf`). 어떤 상위 페이지에서도 대괄호 접두어를 찾지 못하면 사용자에게 어느 계열사/고객사 교육인지 물어보고 답변으로 접두어를 만듭니다. 이 접두어 확인 없이 파일명을 확정하지 않습니다.

---

## 2단계: 뷰 순서대로 하위 페이지 목록 조회 (URL마다 반복)

`mcp__plugin_Notion_notion__notion-query-data-sources`를 **view 모드**로 호출합니다.

```json
{
  "data": {
    "mode": "view",
    "view_url": "{1단계에서 저장한 view url}"
  }
}
```

- view 모드는 그 뷰에 설정된 필터·정렬을 그대로 적용해 반환하므로, 데이터베이스마다 다른 정렬 컬럼명(`순서`, `날짜`, `Order` 등)을 몰라도 항상 화면에 보이는 순서를 그대로 재현할 수 있습니다.
- `has_more`가 true면 `start_cursor`로 이어서 전체 행을 받습니다.
- 각 행의 `url`(페이지 URL)과 제목 속성 값을 순서대로 리스트로 만듭니다.
- 행 중 값이 데이터베이스(하위 데이터베이스, 예: "Day 2")인 경우는 3단계에서 재귀적으로 펼치지 않고 **목록에만 표시**하고 별도 안내합니다(하위 DB까지 펼치려면 사용자에게 별도로 그 DB URL을 이번 실행의 인자에 추가해 다시 실행하도록 안내 — 병합 모드이므로 바로 이어붙일 수 있음을 알려줍니다).
- 병합 모드에서는 URL별로 조회한 목록에 어느 데이터베이스 소속인지(0-base 순번)를 함께 표시해 3~4단계에서 구분할 수 있게 합니다.

---

## 3단계: 각 페이지 본문 조회 및 텍스트 정리

전체 URL(병합 모드면 모든 데이터베이스 목록을 합친 것)의 각 페이지 URL에 대해 `mcp__plugin_Notion_notion__notion-fetch`를 호출합니다(여러 개면 한 번에 병렬 호출).

받은 각 페이지의 `<content>` 텍스트를 아래 규칙으로 Markdown으로 정리합니다:

- **헤딩 레벨 규칙 (중요 — 페이지 나눔 버그 방지)**:
  - 각 페이지 시작에 붙이는 `## {아이콘} {페이지 제목}`만 `##`(H2)로 남겨둡니다. 이 H2가 PDF에서 **페이지 구분자** 역할을 하며 강제 페이지 나눔이 걸립니다.
  - **번호를 중복해서 붙이지 않습니다.** 노션 교안 페이지는 제목 아이콘이 이미 `1️⃣`·`6️⃣` 같은 번호 이모지인 경우가 많아요. 여기에 `## 6. 6️⃣ 제목`처럼 순번을 덧붙이면 **번호가 두 번 나옵니다.** 아이콘이 번호를 담고 있으면 **아이콘만 남기고 숫자 접두어는 쓰지 않습니다** (`## 6️⃣ AI 해커톤 — 나만의 에이전트`).
  - 아이콘이 없거나 번호와 무관한 아이콘(📌·🎯 등)이면, 그때만 `## {전체 순번}. {제목}` 형태로 순번을 붙여 순서를 알 수 있게 합니다. 한 문서 안에서는 방식을 섞지 말고 하나로 통일하세요.
  - 원문에서 페이지 내부에 있던 `##` 헤딩(페이지 자체의 소제목, 예: 노션의 `## 바이브 코딩이란 무엇인가`)은 그대로 두지 말고 **`###`로 한 단계 낮춥니다.** 원문의 `###`는 `####`로, `####`는 `#####`로 — 이런 식으로 원래 있던 모든 헤딩을 한 단계씩 낮춰서, 진짜 페이지 구분자(각 페이지의 맨 앞 `##`)와 페이지 내부 소제목이 같은 레벨로 섞이지 않게 합니다. (섞이면 페이지 내부 소제목마다 강제 페이지 나눔이 걸려 페이지 여백이 텅 비는 문서가 됩니다.)
  - **낮추는 폭은 원문의 최상위 헤딩이 무엇인지 보고 정합니다.** 위 규칙은 원문 최상위가 `##`인 경우예요. 교안처럼 **원문 최상위가 `#`(H1)이면 한 단계만 낮추면 `##`가 되어 페이지 구분자와 충돌**하므로, 이때는 **두 단계씩** 낮춥니다(원문 `#`→`###`, `##`→`####`, `###`→`#####`). 기준은 하나예요 — **변환 후 문서에서 `##`로 시작하는 줄은 오직 페이지 구분자여야 합니다.**
  - 이렇게 하면 원문의 최상위 섹션(「이론 1」·「실습 1」·「강사 진행 노트」 같은 **대단원**)이 항상 `###`가 됩니다. 5단계 CSS가 `###`마다 새 페이지를 시작시키므로, 대단원이 페이지 중간에서 시작하는 일이 없어집니다.
  - 원문 안에 페이지 제목을 그대로 반복하는 `# 제목 {color=...}` 같은 H1이 있으면, 이미 `##` 페이지 구분자로 같은 제목을 표시했으므로 **중복 H1은 삭제**합니다(정보 손실 없음, 단순 중복 배너 제거).
  - `<details>` 안에 있던 소제목(요약이 헤딩이었던 경우)도 같은 원칙으로 한 단계 낮춰 반영합니다.
- `**bold**`, `` `code` ``는 그대로 유지. 코드블록은 아래 코드펜스 규칙을 따릅니다.
- **코드펜스 규칙 (중요 — 코드블록 파싱 깨짐 방지)**: 코드블록을 열 때 ` ``` ` 뒤에 언어를 표시하더라도 **공백이 들어간 언어명을 쓰지 않습니다** (예: ` ```plain text `는 markdown 파서가 인식하지 못해 그 뒤 문서 전체가 깨지는 심각한 버그를 유발합니다). 언어를 표시하지 않으려면 그냥 ` ``` ` 단독으로 쓰고, 표시하려면 `plaintext`, `bash`, `markdown`, `python`처럼 공백 없는 한 단어만 사용합니다.
- `<callout>...</callout>` → Markdown 인용구(`> `)로 변환.
- **표 규칙**: `<table header-row="true">...</table>`는 **Markdown 파이프 표(`| 열 | 열 |`)로 바꾸는 것을 기본으로 합니다.** 그러면 셀 안의 `**굵게**`·`` `code` ``가 그대로 렌더링돼 별도 처리가 필요 없습니다. 셀 안에 줄바꿈이 필요하면 `<br>`, 파이프 문자가 들어가면 `\|`로 이스케이프합니다.
  - 셀 구조가 복잡해 파이프 표로 옮기기 어려우면 raw HTML `<table>`을 유지해도 되지만, 그때는 그 안의 마크다운 문법을 **미리 `<strong>굵게</strong>`, `<code>code</code>`로 직접 변환해서 넣습니다** — markdown 변환기는 raw HTML 블록 내부를 처리하지 않아, `**`나 `` ` `` 기호가 PDF에 그대로 노출됩니다.
- `<details><summary>...</summary>...</details>` → 위 헤딩 레벨 규칙에 맞는 소제목(`{summary 내용}`) + 본문으로 펼쳐서 유지 (접힌 상태로는 PDF에서 보이지 않으므로 항상 펼침).
- `![...](서명된 URL)`, `<video src="...">`, `<pdf src="...">`, `<unknown ... alt="bookmark"/>` 같은 이미지·영상·첨부·북마크 임베드는 **본문에서 제거**합니다. 서명된 S3 URL은 5분 안에 만료되고, 그대로 두면 PDF가 깨지거나 매우 무거워지기 때문입니다. 제거한 자리에 이미지/영상을 넣지 않고 그냥 생략합니다(자리표시자 문구도 넣지 않음 — 빈 줄로 이어지는 정도면 충분).
- `<empty-block/>`는 제거합니다.

---

## 4단계: Markdown 합치기

- **단일 모드**: 1단계 데이터베이스 제목을 `# {데이터베이스 제목}`으로 문서 맨 위에 놓고, 3단계에서 정리한 각 페이지를 뷰 순서대로 이어붙여 하나의 `.md` 파일로 씁니다.
- **병합 모드**: 문서 맨 위에 `# {0단계에서 정한 통합 제목}`을 놓습니다. 그 아래에 URL 전달 순서대로 각 데이터베이스의 페이지들을 이어붙입니다. 데이터베이스가 바뀌는 경계에서도 별도의 구분 배너 H1을 추가하지 않습니다 — 각 페이지 자체의 `##` 구분자가 이미 페이지 나눔 역할을 하니까요.
  - 3단계에 따라 **아이콘이 번호를 담고 있으면 아이콘을 그대로 씁니다.** 이때 DB마다 아이콘 번호가 1부터 다시 시작하는 것은 자연스러운 일이라(Day 1의 1️⃣~6️⃣, Day 2의 1️⃣~5️⃣) 그대로 둡니다 — 어느 날짜의 몇 교시인지는 표지 제목과 흐름으로 드러나요.
  - 아이콘이 없어 순번을 붙이는 경우에만, 여러 데이터베이스를 통틀어 1부터 계속 이어지는 일련번호로 매깁니다(예: Day 1이 15개 페이지면 Day 2는 16번부터 시작).
- 임시 작업 파일은 스크래치패드 디렉터리에 만듭니다 (`Write` 도구, 경로는 세션의 스크래치패드 하위 폴더). 내용이 길면 여러 개의 부분 파일로 나눠 작성한 뒤 `cat`으로 합쳐도 됩니다.
- **작성 직후 자체 검증**: 완성된 `.md`에서 아래를 반드시 확인합니다.
  - `grep -n "^## "`로 나온 줄 수가 실제 페이지(카드) 개수와 정확히 일치하는지 (페이지 내부 소제목이 실수로 `##`로 남아있지 않은지).
  - 그 `##` 줄에 **번호가 두 번 나오지 않는지** — `## 6. 6️⃣ …`처럼 숫자 접두어와 번호 이모지가 겹치면 숫자 접두어를 지웁니다.
  - ` ```plain text `처럼 공백이 든 코드펜스 언어가 없는지 (`grep '```.* '` 로 확인).
  - `<table` 블록 안에 `**`나 `` ` `` 마크다운 문법이 남아있지 않은지.
  - **표·코드블록·인용구 바로 앞에 오는 안내 문구**(예: `**실습 1 체크리스트**`, `**작성 예시**`, `**입력할 프롬프트**`)가 그 블록과 **빈 줄 하나로만 떨어진 인접 형제**인지. 사이에 다른 문단이 끼면 5단계의 `p:has(+ table)` 규칙이 걸리지 않아 라벨만 앞 페이지에 홀로 남습니다.
  - 문제가 있으면 5단계로 넘어가기 전에 고칩니다.

---

## 5단계: Markdown → HTML → PDF

렌더링은 **Node로 합니다** (`marked`로 Markdown→HTML, `puppeteer-core`로 설치된 Chrome을 띄워 PDF 인쇄). Python을 쓰지 않는 이유는 Windows 환경에서 `python`이 Microsoft Store 스텁인 경우가 많아 `python -c "import markdown"`이 설치 안내만 띄우고 실패하기 때문입니다. Node는 `node -v`로 먼저 확인하고, 없으면 사용자에게 알립니다.

`puppeteer-core`를 쓰는 이유는 하단 **페이지 번호** 때문입니다. Chrome CLI(`--print-to-pdf`)로는 머리말·꼬리말 템플릿을 지정할 수 없어 페이지 번호를 넣을 수 없어요.

### 5-1. 패키지 확인/설치

스크래치패드 디렉터리에서 설치합니다 (프로젝트 폴더를 오염시키지 않습니다).

```bash
node -v || echo "Node가 없습니다 — 사용자에게 알리고 중단"
npm i marked puppeteer-core --no-audit --no-fund
```

### 5-2. 렌더 스크립트 (Markdown → HTML → PDF 한 번에)

스크래치패드에 `render.mjs`를 만들어 실행합니다. **아래 CSS의 페이지 나눔 규칙이 이 스킬 결과물 품질의 핵심**이라 골자를 그대로 유지하세요.

```javascript
import { marked } from 'marked';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [mdFile, outPdf, title] = process.argv.slice(2);

// 물결표(~)는 교안에서 "5~10개", "11:00~12:30"처럼 범위 표기로만 쓰인다.
// 그런데 marked의 GFM은 ~한쪽만~ 감싸도 <del>(취소선)로 만들어 버려서,
// 그대로 두면 문서 곳곳에 의도치 않은 취소선이 생긴다.
// tokenizer 오버라이드는 falsy를 반환하면 기본 동작으로 되돌아가 막을 수 없으므로,
// 파싱 전에 이스케이프한다. (코드블록 안에 ~가 있으면 &#126;이 그대로 노출되니 미리 확인할 것)
const escapeTildes = (md) => md.replace(/~/g, '&#126;');

let body = marked.parse(escapeTildes(fs.readFileSync(mdFile, 'utf8')), { gfm: true });

// 각 페이지(h2)의 첫 대단원(h3)은 페이지 제목과 같은 지면에 둔다.
// 이 처리가 없으면 "제목만 있고 본문이 없는 페이지"가 페이지 수만큼 생긴다.
body = body.split(/(?=<h2)/).map(chunk =>
  chunk.replace(/<h3/, '<h3 class="chapter-open"')
).join('');

const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: A4; margin: 18mm 15mm 20mm 15mm; }
  body { font-family:"Malgun Gothic","맑은 고딕","Noto Sans KR",Arial,sans-serif;
         font-size:11px; line-height:1.6; color:#222; word-break:keep-all;
         orphans:3; widows:3; }

  h1 { font-size:21px; border-bottom:3px solid #333; padding-bottom:9px; margin-top:0; }

  /* 페이지 구분자 — 항상 새 지면에서 시작 */
  h2 { font-size:17px; background:#e4e9f2; padding:9px 12px; border-left:6px solid #33507a;
       margin-top:0; page-break-before:always; break-before:page; page-break-after:avoid; }
  body > h2:first-of-type { page-break-before:auto; break-before:auto; margin-top:18px; }

  /* 대단원(이론 1·실습 1·강사 진행 노트 등) — 새 지면에서 시작 */
  h3 { font-size:14.5px; background:#eef0f3; padding:7px 11px; border-left:5px solid #555;
       margin-top:0; page-break-before:always; break-before:page; page-break-after:avoid; }
  /* 단, 페이지 제목 바로 다음 첫 대단원은 제목과 같은 지면에 */
  h3.chapter-open { page-break-before:avoid; break-before:avoid; margin-top:20px; }

  h4 { font-size:12.5px; color:#222; border-bottom:1px solid #ccc; padding-bottom:3px;
       margin-top:18px; page-break-after:avoid; break-after:avoid; }
  h5 { font-size:12px; color:#333; margin-top:14px; page-break-after:avoid; break-after:avoid; }
  h6 { font-size:11.5px; color:#444; font-style:italic; margin-top:10px; page-break-after:avoid; }

  p { margin:6px 0; }

  /* 표·코드블록·인용구·목록 바로 위의 안내 문구는 그 블록과 붙여둔다.
     ("실습 1 체크리스트", "작성 예시", "입력할 프롬프트" 같은 라벨이
      앞 페이지 맨 아래에 홀로 남는 것을 막는다) */
  p:has(+ table), p:has(+ pre), p:has(+ blockquote), p:has(+ ul), p:has(+ ol) {
    page-break-after:avoid; break-after:avoid;
  }

  blockquote { background:#f7f7f2; border-left:4px solid #999; margin:10px 0; padding:9px 12px;
               color:#444; page-break-inside:avoid; break-inside:avoid; }
  pre { background:#2d2d2d; color:#e8e8e8; padding:10px 12px; border-radius:4px;
        font-size:10px; white-space:pre-wrap; word-break:break-word;
        page-break-inside:avoid; break-inside:avoid; }
  code { background:#eee; padding:1px 4px; border-radius:3px; font-size:10px; }
  pre code { background:none; padding:0; color:inherit; }

  table { border-collapse:collapse; width:100%; margin:10px 0; font-size:10.5px;
          page-break-inside:avoid; break-inside:avoid; }
  th, td { border:1px solid #bbb; padding:5px 7px; text-align:left; vertical-align:top; }
  th { background:#e9e9e9; font-weight:600; }
  tr { page-break-inside:avoid; break-inside:avoid; }

  hr { border:none; border-top:1px solid #ccc; margin:20px 0; }
  ul, ol { margin:6px 0 6px 20px; padding-left:6px; }
  li { margin:3px 0; page-break-inside:avoid; }
  strong { font-weight:600; }
</style></head><body>
${body}
</body></html>`;

const htmlPath = path.resolve('render.html');
fs.writeFileSync(htmlPath, html, 'utf8');

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
await page.pdf({
  path: outPdf, format: 'A4', printBackground: true,
  margin: { top:'18mm', bottom:'20mm', left:'15mm', right:'15mm' },
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  // 하단 꼬리말: 왼쪽 문서명, 오른쪽 "현재 / 전체" 페이지 번호
  footerTemplate: `<div style="width:100%;font-size:9px;color:#666;padding:0 15mm;
    font-family:'Malgun Gothic',sans-serif;display:flex;justify-content:space-between;">
    <span>${title}</span>
    <span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
});
await browser.close();
console.log('PDF 생성 완료');
```

실행은 이렇게 합니다. **경로는 Windows 형식(`C:/...`)으로 넘깁니다** — Git Bash의 `/c/...` 형식을 그대로 넘기면 Node가 `C:\c\...`로 해석해 파일을 찾지 못합니다.

```bash
node render.mjs combined.md "C:/Users/.../산출물/[접두어] 제목.pdf" "[접두어] 제목"
```

Chrome이 없으면 `CHROME` 상수를 Edge 경로(`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`)로 바꿔 실행합니다. 둘 다 없으면 사용자에게 브라우저 설치 여부를 확인 요청합니다.

### 5-3. 결과 검증

- 페이지 수는 `pdf-lib`로 확인합니다 (`npm i pdf-lib` 후 `PDFDocument.load(...).getPageCount()`). `grep -c`는 PDF 바이너리 구조상 신뢰할 수 없습니다.
- **각 페이지의 첫 줄을 뽑아 대단원이 제대로 새 지면에서 시작하는지 확인합니다.** 경로에 대괄호(`[에스원]` 등)가 있으면 셸이 glob으로 해석하므로 `set -f`로 globbing을 끄고 실행하세요.

```bash
set -f
for i in $(seq 1 $N); do
  echo "p$i | $(pdftotext -enc UTF-8 -f $i -l $i "$PDF" - | grep -v '^\s*$' | head -1 | cut -c1-44)"
done
```

- 확인할 것: 페이지 구분자(각 교시 제목)가 새 지면에서 시작하는지 · 「이론 N」·「실습 N」·「강사 진행 노트」 같은 대단원이 새 지면에서 시작하는지 · 표나 코드블록이 페이지에 걸쳐 잘리지 않았는지 · 표 안에 `**`/`` ` `` 기호가 그대로 노출되지 않았는지 · 하단 페이지 번호가 찍혔는지.
- 이모지(🎒 등)는 맑은 고딕에 글리프가 없어 PDF에서 깨져 보일 수 있습니다. 눈에 띄면 사용자에게 알리고, 원하면 제거하거나 다른 기호로 바꿔 다시 렌더링합니다.

---

## 6단계: 저장 위치 및 마무리 안내

- 별도 저장 위치를 지정받지 못했다면 기본값으로 `산출물/문서/[{계열사·고객사 접두어}] {제목}.pdf`에 저장합니다. 파일명은 항상 어느 계열사·고객사 교육인지 대괄호로 표시해서 시작해야 합니다(1단계에서 확인한 접두어 사용). 사용자가 파일명을 직접 지정하면 그 이름을 그대로 따르되, 접두어가 빠져 있으면 한 번 확인합니다.
- 완료 후 사용자에게 다음을 안내합니다:
  - 저장된 PDF 경로, 총 페이지 수
  - 병합 모드였다면 몇 개의 데이터베이스를 어떤 순서로 합쳤는지
  - 이미지·영상 등 PDF에서 생략된 항목이 있었다면 그 사실 (임베드가 원본 노션 페이지에 있었다는 정도로만 언급, 개별 나열은 불필요)
  - 하위 데이터베이스(예: "Day 2")를 목록에서 발견했다면, 그 URL을 이번 실행 인자에 추가해 다시 실행하면 하나의 PDF로 합쳐진다는 안내
- 작업용 임시 파일(`combined.md`, `render.html`, `render.mjs`, `node_modules`, 부분 markdown 파일)은 스크래치패드에만 남기고 프로젝트 폴더에는 남기지 않습니다. 최종 PDF만 지정된 산출물 폴더에 남깁니다.

---

## 오류 대응

| 상황 | 대응 |
|------|------|
| URL이 데이터베이스가 아님 | 데이터베이스 URL을 다시 요청 |
| 뷰가 여러 개 | 어떤 뷰(정렬 기준) 기준으로 뽑을지 사용자에게 질문 |
| 특정 하위 페이지 fetch 실패 | 해당 페이지는 "본문을 가져오지 못했습니다"라는 한 줄만 넣고 나머지는 계속 진행, 완료 후 실패 목록 안내 |
| Chrome·Edge 모두 없음 | 사용자에게 브라우저 설치 여부를 확인 요청 (PDF 변환 불가) |
| Node가 없음 | 사용자에게 Node 설치 여부를 확인 요청 (렌더링 불가). `python`은 Windows에서 Store 스텁인 경우가 많아 대안이 되지 못합니다 |
| 대단원 하나가 한 페이지를 넘김 | 정상입니다. `###`는 시작 지점만 새 페이지로 고정할 뿐, 길면 다음 페이지로 자연스럽게 이어집니다 |
| 본문 곳곳에 의도치 않은 취소선이 생김 | `5~10개`·`11:00~12:30` 같은 물결표 범위 표기를 marked가 `<del>`로 해석한 것이에요. 5단계 렌더 스크립트의 `escapeTildes`가 이미 막아 줍니다. 검증할 때는 `render.html`에서 `grep -c '<del>'`이 0인지 확인하세요 (원문에 진짜 취소선 `~~…~~`가 있었다면 그것도 함께 사라지니 미리 확인) |
| 이모지가 PDF에서 깨짐(`      `) | 맑은 고딕에 글리프가 없는 경우예요. 사용자에게 알리고, 원하면 해당 이모지를 제거하거나 대체 기호로 바꿔 다시 렌더링 |
| 출력 경로에 대괄호가 있어 셸이 glob으로 해석 | 검증 스크립트 앞에 `set -f`를 넣어 globbing을 끕니다 |
| 행 개수가 매우 많음(50개 이상, 병합 모드는 합산 기준) | 진행 전 사용자에게 예상 페이지 수를 알리고 계속할지 확인 |
| 병합 모드에서 두 DB의 계열사·고객사 접두어가 다름 | 어느 접두어를 쓸지, 혹은 접두어 없이 진행할지 사용자에게 확인 |

---

## 참고

- 이 스킬은 **텍스트·표·코드블록·인용구** 위주로 PDF를 만듭니다. 이미지/영상을 반드시 포함해야 하는 경우(디자인 검토용 등)에는 이 스킬 대신 노션에서 직접 "PDF로 내보내기"를 사용하도록 안내합니다.
- 원본 노션 페이지의 서명된 첨부파일 URL(`X-Amz-...`)은 매번 새로 발급되며 몇 분 안에 만료되므로, 이미지를 포함하려는 시도는 하지 않습니다.
- 헤딩 레벨을 페이지 구분자(H2)와 페이지 내부 소제목(H3 이하)으로 엄격히 분리하는 것과, 코드펜스에 공백 섞인 언어명을 쓰지 않는 것은 실제로 문서 전체가 깨지는 사고로 이어졌던 부분이라 특히 주의합니다.
- **읽기 좋은 PDF를 만드는 규칙 네 가지**는 5단계 CSS에 이미 들어 있습니다. 스타일을 손보더라도 이 넷은 유지하세요.
  1. 페이지 구분자(H2)와 대단원(H3)은 **새 지면에서 시작** — 단, 각 페이지의 첫 대단원은 제목과 같은 지면에(`h3.chapter-open`).
  2. 표·코드블록·인용구는 **페이지에 걸쳐 자르지 않음**(`break-inside: avoid`).
  3. 표·코드블록 **바로 위의 안내 문구는 그 블록과 붙임**(`p:has(+ table)` 등에 `break-after: avoid`).
  4. 모든 지면 하단에 **문서명과 페이지 번호**(`pageNumber / totalPages`).
