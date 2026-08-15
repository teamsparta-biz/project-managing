#!/usr/bin/env node
/**
 * sync-ax-hub.js — ax-hub 조회 결과(payload)를 웹앱 state.json에 병합하고 Supabase에 반영한다.
 *
 * 사용법:
 *   node scripts/sync-ax-hub.js <담당자명> <payload파일경로> [--dry-run]
 *
 * payload 파일 형식 (줄 단위, `|` 구분 — /sync-ax-hub 스킬의 단일 SQL이 생성):
 *   C|<course_id(full uuid)>|<기업명>|<교육명>|<status>|<장소>|<교안URL>|<담당자명>|<직책>|<이메일>
 *   S|<course_id 앞8자리>|<YYYY-MM-DD>|<start_time>|<end_time>|<강사,강사>|<튜터,튜터>
 *   A|<course_id 앞8자리>        ← 담당자 소유이지만 보관 대상(tax_invoice/closed/stopped)
 *
 * 절대 규칙: 사용자가 칸반보드에 입력한 업무 내용(status·memo·deadline·notes 계열)은
 * 어떤 경우에도 수정·초기화·삭제하지 않는다. 항목 삭제도 하지 않는다.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');
const ENV_PATH = path.join(ROOT, '.env');

const [OWNER, PAYLOAD_PATH] = process.argv.slice(2);
const DRY_RUN = process.argv.includes('--dry-run');

if (!OWNER || !PAYLOAD_PATH) {
  console.error('usage: node scripts/sync-ax-hub.js <담당자명> <payload파일경로> [--dry-run]');
  process.exit(1);
}

// ── ax-hub course.status → 칸반보드 표시값 ────────────────────────────────
const STATUS_MAP = { setup: '세팅중', operation: '교육중' };

// 사실 정보(ax-hub 기준으로 덮어쓰는 필드)
const FACT_FIELDS = ['name', 'trainingName', 'instructorName', 'tutorName',
  'sessions', 'startAt', 'endAt', 'workbookUrl', 'trainingStatus', 'archived'];
// 빈 값일 때만 채우는 필드 (사용자가 웹앱에서 직접 입력한 값을 덮어쓰지 않음)
const FILL_IF_EMPTY = ['location', 'contactName', 'contactPosition', 'contactEmail'];

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) throw new Error('.env에 SUPABASE_URL / SUPABASE_KEY 없음');
  return env;
}

function hhmm(raw) {
  if (raw === '' || raw == null) return '';
  const n = Number(raw);
  if (!isFinite(n)) return '';
  if (n >= 100) return String(Math.floor(n / 100)).padStart(2, '0') + ':' + String(n % 100).padStart(2, '0');
  return String(Math.floor(n)).padStart(2, '0') + ':' + String(Math.round((n % 1) * 60)).padStart(2, '0');
}

// 키 순서에 무관한 정규 직렬화.
// Supabase(jsonb) 왕복 시 객체 키 순서가 바뀌므로, 단순 JSON.stringify 비교는
// 내용이 같아도 매번 "변경됨"으로 잡힌다.
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

function parsePayload(text) {
  const courses = new Map();   // full course_id → meta
  const sessions = new Map();  // prefix8 → rows[]
  const archivedOwned = new Set(); // prefix8
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split('|');
    if (f[0] === 'C') {
      courses.set(f[1], {
        client: f[2] || '', training: f[3] || '', status: f[4] || '',
        location: f[5] || '', workbook: f[6] || '',
        contactName: f[7] || '', contactPosition: f[8] || '', contactEmail: f[9] || '',
      });
    } else if (f[0] === 'S') {
      const key = f[1];
      if (!sessions.has(key)) sessions.set(key, []);
      sessions.get(key).push({ date: f[2], st: f[3], et: f[4], ins: f[5] || '', tut: f[6] || '' });
    } else if (f[0] === 'A') {
      archivedOwned.add(f[1]);
    } else {
      throw new Error(`payload 형식 오류 (알 수 없는 줄): ${line.slice(0, 60)}`);
    }
  }
  if (courses.size === 0) throw new Error('payload에 C(교육) 줄이 없음 — 조회 결과를 확인하세요');
  for (const rows of sessions.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
  return { courses, sessions, archivedOwned };
}

async function sbGet(env, select) {
  const url = `${env.SUPABASE_URL}/rest/v1/user_states?owner=eq.${encodeURIComponent(OWNER)}&select=${select}`;
  const res = await fetch(url, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, 'User-Agent': 'node-sync-ax-hub/1.0' },
  });
  if (!res.ok) throw new Error(`Supabase GET 실패 ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const env = loadEnv();
  const payload = parsePayload(fs.readFileSync(PAYLOAD_PATH, 'utf8'));

  // ── 4단계: 병합 기준은 항상 Supabase 현재 상태 ──────────────────────────
  const rows = await sbGet(env, 'data,updated_at');
  let state, baselineUpdatedAt = null;
  if (rows.length && rows[0].data) {
    state = rows[0].data;
    baselineUpdatedAt = rows[0].updated_at;
    if (fs.existsSync(STATE_PATH)) fs.copyFileSync(STATE_PATH, STATE_PATH + '.bak');
    console.log(`base: Supabase (companies ${state.companies.length}건, updated_at ${baselineUpdatedAt})`);
  } else {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    console.log(`base: 로컬 state.json (Supabase에 데이터 없음, companies ${state.companies.length}건)`);
  }
  if (!Array.isArray(state.companies)) throw new Error('state.companies 배열이 없음 — 병합 중단');

  // ── 5단계: 병합 ─────────────────────────────────────────────────────────
  const taskKeys = (state.tasks || []).map(t => (t && t.id !== undefined ? t.id : t));
  const byCourseId = new Map();
  for (const co of state.companies) if (co.ax_hub_course_id) byCourseId.set(co.ax_hub_course_id, co);
  let maxId = state.companies.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);

  const added = [], updated = [], unchanged = [], archivedFixed = [], suspect = [];

  for (const [cid, meta] of payload.courses) {
    const rowsFor = payload.sessions.get(cid.slice(0, 8)) || [];
    const uniq = (arr) => [...new Set(arr)];
    const allIns = uniq(rowsFor.flatMap(r => r.ins ? r.ins.split(',') : []));
    const allTut = uniq(rowsFor.flatMap(r => r.tut ? r.tut.split(',') : []));

    let co = byCourseId.get(cid);
    const isNew = !co;
    if (isNew) {
      co = { id: ++maxId, ax_hub_course_id: cid, memo: '', deadline: '', status: {} };
      for (const k of taskKeys) co.status[k] = 0;
    }

    const before = {};
    for (const f of FACT_FIELDS) before[f] = canon(co[f]);

    co.sessions = rowsFor.length
      ? rowsFor.map((r, i) => ({
          id: `session_${co.id}_${i + 1}`,
          dates: [r.date],
          startTime: hhmm(r.st),
          endTime: hhmm(r.et),
          instructorName: r.ins.split(',').filter(Boolean).join(', '),
          tutorName: r.tut.split(',').filter(Boolean).join(', '),
        }))
      : [{ id: `session_${co.id}_1`, dates: [], startTime: '', endTime: '', instructorName: '', tutorName: '' }];
    co.name = meta.client;
    co.trainingName = meta.training;
    co.instructorName = allIns.join(', ');
    co.tutorName = allTut.join(', ');
    co.startAt = rowsFor.length ? `${rowsFor[0].date}T${hhmm(rowsFor[0].st)}` : '';
    co.endAt = rowsFor.length ? `${rowsFor.at(-1).date}T${hhmm(rowsFor.at(-1).et)}` : '';
    co.workbookUrl = meta.workbook;
    co.trainingStatus = STATUS_MAP[meta.status] || co.trainingStatus || '';
    co.archived = false;
    for (const f of FILL_IF_EMPTY) if (!co[f]) co[f] = meta[f] || '';

    const label = `${meta.client} | ${meta.training}`;
    if (isNew) {
      state.companies.push(co);
      added.push(`${label} | ${co.instructorName || '강사 미배정'}`);
      continue;
    }
    const diffs = FACT_FIELDS.filter(f => before[f] !== canon(co[f]));
    if (diffs.length) updated.push(`${label} → ${diffs.join(', ')}`);
    else unchanged.push(label);
  }

  // 보관 대상(tax_invoice/closed/stopped): archived만 true로, 나머지는 손대지 않음
  // 담당자 외 교육: 삭제하지 않고 보고만
  for (const co of state.companies) {
    if (!co.ax_hub_course_id) continue; // 수동 추가 항목 — 어떤 필드도 건드리지 않음
    const p8 = co.ax_hub_course_id.slice(0, 8);
    if (payload.archivedOwned.has(p8)) {
      if (co.archived !== true) { co.archived = true; archivedFixed.push(`${co.name} | ${co.trainingName}`); }
      continue;
    }
    if (!payload.courses.has(co.ax_hub_course_id)) suspect.push(`${co.name} | ${co.trainingName}`);
  }

  // ── 6단계: 동시편집 확인 → 저장 → POST ──────────────────────────────────
  // 동시편집 확인을 파일 저장보다 먼저 한다. 순서가 반대면 POST를 중단한 뒤에도
  // 로컬 state.json에 stale 병합본이 남는다.
  let postResult;
  if (DRY_RUN) {
    postResult = 'DRY-RUN — 파일 저장·POST 모두 생략';
  } else {
    if (baselineUpdatedAt) {
      const now = await sbGet(env, 'updated_at');
      if (now.length && now[0].updated_at !== baselineUpdatedAt) {
        console.log(summary());
        console.log(`⚠️ 동시편집 감지 (기준 ${baselineUpdatedAt} → 현재 ${now[0].updated_at}) — 저장·POST 모두 중단. 다시 실행하면 최신 상태 위에 재병합됩니다.`);
        process.exit(2);
      }
    }
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    const body = JSON.stringify({ owner: OWNER, data: state, updated_at: new Date().toISOString() });
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/user_states?on_conflict=owner`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_KEY,
        Authorization: `Bearer ${env.SUPABASE_KEY}`,
        'Content-Type': 'application/json; charset=utf-8',
        // return=representation 필수: 실제 저장된 데이터를 응답받아 반영 여부를 검증한다.
        Prefer: 'resolution=merge-duplicates,return=representation',
        'User-Agent': 'node-sync-ax-hub/1.0',
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase POST 실패 ${res.status}: ${text}`);
    const saved = JSON.parse(text);
    const n = saved[0]?.data?.companies?.length;
    if (n !== state.companies.length) throw new Error(`POST 반영 불일치: 기대 ${state.companies.length}건, 응답 ${n}건`);
    postResult = `Supabase POST 성공 — companies ${n}건 반영 확인`;
  }

  function summary() {
    const sec = (title, arr) => `${title}: ${arr.length}건` + (arr.length ? '\n' + arr.map(x => '  - ' + x).join('\n') : '');
    return [
      '',
      `=== ax-hub 동기화 결과 — ${OWNER} 담당${DRY_RUN ? ' (DRY-RUN)' : ''} ===`,
      sec('신규 추가', added),
      sec('정보 갱신', updated),
      `변경 없음: ${unchanged.length}건`,
      sec('보관 처리(archived=true)', archivedFixed),
      sec('확인 필요(다른 담당자로 보임 — 삭제하지 않음)', suspect),
      `총 companies: ${state.companies.length}건`,
    ].join('\n');
  }

  console.log(summary());
  console.log(postResult);
}

main().catch(err => { console.error('ERROR: ' + err.message); process.exit(1); });
