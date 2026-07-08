# 교육 프로젝트 진행 현황 관리 툴

스파르타 기업교육 담당자를 위한 프로젝트(기업별 교육) 진행 현황 관리 웹앱입니다. 기업별 업무 체크리스트, 회차별 일정 관리, ax-hub 데이터 자동 동기화, Claude Code 연동 이메일/Slack 자동화 기능을 제공합니다.

> 사용법 전체(화면 구성, 버튼, 스킬 상세 설명)는 [GUIDE.md](./GUIDE.md)를 참고하세요. 이 문서는 **처음 설치부터 실행까지**를 안내합니다.

---

## 1. 필요한 것

- [Node.js](https://nodejs.org/) (버전 16 이상 권장)
- [Git](https://git-scm.com/)
- [Claude Code](https://claude.com/claude-code) — 이메일 초안, Slack 연동 등 자동화 스킬 사용 시 필요 (선택)

---

## 2. 설치

```bash
# 1) 저장소 클론
git clone https://github.com/teamsparta-biz/project-managing.git
cd project-managing

# 2) 의존성 설치 (server.js는 Node 내장 모듈만 사용하므로 설치할 패키지는 없습니다)
```

이 프로젝트는 별도의 npm 패키지 없이 Node.js 내장 `http` 모듈만으로 동작하는 순수 서버입니다. `npm install`이 필요 없습니다.

---

## 3. 환경변수(.env) 설정

프로젝트 루트에 `.env.example`을 복사해 `.env` 파일을 만듭니다.

```bash
# macOS/Linux
cp .env.example .env

# Windows (cmd)
copy .env.example .env
```

`.env` 내용을 아래와 같이 채웁니다.

```env
SUPABASE_URL=https://riwkyupmrtmksryrzjpm.supabase.co
SUPABASE_KEY=sb_publishable_QgDx1Nu32oeKMymnmvZWgA_oeBzYdj_
USER_EMAIL=본인이메일@teamsparta.co
```

| 항목 | 설명 | 필수 여부 |
|------|------|----------|
| `SUPABASE_URL` | Supabase 프로젝트 URL | 변경 불필요 (팀 공용) |
| `SUPABASE_KEY` | Supabase 공개 키 | 변경 불필요 (팀 공용) |
| `USER_EMAIL` | 본인의 팀스파르타 이메일 | **본인 이메일로 변경 필수** |

> `USER_EMAIL`은 `email-draft`, `tax-invoice-inquiry` 같은 스킬이 ax-hub에서 발신자 이름을 자동 조회하는 데 사용됩니다.

이메일 초안 작성 기능(웹 채팅형 초안 도우미)을 쓰려면 `ANTHROPIC_API_KEY`도 함께 추가합니다.

```env
ANTHROPIC_API_KEY=sk-ant-...
```

---

## 4. 서버 실행

```bash
node server.js
```

정상적으로 뜨면 아래 메시지가 출력됩니다.

```
서버 실행 중 → http://localhost:3000
```

브라우저에서 `http://localhost:3000`에 접속하면 앱이 열립니다.

### Windows에서 더블클릭으로 실행하기

`start.bat` 파일을 더블클릭하면 서버를 백그라운드로 실행하고 브라우저를 자동으로 엽니다 (이미 실행 중이면 새로 띄우지 않고 브라우저만 엽니다).

---

## 5. 앱 처음 사용하기

1. 앱을 처음 열면 **이름 선택 팝업**이 뜹니다. 등록된 이름이 없으면 **이름 추가** 버튼으로 본인 이름을 등록하고 선택합니다.
2. **시작하기**를 클릭하면 해당 이름으로 데이터가 분리 저장되어 관리됩니다. (우측 상단 이름 배지에서 언제든 전환 가능)
3. 상단 툴바에서 **기업 추가**로 담당 중인 기업(프로젝트)을 등록하거나, **교육 가져오기** 버튼으로 ax-hub의 기존 교육 데이터를 자동으로 불러올 수 있습니다.

이후 화면 구성, 업무 체크, 일정 관리 등 상세 사용법은 [GUIDE.md의 3장부터](./GUIDE.md#3-화면-구성-개요)를 참고하세요.

---

## 6. Claude Code 자동화 스킬 연결 (선택, 1회 설정)

이메일 초안 자동 저장, Slack 단톡방 개설, ax-hub 동기화 등의 버튼은 **Claude Code**와 연동되어 동작합니다. 사용하려면 아래 연동을 최초 1회 진행하세요.

### 6-1. Gmail 연결

1. [claude.ai](https://claude.ai) 로그인 → **Settings → Integrations**
2. **Gmail** 항목에서 **Connect** 클릭 → 업무용 Google 계정(`@teamsparta.co`)으로 로그인 및 권한 허용

확인: Claude Code 터미널에 `Gmail 임시보관함에 테스트 메일 초안 만들어줘` 입력 후 정상 응답이 오면 완료.

### 6-2. Slack 연결

1. [claude.ai](https://claude.ai) → **Settings → Integrations**
2. **Slack** 항목에서 **Connect** 클릭 → 팀스파르타 워크스페이스 선택 및 권한 허용

확인: Claude Code 터미널에 `Slack에서 채널 목록 검색해줘` 입력 후 채널 목록이 반환되면 완료.

> Slack 메시지 전송 전에는 Claude Code가 항상 확인을 요청하므로 실수로 전송될 걱정은 없습니다.

### 6-3. ax-hub

별도 설정 없이 팀 MCP 서버에 자동 연결됩니다.

자세한 연동 방법과 스크린샷 안내는 [GUIDE.md 2장](./GUIDE.md#2-사전-설정--gmail--slack--환경변수)을 참고하세요.

---

## 7. 자동화 스킬 사용법 (요약)

Claude Code 연동이 끝나면, 앱의 각 버튼을 클릭했을 때 해당 스킬 명령어가 **클립보드에 자동 복사**됩니다. 이를 Claude Code 터미널에 붙여넣어 실행하면 됩니다.

| 스킬 | 버튼 | 용도 |
|------|------|------|
| `sync-ax-hub` | 교육 가져오기 | ax-hub 교육 데이터를 웹앱에 동기화 |
| `email-draft` | 이메일 초안 | 교육 시작 전 안내 메일 초안 작성 → Gmail 임시보관함 저장 |
| `lecture-draft-send` | 교안송부 | 교안 초안 링크 송부 메일 작성 |
| `tax-invoice-inquiry` | 세금계산서발행 | 세금계산서 발행 확인 메일 작성 |
| `tutor_onboarding` | SlackDM방 개설 | 강사·튜터 슬랙 단톡방 생성 및 안내 메시지 전송 |
| `ax-edu-slack-share` | 교육운영내용 | 교육 정보를 Slack 채널에 공유 |
| `recruit-share` | - | 주강사/기술튜터 구인 글 슬랙 전송 |
| `notion-share` | - | 노션 페이지 공유 인원 추가 |

스킬은 `.claude/skills/` 폴더에 저장되어 있으며, 저장소를 클론하면 자동으로 포함됩니다. **팀원이 스킬을 업데이트했다면 `git pull`로 최신화**하세요.

각 스킬의 상세 사용법(입력 항목, 진행 단계 등)은 [GUIDE.md 11장](./GUIDE.md#11-스킬-사용법)에 정리되어 있습니다.

---

## 8. 프로젝트 구조

```
├── index.html          # 프론트엔드 전체 (단일 파일 SPA)
├── server.js            # 정적 파일 서빙 + 상태 저장 API + 이메일 초안 채팅 API
├── api/                 # (Vercel 배포용) 서버리스 함수
├── data/
│   └── state.json        # 로컬 실행 시 데이터 저장 파일 (git에는 포함되지 않음)
├── .claude/skills/       # Claude Code 자동화 스킬 모음
├── .env.example          # 환경변수 예시 파일
├── start.bat             # Windows용 실행 스크립트
└── GUIDE.md              # 상세 사용 가이드
```

---

## 9. 문제 해결

| 증상 | 해결 방법 |
|------|----------|
| `ANTHROPIC_API_KEY 미설정` 경고 | `.env`에 `ANTHROPIC_API_KEY` 추가 (이메일 채팅 초안 기능에만 필요) |
| 포트 3000이 이미 사용 중 | `server.js` 상단의 `PORT` 값을 변경하거나 기존 프로세스 종료 |
| 스킬 실행 시 이름/이메일을 매번 물어봄 | `.env`의 `USER_EMAIL`을 본인 이메일로 설정했는지 확인 |
| 동기화했는데 화면에 반영이 안 됨 | 브라우저에서 새로고침(F5) |
| 스킬이 예전 버전으로 동작함 | `git pull`로 최신 스킬을 받았는지 확인 |
