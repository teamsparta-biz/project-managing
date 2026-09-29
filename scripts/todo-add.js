#!/usr/bin/env node
/**
 * todo-add.js — 칸반보드 "내 할 일"(state.todos)에 항목을 추가한다.
 *
 * 사용법:
 *   node scripts/todo-add.js <담당자명> <items.json> [--dry-run]
 *
 * items.json 형식 (배열):
 *   [{ "title": "TSP 일정확인", "company": "삼성전자", "due": "2026-10-01" }, ...]
 *   - company, due는 생략 가능 (due는 YYYY-MM-DD)
 *   - company는 칸반보드 기업명과 정확히 같으면 해당 교육 카드에 연결된다
 *
 * 기존 할 일·교육 데이터는 건드리지 않고 todos 배열에 추가만 한다.
 * 열려 있는 웹앱 탭은 창에 다시 포커스될 때 새 항목을 자동으로 불러온다.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');
const ENV_PATH = path.join(ROOT, '.env');

const [OWNER, ITEMS_PATH] = process.argv.slice(2);
const DRY_RUN = process.argv.includes('--dry-run');

if (!OWNER || !ITEMS_PATH) {
  console.error('usage: node scripts/todo-add.js <담당자명> <items.json> [--dry-run]');
  process.exit(1);
}

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) throw new Error('.env에 SUPABASE_URL / SUPABASE_KEY 없음');
  return env;
}

function headers(env, extra) {
  return Object.assign({
    apikey: env.SUPABASE_KEY,
    Authorization: `Bearer ${env.SUPABASE_KEY}`,
    'User-Agent': 'node-todo-add/1.0',
  }, extra);
}

async function sbGet(env, select) {
  const url = `${env.SUPABASE_URL}/rest/v1/user_states?owner=eq.${encodeURIComponent(OWNER)}&select=${select}`;
  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) throw new Error(`Supabase GET 실패 ${res.status}: ${await res.text()}`);
  return res.json();
}

function newId() {
  return 'todo_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

async function main() {
  const env = loadEnv();
  const items = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf8'));
  if (!Array.isArray(items) || !items.length) throw new Error('items.json은 비어 있지 않은 배열이어야 함');
  for (const it of items) {
    if (!it || !String(it.title || '').trim()) throw new Error('title이 없는 항목이 있음');
    if (it.due && !/^\d{4}-\d{2}-\d{2}$/.test(it.due)) throw new Error(`due 형식 오류(YYYY-MM-DD): ${it.due}`);
  }

  const rows = await sbGet(env, 'data,updated_at');
  if (!rows.length || !rows[0].data) throw new Error(`Supabase에 '${OWNER}' 담당자 데이터가 없음 — 웹앱에서 한 번 접속한 뒤 다시 실행`);
  const state = rows[0].data;
  const baselineUpdatedAt = rows[0].updated_at;
  if (!Array.isArray(state.todos)) state.todos = [];
  const companies = Array.isArray(state.companies) ? state.companies : [];

  const added = [], unmatched = [];
  const now = new Date().toISOString();
  for (const it of items) {
    const company = String(it.company || '').trim();
    const co = company ? companies.find(c => c.name === company) : null;
    if (company && !co) unmatched.push(company);
    const todo = {
      id: newId(), title: String(it.title).trim(), company, companyId: co ? co.id : null,
      due: it.due || '', done: false, createdAt: now, doneAt: null,
    };
    state.todos.push(todo);
    added.push(`${company ? `[${company}] ` : ''}${todo.title}${todo.due ? ` — ${todo.due}까지` : ''}`);
  }

  if (DRY_RUN) {
    console.log(report('DRY-RUN — 저장 생략'));
    return;
  }

  const latest = await sbGet(env, 'updated_at');
  if (latest.length && latest[0].updated_at !== baselineUpdatedAt) {
    console.log('⚠️ 동시편집 감지 — 저장 중단. 다시 실행하면 최신 상태 위에 추가됩니다.');
    process.exit(2);
  }

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/user_states?on_conflict=owner`, {
    method: 'POST',
    headers: headers(env, {
      'Content-Type': 'application/json; charset=utf-8',
      Prefer: 'resolution=merge-duplicates,return=representation',
    }),
    body: JSON.stringify({ owner: OWNER, data: state, updated_at: new Date().toISOString() }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase POST 실패 ${res.status}: ${text}`);
  const saved = JSON.parse(text);
  const n = saved[0]?.data?.todos?.length;
  if (n !== state.todos.length) throw new Error(`POST 반영 불일치: 기대 ${state.todos.length}건, 응답 ${n}건`);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log(report(`Supabase 저장 완료 — todos ${n}건`));

  function report(tail) {
    const lines = [`=== 내 할 일 추가 — ${OWNER} ===`, `추가: ${added.length}건`, ...added.map(x => '  - ' + x)];
    if (unmatched.length) lines.push(`칸반보드에 없는 기업명(카드 연결 안 됨): ${[...new Set(unmatched)].join(', ')}`);
    lines.push(tail);
    return lines.join('\n');
  }
}

main().catch(err => { console.error('ERROR: ' + err.message); process.exit(1); });
