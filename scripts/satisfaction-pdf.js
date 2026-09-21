#!/usr/bin/env node
/**
 * 만족도조사 결과 요약 PDF 생성
 *
 * ax-hub survey_sync_* 테이블에서 집계한 만족도 점수를 간단한 표 형태의
 * 1페이지 PDF로 렌더링한다. 이메일 첨부용으로 쓰기 때문에 파일 크기를
 * 최소화하는 것이 목적 — 이미지·외부 폰트 없이 순수 HTML 표만 사용한다.
 *
 * Playwright는 이 저장소가 Google Drive 동기화 폴더 안에 있어 대용량
 * 패키지 설치 시 파일이 깨지는 문제가 있어, 별도 폴더
 * (%USERPROFILE%\.padlet-automation) 에 설치해 두고 여기서 경로로 불러온다.
 *
 * 결과 PDF는 base64로 이메일에 직접 첨부하지 않는다 — 실측상 3만자대
 * base64도 읽는 데만 3만 토큰 이상 들어 비현실적이다. 대신 이 저장소가
 * 구글 드라이브 동기화 폴더 안에 있다는 점을 이용해, 저장된 PDF를 그대로
 * 구글 드라이브에서 찾아 링크로 공유한다(tax-invoice-inquiry 스킬 2-1단계 참고).
 *
 * 사용법:
 *   node satisfaction-pdf.js <입력 JSON 경로> <출력 PDF 경로>
 *
 * 입력 JSON 형식:
 * {
 *   "company": "한국은행",
 *   "course": "AI 리더십 입문",
 *   "respondentCount": 46,
 *   "overallAvg": 4.6,
 *   "questions": [
 *     { "label": "전체 교육 과정에 대한 전반적인 만족도", "avg": 4.7 },
 *     ...
 *   ]
 * }
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const DEPS_DIR = path.join(os.homedir(), ".padlet-automation");

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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function buildHtml(data) {
  const rows = (data.questions || [])
    .map(
      (q) =>
        `<tr><td class="q">${escapeHtml(q.label)}</td><td class="score">${escapeHtml(q.avg)}</td></tr>`
    )
    .join("\n");

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: "Malgun Gothic", sans-serif; font-size: 12px; color: #222; margin: 24px; }
  h1 { font-size: 16px; margin-bottom: 4px; }
  .meta { color: #555; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
  th { background: #f2f2f2; }
  .score { text-align: center; width: 80px; }
  .overall { font-size: 14px; font-weight: bold; margin: 16px 0; }
</style></head>
<body>
  <h1>${escapeHtml(data.company)} - ${escapeHtml(data.course)} 만족도 조사 결과</h1>
  <div class="meta">응답 인원: ${escapeHtml(data.respondentCount)}명</div>
  <div class="overall">전체 평균: ${escapeHtml(data.overallAvg)}점 / 5.0</div>
  <table>
    <thead><tr><th>문항</th><th>평균</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body></html>`;
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error("사용법: node satisfaction-pdf.js <입력 JSON> <출력 PDF>");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const html = buildHtml(data);

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: outputPath, format: "A4", printBackground: true, tagged: false });
  } finally {
    await browser.close();
  }

  const size = fs.statSync(outputPath).size;
  const b64 = fs.readFileSync(outputPath).toString("base64");
  const b64Path = outputPath + ".b64.txt";
  const CHUNK = 500;
  const chunked = b64.match(new RegExp(`.{1,${CHUNK}}`, "g")).join("\n");
  fs.writeFileSync(b64Path, chunked, "utf8");

  console.log(
    `PDF 생성 완료: ${outputPath} (${size} bytes, base64 ${b64.length}자)\n` +
      `base64(줄바꿈 ${CHUNK}자 단위): ${b64Path}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
