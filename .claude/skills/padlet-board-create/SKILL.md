---
name: padlet-board-create
description: "팀스파르타 AI 교육 패들렛 템플릿을 복제해 교육용 보드를 만들고, 보드 이름을 설정한 뒤 '만족도 조사' 섹션에 사전 설문·만족도 설문 링크를 올리고, 강사·튜터 이메일을 관리자로 초대합니다. /padlet-board-create 명령으로 실행합니다. '패들렛 보드 만들어줘', '패들렛 템플릿으로 생성' 요청에 사용."
argument-hint: "[보드이름] [사전설문링크] [만족도설문링크] [초대할 이메일들]"
user-invocable: true
allowed-tools: mcp__padlet__remake_padlet, mcp__padlet__get_padlet_content, mcp__padlet__create_posts, mcp__padlet__update_padlet_title_description, mcp__padlet__get_current_user_info, mcp__padlet__invite_email_as_padlet_collaborator, mcp__padlet__get_padlet_access_settings, mcp__padlet__update_delete_padlet_collaborator_user, mcp__ax-hub__query_sql
---

# 패들렛 보드 생성 스킬

팀스파르타 AI 교육 패들렛 템플릿을 복제해 교육별 보드를 만들고, `🎀만족도 조사` 섹션에 설문 링크 2개를 게시물로 올린 뒤, 강사·튜터를 관리자로 초대합니다.

## 템플릿

- 템플릿 URL: `https://padlet.com/biz14/ai-yy-mm-dd-2026-10-16-s024jxiun4nawdpylycb`
- 섹션 구성: `📚교안 링크` / `😎질문이 있다면!` / `🎀만족도 조사`
- `😎질문이 있다면!` 섹션에는 안내 게시물("이렇게 남겨보세요!")이 이미 들어 있습니다.
- 계정은 팀 공용 계정 `biz14`(biz@teamsparta.co)입니다.

---

## 전체 흐름

```
[1단계] 입력 확인 (보드 이름, 사전 설문 링크, 만족도 설문 링크, 초대할 이메일)
    ↓
[2단계] 템플릿 복제 (remake_padlet, 1회만)
    ↓
[3단계] 새 보드의 섹션 ID 조회
    ↓
[4단계] 만족도 조사 섹션에 게시물 2개 생성
    ↓
[5단계] 단축 URL 설정 (padlet.com/biz14/{슬러그})
    ↓
[6단계] 이메일 초대 후 관리자로 변경
    ↓
[7단계] 결과 안내 (보드 링크 + 단축 URL + 올린 내용 + 초대 결과)
```

---

## 1단계: 입력 확인

필요한 값:

| 항목 | 설명 | 예시 |
|------|------|------|
| 보드 이름 | 보드 제목. `{기업명} {교육명}` 형식을 기본으로 사용 | 디케이메디칼솔루션 부문별 기초교육 |
| 사전 설문 링크 | 교육 사전 설문조사 URL | https://teamsparta-survey.vercel.app/l/WQ3DXYF |
| 만족도 설문 링크 | 교육 만족도 설문조사 URL | https://teamsparta-survey.vercel.app/l/3YCSDBH |
| 초대할 이메일 | 보드 관리자로 초대할 강사·튜터 이메일 (선택) | tutor@gmail.com, ... |

- 설문 링크를 받지 못했으면 ax-hub `course_rounds`의 `pre_survey_link`(사전), `survey_link`(만족도)를 조회해 후보로 제시하고 사용자에게 확인받습니다. 둘 다 없으면 사용자에게 질문합니다.
- 입력되지 않은 링크는 임의로 만들지 않습니다. 링크가 하나뿐이면 그 게시물만 올립니다.
- 초대할 이메일은 사용자가 준 목록을 그대로 씁니다. 받지 못했으면 보드 생성 후 초대할 이메일이 있는지 묻습니다(`padlet-share` 스킬로 ax-hub에서 강사·튜터 이메일을 조회할 수도 있습니다). 이메일을 추측해 만들지 않습니다.

## 2단계: 템플릿 복제

`remake_padlet`을 **한 번만** 호출합니다. (재호출하면 보드가 중복 생성됩니다.)

- `wall_url`: 위 템플릿 URL
- `title`: 1단계의 보드 이름
- 그 외 옵션은 기본값 사용 (게시물·배경 복사, 댓글·반응 미복사)
- 라이브러리를 지정하지 않으면 개인 공간(`personal`)에 생성됩니다. 결과에 `available_workspaces`가 오면 사용자에게 어디에 만들지 묻고 한 번만 다시 호출합니다.

결과의 `wall_url`이 새 보드 주소입니다.

## 3단계: 섹션 ID 조회

새 보드의 `wall_url`로 `get_padlet_content`를 호출해 `🎀만족도 조사` 섹션의 `section_id`를 찾습니다. 복제할 때마다 섹션 ID가 새로 발급되므로 **템플릿의 ID를 재사용하지 않습니다.** 섹션 제목으로 찾습니다.

## 4단계: 게시물 생성

`create_posts`로 `🎀만족도 조사` 섹션에 아래 게시물을 만듭니다. 각 게시물은 제목과 링크 첨부로 구성하고, `post_id`는 `new_1`, `new_2` 형식으로 줍니다.

