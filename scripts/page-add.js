#!/usr/bin/env node
/**
 * page-add.js — 칸반보드 교육 카드의 "교육 노트"(company.page, 마크다운)에 내용을 추가한다.
 *
 * 사용법:
 *   node scripts/page-add.js <담당자명> <기업명|카드id> <content.md> [--replace] [--dry-run]
 *
 *   - 기업명은 칸반보드 기업명과 정확히 같아야 한다. 같은 이름의 카드가 여러 개면
 *     진행 중(archived=false) 카드를 우선하고, 그래도 여럿이면 카드 id 목록을 보여주고 중단한다.
 *   - 기본은 기존 노트 맨 아래에 이어 붙인다. --replace는 노트 전체를 교체한다.
 *
 * 노트 외의 교육·할 일 데이터는 건드리지 않는다.
 * 열려 있는 웹앱 탭은 창에 다시 포커스될 때 새 노트를 자동으로 불러온다.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');
const ENV_PATH = path.join(ROOT, '.env');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const [OWNER, TARGET, CONTENT_PATH] = args;
const REPLACE = process.argv.includes('--replace');
const DRY_RUN = process.argv.includes('--dry-run');

if (!OWNER || !TARGET || !CONTENT_PATH) {
  console.error('usage: node scripts/page-add.js <담당자명> <기업명|카드id> <content.md> [--replace] [--dry-run]');
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
    'User-Agent': 'node-page-add/1.0',
  }, extra);
}

async function sbGet(env, select) {
  const url = `${env.SUPABASE_URL}/rest/v1/user_states?owner=eq.${encodeURIComponent(OWNER)}&select=${select}`;
  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) throw new Error(`Supabase GET 실패 ${res.status}: ${await res.text()}`);
  return res.json();
}

function findCompany(companies) {
  if (/^\d+$/.test(TARGET)) {
    const co = companies.find(c => String(c.id) === TARGET);
    if (!co) throw new Error(`카드 id ${TARGET}를 찾지 못함`);
    return co;
  }
  let hits = companies.filter(c => c.name === TARGET);
  if (!hits.length) throw new Error(`칸반보드에 '${TARGET}' 카드가 없음`);
  if (hits.length > 1) {
    const active = hits.filter(c => !c.archived);
    if (active.length) hits = active;
  }
  if (hits.length > 1) {
    const list = hits.map(c => `  - id ${c.id}: ${c.trainingName || '(교육명 없음)'}${c.archived ? ' [완료]' : ''}`).join('\n');
    throw new Error(`'${TARGET}' 카드가 여러 개 — 카드 id로 다시 실행:\n${list}`);
  }
  return hits[0];
}

async function main() {
  const env = loadEnv();
  const content = fs.readFileSync(CONTENT_PATH, 'utf8').replace(/\s+$/, '');
  if (!content) throw new Error('추가할 내용이 비어 있음');

  const rows = await sbGet(env, 'data,updated_at');
  if (!rows.length || !rows[0].data) throw new Error(`Supabase에 '${OWNER}' 담당자 데이터가 없음 — 웹앱에서 한 번 접속한 뒤 다시 실행`);
  const state = rows[0].data;
  const baselineUpdatedAt = rows[0].updated_at;
  const co = findCompany(Array.isArray(state.companies) ? state.companies : []);

  const before = (co.page || '').replace(/\s+$/, '');
  co.page = REPLACE || !before ? content : `${before}\n\n${content}`;
  co.pageUpdated = new Date().toISOString();
  const label = `${co.name} (id ${co.id}${co.trainingName ? ` · ${co.trainingName}` : ''})`;

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
  const savedCo = (saved[0]?.data?.companies || []).find(c => c.id === co.id);
  if (!savedCo || savedCo.page !== co.page) throw new Error('POST 반영 불일치: 저장된 노트가 기대값과 다름');
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log(report('Supabase 저장 완료'));

  function report(tail) {
    return [
      `=== 교육 노트 ${REPLACE ? '교체' : '추가'} — ${OWNER} ===`,
      `카드: ${label}`,
      `노트 길이: ${before.length}자 → ${co.page.length}자`,
      '--- 추가된 내용 ---',
      content,
      '---',
      tail,
    ].join('\n');
  }
}

main().catch(err => { console.error('ERROR: ' + err.message); process.exit(1); });
