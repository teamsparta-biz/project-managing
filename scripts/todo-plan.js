#!/usr/bin/env node
/**
 * todo-plan.js — 할 일 목록을 특정 날짜의 "오늘 할 일"로 지정한다.
 *
 * 사용법:
 *   node scripts/todo-plan.js <담당자명> <items.json> [--date YYYY-MM-DD] [--dry-run]
 *     - --date: 할 날 (기본: 오늘, KST)
 *
 * items.json 형식 (배열):
 *   [{ "title": "운영매니저 온보딩", "company": "한화에어로스페이스", "time": "06:00-16:00", "due": "2026-11-07" }, ...]
 *   - company, time, due는 생략 가능
 *
 * 동작:
 *   - 같은 기업의 미완료 할 일 중 제목이 같거나 한쪽이 다른 쪽을 포함하면 → 그 할 일의 plannedFor만 바꾼다(중복 생성 안 함)
 *   - 없으면 새 할 일을 만든다 (plannedFor 포함)
 *   - 다른 할 일·교육 데이터는 건드리지 않는다
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');
const ENV_PATH = path.join(ROOT, '.env');
const GENERAL_TAGS = ['공통', '기타']; // index.html의 TODO_GENERAL_TAGS와 같게 유지

const cleanName = (n) => String(n || '').replace(/\(주\)|주식회사|유한회사|㈜/g, '').trim();
const norm = (s) => String(s || '').replace(/[\s·,.\-_()[\]/:]/g, '').toLowerCase();

// 같은 일인지: 정규화한 제목이 같거나, 4글자 이상인 쪽이 다른 쪽에 포함되면 같은 일로 본다
function sameTask(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 4 && l.includes(s);
}

// 기업명 → 칸반 기업(교육 카드). 정확히 같은 이름 우선, 없으면 (주) 등을 뗀 이름으로. 진행 중인 카드 우선.
function resolveCompany(companies, name) {
  const n = String(name || '').trim();
  if (!n || GENERAL_TAGS.includes(n)) return null;
  const pool = [...companies].sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
  return pool.find(c => c.name === n) || pool.find(c => cleanName(c.name) === cleanName(n)) || null;
}

// todos에서 item과 같은 미완료 할 일을 찾는다
function findExisting(todos, item) {
  const comp = cleanName(item.company);
  return todos.find(t => {
    if (!t || t.done || t.deletedAt) return false;
    const tc = cleanName(t.company);
    if (comp) {
      if (tc === comp) return sameTask(t.title, item.title);
      // 예전 항목은 기업명이 제목 앞에 붙어 있기도 하다 (예: "한국투자리얼에셋 윤리실천서약서 송부")
      if (!tc) return sameTask(t.title, `${comp} ${item.title}`);
      return false;
    }
    return sameTask(t.title, item.title);
  }) || null;
}

function applyPlan(state, items, date, now = new Date().toISOString()) {
  if (!Array.isArray(state.todos)) state.todos = [];
  const companies = Array.isArray(state.companies) ? state.companies : [];
  const planned = [], created = [];
  for (const it of items) {
    const title = String(it.title || '').trim();
    const existing = findExisting(state.todos, it);
    if (existing) {
      existing.plannedFor = date;
      if (it.time) existing.time = it.time;
      if (it.due && !existing.due) existing.due = it.due;
      planned.push(existing);
      continue;
    }
    const co = resolveCompany(companies, it.company);
    const company = co ? co.name : String(it.company || '').trim();
    const todo = {
      id: 'todo_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      title, company, companyId: co ? co.id : null,
      due: it.due || '', plannedFor: date, done: false, createdAt: now, doneAt: null,
    };
    if (it.time) todo.time = it.time;
    state.todos.push(todo);
    created.push(todo);
  }
  return { planned, created };
}

module.exports = { sameTask, findExisting, resolveCompany, applyPlan };

// ---------------- CLI ----------------
function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) throw new Error('.env에 SUPABASE_URL / SUPABASE_KEY 없음');
  return env;
}

async function main() {
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf('--date');
  const date = dateIdx >= 0 ? args[dateIdx + 1] : new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const positional = args.filter((a, i) => !a.startsWith('--') && !(dateIdx >= 0 && i === dateIdx + 1));
  const [OWNER, ITEMS_PATH] = positional;
  const DRY_RUN = args.includes('--dry-run');
  if (!OWNER || !ITEMS_PATH) {
    console.error('usage: node scripts/todo-plan.js <담당자명> <items.json> [--date YYYY-MM-DD] [--dry-run]');
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date 형식 오류(YYYY-MM-DD): ${date}`);

  const items = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf8'));
  if (!Array.isArray(items) || !items.length) throw new Error('items.json은 비어 있지 않은 배열이어야 함');
  for (const it of items) {
    if (!it || !String(it.title || '').trim()) throw new Error('title이 없는 항목이 있음');
    if (it.due && !/^\d{4}-\d{2}-\d{2}$/.test(it.due)) throw new Error(`due 형식 오류(YYYY-MM-DD): ${it.due}`);
  }

  const env = loadEnv();
  const headers = (extra) => Object.assign({
    apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, 'User-Agent': 'node-todo-plan/1.0',
  }, extra);
  const sbGet = async (select) => {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/user_states?owner=eq.${encodeURIComponent(OWNER)}&select=${select}`, { headers: headers() });
    if (!res.ok) throw new Error(`Supabase GET 실패 ${res.status}: ${await res.text()}`);
    return res.json();
  };

  const rows = await sbGet('data,updated_at');
  if (!rows.length || !rows[0].data) throw new Error(`Supabase에 '${OWNER}' 담당자 데이터가 없음`);
  const state = rows[0].data;
  const baselineUpdatedAt = rows[0].updated_at;
  const { planned, created } = applyPlan(state, items, date);

  const line = (t) => `  - ${t.company ? `[${t.company}] ` : ''}${t.time ? t.time + ' ' : ''}${t.title}`;
  const report = (tail) => [
    `=== ${date} 오늘 할 일 지정 — ${OWNER} ===`,
    `기존 할 일에 지정: ${planned.length}건`, ...planned.map(line),
    `새로 만듦: ${created.length}건`, ...created.map(line),
    tail,
  ].join('\n');

  if (DRY_RUN) { console.log(report('DRY-RUN — 저장 생략')); return; }

  const latest = await sbGet('updated_at');
  if (latest.length && latest[0].updated_at !== baselineUpdatedAt) {
    console.log('⚠️ 동시편집 감지 — 저장 중단. 다시 실행하면 최신 상태 위에 적용됩니다.');
    process.exit(2);
  }
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/user_states?on_conflict=owner`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json; charset=utf-8', Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify({ owner: OWNER, data: state, updated_at: new Date().toISOString() }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase POST 실패 ${res.status}: ${text}`);
  const saved = JSON.parse(text);
  if (saved[0]?.data?.todos?.length !== state.todos.length) throw new Error('POST 반영 불일치');
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log(report('Supabase 저장 완료'));
}

if (require.main === module) {
  main().catch(err => { console.error('ERROR: ' + err.message); process.exit(1); });
}
