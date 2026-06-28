const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// .env 로드
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^=#\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}
loadEnv();

// 이메일 스킬 시스템 프롬프트 (frontmatter 제거)
function loadSkillPrompt() {
  const skillPath = path.join(ROOT, '.claude', 'skills', 'email-draft', 'skill.md');
  if (!fs.existsSync(skillPath)) return '당신은 교육 이메일 초안 작성 도우미입니다.';
  const raw = fs.readFileSync(skillPath, 'utf8');
  return raw.replace(/^---[\s\S]*?---\n/, '').trim();
}
const SKILL_PROMPT = loadSkillPrompt();

// 대화 세션 (인메모리)
const sessions = new Map();

// Claude API 호출
async function callClaude(messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY가 .env 파일에 설정되지 않았습니다.');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SKILL_PROMPT,
      messages
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.content[0].text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── 정적 파일 ───────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ─── 서버 ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname } = url.parse(req.url);

  // ── 상태 저장 API ──────────────────────────────────────────
  if (pathname === '/api/state') {
    if (req.method === 'GET') {
      try {
        if (fs.existsSync(DATA_FILE)) {
          json(res, 200, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
        } else { json(res, 200, null); }
      } catch (e) { json(res, 500, { error: e.message }); }
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        fs.writeFileSync(DATA_FILE, JSON.stringify(JSON.parse(body), null, 2), 'utf8');
        json(res, 200, { ok: true });
      } catch (e) { json(res, 500, { error: e.message }); }
      return;
    }
    if (req.method === 'DELETE') {
      try {
        if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
        json(res, 200, { ok: true });
      } catch (e) { json(res, 500, { error: e.message }); }
      return;
    }
  }

  // ── 채팅 세션 시작 ─────────────────────────────────────────
  if (pathname === '/api/chat/start' && req.method === 'POST') {
    try {
      const { companyName } = JSON.parse(await readBody(req));
      const sessionId = crypto.randomBytes(8).toString('hex');
      const initMsg = companyName
        ? `안녕하세요! ${companyName} 관련 이메일 초안을 작성하겠습니다.\n\n어떤 메일 초안을 작성할까요?\n\n1. 첫 발송 메일 — 교육 시작 전 고객사 담당자에게 인사 및 교육 개요 안내\n2. 사업자등록증 요청 메일 — 세금계산서 발행을 위한 사업자등록증 송부 요청\n3. 세금계산서 발행 확인 요청 메일 — 교육 감사 인사와 함께 세금계산서 발행 여부 회신 요청\n\n번호 또는 이름으로 입력해 주세요.`
        : `안녕하세요! 이메일 초안을 작성하겠습니다.\n\n어떤 메일 초안을 작성할까요?\n\n1. 첫 발송 메일 — 교육 시작 전 고객사 담당자에게 인사 및 교육 개요 안내\n2. 사업자등록증 요청 메일 — 세금계산서 발행을 위한 사업자등록증 송부 요청\n3. 세금계산서 발행 확인 요청 메일 — 교육 감사 인사와 함께 세금계산서 발행 여부 회신 요청\n\n번호 또는 이름으로 입력해 주세요.`;

      sessions.set(sessionId, {
        companyName: companyName || '',
        messages: [{ role: 'assistant', content: initMsg }],
        createdAt: Date.now()
      });
      json(res, 200, { sessionId, message: initMsg });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ── 채팅 메시지 전송 ───────────────────────────────────────
  const chatMsgMatch = pathname.match(/^\/api\/chat\/([^/]+)\/message$/);
  if (chatMsgMatch && req.method === 'POST') {
    const sessionId = chatMsgMatch[1];
    const session = sessions.get(sessionId);
    if (!session) { json(res, 404, { error: '세션을 찾을 수 없습니다.' }); return; }
    try {
      const { text } = JSON.parse(await readBody(req));
      session.messages.push({ role: 'user', content: text });
      const reply = await callClaude(session.messages);
      session.messages.push({ role: 'assistant', content: reply });
      json(res, 200, { message: reply });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ── 세션 삭제 ──────────────────────────────────────────────
  const chatDelMatch = pathname.match(/^\/api\/chat\/([^/]+)$/);
  if (chatDelMatch && req.method === 'DELETE') {
    sessions.delete(chatDelMatch[1]);
    json(res, 200, { ok: true });
    return;
  }

  // ── 정적 파일 서빙 ─────────────────────────────────────────
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveStatic(res, filePath);
  } else {
    res.writeHead(404); res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`서버 실행 중 → http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY 미설정 — .env 파일에 추가하세요.');
  }
});