- 제목 `🖥️ 교육 사전 설문조사` / `attachment`: 사전 설문 링크
- 제목 `⭐ 교육 만족도 설문조사` / `attachment`: 만족도 설문 링크

## 5단계: 단축 URL 설정

보드 주소를 `https://padlet.com/biz14/{슬러그}` 형태로 줄입니다. 패들렛 MCP·API로는 설정할 수 없어서 `scripts/padlet-browser/padlet-browser.js`(Playwright)의 `shorten` 명령을 씁니다.

1. **슬러그 정하기**: 기업명을 영문 소문자로 줄입니다(예: 디케이메디칼솔루션 → `dksolution`, 삼성증권 → `samsungpop`). 영문 표기가 애매하면 사용자에게 후보를 제시하고 확인받습니다. 숫자·하이픈·영문 소문자만 씁니다.
2. **실행**:
   ```
   node scripts/padlet-browser/padlet-browser.js shorten --board "<2단계의 wall_url>" --slug <슬러그>
   ```
3. **사전 준비**(이 컴퓨터에서 처음이라면):
   - Playwright가 `~/.padlet-automation`에 설치돼 있어야 합니다. 없으면 그 폴더에 `package.json`(`{"name":"padlet-automation","version":"1.0.0","private":true}`)을 직접 만든 뒤 `npm install playwright`, `npx playwright install chromium`을 실행합니다. 폴더 이름이 점으로 시작해서 `npm init -y`는 "Invalid name" 오류로 실패합니다.
   - 로그인 세션(`data/padlet-session.json`)이 없으면 사용자에게 `! node scripts/padlet-browser/padlet-browser.js login`을 직접 실행해 Padlet에 로그인하게 합니다. 이 파일은 쿠키가 담긴 민감 파일이라 커밋하지 않습니다.
4. **실패 시**: 이미 사용 중인 슬러그이거나 Padlet 화면이 바뀌어 셀렉터가 맞지 않을 수 있습니다. 오류 내용을 알리고, 다른 슬러그로 다시 시도할지 사용자가 Padlet 웹의 보드 설정 > 고급 > URL 단축에서 직접 등록할지 묻습니다. 등록되지 않았으면 등록된 것처럼 안내하지 않습니다.
5. 등록 후 단축 URL이 실제로 열리는지 `get_padlet_content`로 확인합니다.

## 6단계: 이메일 초대 후 관리자로 변경

초대할 이메일이 있을 때만 진행합니다. 초대 도구가 바로 관리자로 초대되지 않을 수 있어 **초대 → 관리자로 변경** 두 단계로 처리합니다.

1. **초대**: 이메일마다 `invite_email_as_padlet_collaborator`를 호출합니다. (`wall_url`: 새 보드 주소, `role`: `admin`) 여러 명이면 병렬로 호출합니다.
2. **권한 확인**: `get_padlet_access_settings`로 협업자 목록을 조회합니다. 이메일은 `q***@g***.com`처럼 가려져 나오므로 `username`·앞글자·도메인으로 초대한 사람과 맞춰 `id`를 찾습니다. 미가입 계정은 `username`이 `null`이라 남은 한 명으로 맞춥니다. 확실히 맞출 수 없으면 사용자에게 묻습니다.
3. **관리자로 변경**: `role`이 `admin`이 아닌 사람만 `update_delete_padlet_collaborator_user`(`user_id`: 2번의 `id`, `role`: `admin`, `is_deleting`: `false`)로 바꿉니다. 절대 `is_deleting: true`로 호출하지 않습니다.
4. **실패 처리**: 일부가 실패하거나 권한 검사에서 거부되면 우회하지 말고, 성공·실패한 이메일을 나눠 알린 뒤 다시 시도할지 사용자에게 묻습니다.

- 사용자가 "제작자"라고 해도 이 스킬에서는 관리자(`admin`)로 초대합니다.
- 초대된 사람은 `status: invited`로 남고, 초대를 수락하면 권한이 적용됩니다.

## 7단계: 결과 안내

- 새 보드 링크를 `[보드 열기](URL)` 형식으로 안내합니다. 단축 URL이 등록됐다면 단축 URL을 대표 링크로 씁니다.
- 보드 이름, 생성 위치(개인 공간 등), 단축 URL(성공·실패 여부 포함), 올린 게시물 2개의 제목과 링크, 관리자로 초대한 이메일 목록(실패한 이메일 포함)을 정리합니다.
- 교안 링크 섹션이 비어 있음을 알리고, 교안 링크를 올릴지 묻습니다. (교안 링크 업로드는 `padlet-post-upload` 스킬로도 가능)

---

## 주의사항

- 보드 설명은 템플릿 문구(`실무에 바로 사용하는 팀스파르타 DX`)를 그대로 둡니다. 바꾸라는 요청이 있을 때만 `update_padlet_title_description`을 사용합니다.
- 수신자에게 나가는 것이 아니므로 별도 검수 없이 진행하되, 보드 이름과 링크는 1단계에서 반드시 확인한 값만 사용합니다.
- 패들렛 MCP 연결이 의심되면 `get_current_user_info`로 인증 상태를 먼저 확인합니다.
