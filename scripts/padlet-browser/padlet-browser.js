#!/usr/bin/env node
/**
 * Padlet 웹 UI 브라우저 자동화 (API로 불가능한 동작 전용)
 *
 * Padlet 공식 API(api.padlet.dev)는 보드 템플릿 복제, 보드 제목 수정,
 * URL 단축 등록, 게시물 수정/삭제를 지원하지 않는다. 이 스크립트는
 * 그 영역만 Playwright로 실제 Padlet 웹사이트를 조작해 대신한다.
 * (게시물 생성/조회처럼 API가 되는 작업은 이 스크립트를 쓰지 않고
 * padlet-post-upload 스킬의 PowerShell + REST 호출을 그대로 쓴다.)
 *
 * Playwright는 이 저장소가 Google Drive 동기화 폴더 안에 있어 대용량
 * 패키지 설치 시 파일이 깨지는 문제가 있어, 별도 폴더
 * (%USERPROFILE%\.padlet-automation) 에 설치해 두고 여기서 경로로 불러온다.
 *
 * 사용법:
 *   node padlet-browser.js login
 *   node padlet-browser.js clone   --template <템플릿 보드 URL> --title "<새 제목>"
 *   node padlet-browser.js rename  --board <보드 URL> --title "<새 제목>"
 *   node padlet-browser.js shorten --board <보드 URL> --slug <biz14 뒤에 붙일 슬러그>
 *
 * 옵션:
 *   --headless   브라우저 창을 띄우지 않음 (기본은 headed — 최초 실행 시
 *                셀렉터가 실제 화면과 맞는지 눈으로 확인하는 걸 권장)
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const DEPS_DIR = path.join(os.homedir(), ".padlet-automation");
const SESSION_PATH = path.join(__dirname, "..", "..", "data", "padlet-session.json");

function loadPlaywright() {
  const pwPath = path.join(DEPS_DIR, "node_modules", "playwright");
  if (!fs.existsSync(pwPath)) {
    console.error(
      `Playwright를 찾을 수 없습니다: ${pwPath}\n` +
        `아래 명령으로 먼저 설치하세요 (Google Drive 폴더 밖에 설치):\n` +
        `  mkdir "${DEPS_DIR}"\n` +
        `  cd "${DEPS_DIR}" && npm init -y && npm install playwright && npx playwright install chromium`
    );
    process.exit(1);
  }
  return require(pwPath);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// 번들 Chromium은 Padlet(Cloudflare) 보안 검사에서 봇으로 걸려 통과가 안 됨.
// 실제 설치된 Chrome(channel: "chrome") + automation 흔적 제거로 우회.
const LAUNCH_OPTS = {
  channel: "chrome",
  args: ["--disable-blink-features=AutomationControlled"],
};
const CONTEXT_OPTS = {
  viewport: { width: 1366, height: 900 },
  locale: "ko-KR",
};
const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = { runtime: {} };
  Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
`;

async function withBrowser(headless, fn) {
  const { chromium } = loadPlaywright();
  const hasSession = fs.existsSync(SESSION_PATH);
  if (!hasSession) {
    console.error(
      `로그인 세션이 없습니다: ${SESSION_PATH}\n` +
        `먼저 로그인 세션을 저장하세요:\n  node padlet-browser.js login`
    );
    process.exit(1);
  }
  const browser = await chromium.launch({ ...LAUNCH_OPTS, headless });
  const context = await browser.newContext({ ...CONTEXT_OPTS, storageState: SESSION_PATH });
  await context.addInitScript(STEALTH_INIT_SCRIPT);
  const page = await context.newPage();
  try {
    return await fn(page, context);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// login: 수동 로그인 후 세션(쿠키+localStorage) 저장
// ---------------------------------------------------------------------------
async function cmdLogin() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ ...LAUNCH_OPTS, headless: false });
  const context = await browser.newContext(CONTEXT_OPTS);
  await context.addInitScript(STEALTH_INIT_SCRIPT);
  const page = await context.newPage();
  await page.goto("https://padlet.com/auth/login");

  console.log(
    "\n브라우저 창에서 Padlet에 직접 로그인하세요.\n" +
      "로그인이 끝나고 대시보드(내 패들렛 목록)가 보이면 이 터미널로 돌아와\n" +
      "Enter 키를 누르세요.\n"
  );
  await waitForEnter();

  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  await context.storageState({ path: SESSION_PATH });
  console.log(`세션 저장 완료: ${SESSION_PATH}`);
  await browser.close();
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// clone: 템플릿 보드를 복제하고 제목을 바꾼 뒤 새 보드 URL을 출력
// ---------------------------------------------------------------------------
async function cmdClone(args) {
  const { template, title, headless } = args;
  if (!template || !title) {
    console.error('사용법: clone --template <템플릿 보드 URL> --title "<새 제목>"');
    process.exit(1);
  }

  const result = await withBrowser(!!headless, async (page) => {
    await page.goto(template, { waitUntil: "domcontentloaded" });

    // "···" 더보기 메뉴 → "복제/Make a copy" (한/영 UI 모두 대응)
    const moreButton = page
      .getByRole("button", { name: /더\s*보기|more|옵션|options/i })
      .first();
    await moreButton.click({ timeout: 15000 });

    const copyItem = page
      .getByText(/복제|Make a copy|Duplicate/i)
      .first();
    await copyItem.click({ timeout: 15000 });

    // 복제된 새 보드로 이동할 때까지 대기 (URL이 바뀜)
    await page.waitForURL((url) => url.toString() !== template, { timeout: 30000 });
    await page.waitForLoadState("domcontentloaded");

    const newUrl = page.url();
    await renameBoardTitle(page, title);

    return newUrl;
  });

  console.log(`복제 완료. 새 보드 URL: ${result}`);
  console.log(`board_id는 URL 마지막 슬러그 부분입니다 (padlet-post-upload 4단계에서 그대로 사용 가능).`);
}

// ---------------------------------------------------------------------------
// rename: 기존 보드 제목만 수정
// ---------------------------------------------------------------------------
async function cmdRename(args) {
  const { board, title, headless } = args;
  if (!board || !title) {
    console.error('사용법: rename --board <보드 URL> --title "<새 제목>"');
    process.exit(1);
  }

  await withBrowser(!!headless, async (page) => {
    await page.goto(board, { waitUntil: "domcontentloaded" });
    await renameBoardTitle(page, title);
  });

  console.log(`제목 변경 완료: ${title}`);
}

async function renameBoardTitle(page, newTitle) {
  // 보드 상단 제목은 대개 contenteditable 요소 (h1/textarea 형태 모두 존재)
  const titleEl = page
    .locator('[data-testid="wallSubjectInput"], h1[contenteditable], textarea[name="subject"]')
    .first();
  await titleEl.click({ timeout: 15000 });

  const isMac = process.platform === "darwin";
  await page.keyboard.press(isMac ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await titleEl.fill(newTitle).catch(async () => {
    await page.keyboard.type(newTitle);
  });
  await page.keyboard.press("Tab"); // 포커스 아웃 → 저장 트리거
  await page.waitForTimeout(1000);
}

// ---------------------------------------------------------------------------
// shorten: 보드 설정 > 고급 > URL 단축 등록
// ---------------------------------------------------------------------------
async function cmdShorten(args) {
  const { board, slug, headless } = args;
  if (!board || !slug) {
    console.error("사용법: shorten --board <보드 URL> --slug <슬러그>");
    process.exit(1);
  }

  await withBrowser(!!headless, async (page) => {
    await page.goto(board, { waitUntil: "domcontentloaded" });

    const settingsButton = page
      .getByRole("button", { name: /설정|settings/i })
      .first();
    await settingsButton.click({ timeout: 15000 });

    const advancedTab = page.getByText(/고급|advanced/i).first();
    await advancedTab.click({ timeout: 15000 });

    const slugInput = page
      .locator('input[name*="slug" i], input[placeholder*="url" i]')
      .first();
    await slugInput.fill(slug, { timeout: 15000 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
  });

  console.log(`URL 단축 등록 완료: https://padlet.com/biz14/${slug}`);
}

// ---------------------------------------------------------------------------
async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  switch (cmd) {
    case "login":
      return cmdLogin();
    case "clone":
      return cmdClone(args);
    case "rename":
      return cmdRename(args);
    case "shorten":
      return cmdShorten(args);
    default:
      console.log(
        "사용법:\n" +
          "  node padlet-browser.js login\n" +
          '  node padlet-browser.js clone   --template <URL> --title "<제목>"\n' +
          '  node padlet-browser.js rename  --board <URL> --title "<제목>"\n' +
          "  node padlet-browser.js shorten --board <URL> --slug <슬러그>\n"
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("오류:", err.message || err);
  process.exit(1);
});
