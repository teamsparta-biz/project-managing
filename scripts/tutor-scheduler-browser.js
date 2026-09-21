#!/usr/bin/env node
/**
 * tutor-scheduler-wheat.vercel.app 웹앱 브라우저 자동화
 *
 * 이 웹앱의 /survey-results 페이지는 @teamsparta.co 구글 계정 로그인이
 * 필요하다. 로그인은 사용자가 직접 해야 하므로(OAuth, 2단계 인증 등)
 * 최초 1회 `login` 명령으로 세션(쿠키)을 저장해두고, 이후 `pdf` 명령은
 * 그 세션을 재사용해 특정 교육의 설문 결과 페이지를 PDF로 저장한다.
 *
 * Playwright는 이 저장소가 Google Drive 동기화 폴더 안에 있어 대용량
 * 패키지 설치 시 파일이 깨지는 문제가 있어, 별도 폴더
 * (%USERPROFILE%\.padlet-automation) 에 설치해 두고 여기서 경로로 불러온다.
 *
 * 사용법:
 *   node tutor-scheduler-browser.js login
 *   node tutor-scheduler-browser.js pdf --query "AI 리더십 입문" --out "data/AI 리더십 입문_결과보고서.pdf"
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const DEPS_DIR = path.join(os.homedir(), ".padlet-automation");
const SESSION_PATH = path.join(__dirname, "..", "data", "tutor-scheduler-session.json");
const BASE_URL = "https://tutor-scheduler-wheat.vercel.app";

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

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function cmdLogin(args) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "ko-KR" });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/survey-results`);

  console.log(
    "\n브라우저 창에서 'Google로 로그인'을 눌러 @teamsparta.co 계정으로 로그인하세요.\n" +
      "로그인이 끝나면 자동으로 감지해 세션을 저장합니다 (최대 " + (args.timeout || 180) + "초 대기).\n"
  );

  // Enter 입력을 기다리는 대신, 로그인 버튼이 화면에서 사라지는 것을 폴링으로 감지한다.
  // (이 스크립트를 호출하는 도구가 실제 터미널 stdin과 연결되지 않을 수 있어 안전한 방식.)
  // OAuth 리다이렉트 도중 버튼이 잠깐 사라지는 것과 실제 로그인 완료를 구분하기 위해,
  // "우리 앱 도메인 + 로그인 버튼 없음" 상태가 2회 연속(4초 간격) 확인될 때만 완료로 간주한다.
  const timeoutMs = (Number(args.timeout) || 180) * 1000;
  const loginButton = page.getByText("Google로 로그인");
  const start = Date.now();
  let loggedIn = false;
  let consecutiveOk = 0;
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(2000);
    const onOurDomain = page.url().startsWith(BASE_URL);
    const stillOnLogin = onOurDomain
      ? await loginButton.count().then((n) => n > 0).catch(() => true)
      : true;
    if (onOurDomain && !stillOnLogin) {
      consecutiveOk++;
      if (consecutiveOk >= 2) {
        loggedIn = true;
        break;
      }
    } else {
      consecutiveOk = 0;
    }
  }

  if (!loggedIn) {
    console.error("로그인 완료를 감지하지 못했습니다 (타임아웃). 로그인 후 다시 실행해 주세요.");
    await browser.close();
    process.exit(1);
  }

  await page.waitForTimeout(1500); // 로그인 직후 화면 안정화 대기
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  await context.storageState({ path: SESSION_PATH });
  console.log(`세션 저장 완료: ${SESSION_PATH}`);
  await browser.close();
}

async function withBrowser(headless, fn) {
  const { chromium } = loadPlaywright();
  if (!fs.existsSync(SESSION_PATH)) {
    console.error(`로그인 세션이 없습니다: ${SESSION_PATH}\n먼저 실행하세요:\n  node tutor-scheduler-browser.js login`);
    process.exit(1);
  }
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: "ko-KR",
    storageState: SESSION_PATH,
  });
  const page = await context.newPage();
  try {
    return await fn(page, context);
  } finally {
    await browser.close();
  }
}

async function cmdInspect(args) {
  await withBrowser(true, async (page) => {
    await page.goto(`${BASE_URL}/survey-results`, { waitUntil: "networkidle", timeout: 30000 });
    const outPng = args.out || "data/.survey_results_inspect.png";
    await page.screenshot({ path: outPng, fullPage: true });
    console.log(`스크린샷 저장: ${outPng}`);
    console.log("페이지 제목:", await page.title());
  });
}

// /survey-results 는 teamsparta-survey.vercel.app 을 iframe(JWT 서명된 임베드 URL)으로
// 감싼 페이지다. "PDF로 저장" 버튼은 window.print()를 호출하는 것으로 보이는데,
// headless 환경에서는 그 네이티브 인쇄 다이얼로그를 가로챌 수 없다(다운로드/팝업
// 이벤트 둘 다 발생하지 않음, 2026-09-07 확인). 대신 그 임베드 URL을 새 탭에서
// 단독으로 열면 사이드바 없는 깨끗한 보고서 레이아웃이 나오므로, 그 페이지를
// 직접 print-media로 렌더링해 PDF를 만든다.
async function cmdPdf(args) {
  const query = args.query;
  const outPath = args.out;
  if (!query || !outPath) {
    console.error('사용법: node tutor-scheduler-browser.js pdf --query "카드에 보이는 텍스트(예: [한국은행] AI 리더십 입문)" --out "저장경로.pdf"');
    process.exit(1);
  }

  const embedUrl = await withBrowser(true, async (page) => {
    await page.goto(`${BASE_URL}/survey-results`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);

    const frame = page.frames().find((f) => f.url().includes("teamsparta-survey"));
    if (!frame) throw new Error("설문 결과 iframe을 찾지 못했습니다.");

    const item = frame.getByText(query).first();
    if ((await item.count()) === 0) {
      throw new Error(`'${query}' 카드를 목록에서 찾지 못했습니다 (탭이 다르거나 이름이 다를 수 있음).`);
    }
    await item.click();
    await page.waitForTimeout(2000);

    const detailFrame = page.frames().find((f) => f.url().includes("teamsparta-survey"));
    if (!detailFrame) throw new Error("상세 결과 iframe을 찾지 못했습니다.");
    return detailFrame.url();
  });

  // 세션이 필요한 페이지(교육명·기업명 등)에서 얻은 embedUrl 자체는 JWT로
  // 서명된 공개 임베드 링크라 별도 로그인 없이 열린다.
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 1400 } });
    const page = await context.newPage();
    await page.goto(embedUrl, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(300);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      tagged: false,
      margin: { top: "10mm", bottom: "10mm", left: "8mm", right: "8mm" },
    });
  } finally {
    await browser.close();
  }

  const size = fs.statSync(outPath).size;
  console.log(`PDF 저장 완료: ${outPath} (${size} bytes)`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (cmd === "login") return cmdLogin(args);
  if (cmd === "inspect") return cmdInspect(args);
  if (cmd === "pdf") return cmdPdf(args);

  console.error("사용법: node tutor-scheduler-browser.js <login|inspect|pdf> [옵션]");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
