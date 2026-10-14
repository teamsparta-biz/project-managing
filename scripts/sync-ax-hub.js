#!/usr/bin/env node
/**
 * sync-ax-hub.js — ax-hub 조회 결과(payload)를 웹앱 state.json에 병합하고 Supabase에 반영한다.
 *
 * 사용법:
 *   node scripts/sync-ax-hub.js <담당자명> <payload파일경로> [--dry-run]
 *   node scripts/sync-ax-hub.js <담당자명> <payload파일경로> --verify   ← 병합 없이 Supabase와 ax-hub 대조만
 *
 * payload 파일 형식 (줄 단위, `|` 구분 — /sync-ax-hub 스킬의 단일 SQL이 생성):
 *   C|<course_id(full uuid)>|<기업명>|<교육명>|<status>|<장소>|<교안URL>|<담당자명>|<직책>|<이메일>|<초대이메일1,초대이메일2,...>
 *   S|<course_id 앞8자리>|<round_number>|<YYYY-MM-DD>|<start_time>|<end_time>|<강사,강사>|<튜터,튜터>|<강사이름:이메일,...>|<튜터이름:이메일,...>
 *   A|<course_id 앞8자리>        ← 담당자 소유이지만 보관 대상(tax_invoice/closed) — archived=true
 *   X|<course_id 앞8자리>        ← 담당자 소유이지만 중단(stopped) — 로컬에 있으면 완전히 삭제
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
const VERIFY_ONLY = process.argv.includes('--verify');

if (!OWNER || !PAYLOAD_PATH) {
  console.error('usage: node scripts/sync-ax-hub.js <담당자명> <payload파일경로> [--dry-run|--verify]');
  process.exit(1);
}

// ── ax-hub course.status → 칸반보드 표시값 ────────────────────────────────
const STATUS_MAP = { setup: '세팅중', operation: '교육중' };

// 사실 정보(ax-hub 기준으로 덮어쓰는 필드)
const FACT_FIELDS = ['name', 'trainingName', 'instructorName', 'tutorName',
  'sessions', 'startAt', 'endAt', 'workbookUrl', 'trainingStatus', 'archived', 'inviteEmails'];
// ax-hub 값이 있으면 그 값으로 덮어쓰는 필드 (ax-hub 기준). ax-hub 값이 비어 있을 때만 칸반 값을 유지한다.
const OVERWRITE_IF_PRESENT = ['location', 'contactName', 'contactPosition', 'contactEmail'];

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) throw new Error('.env에 SUPABASE_URL / SUPABASE_KEY 없음');
  return env;
}

// "이름:이메일,이름:이메일" → 이메일만 추출 (이메일 없는 사람은 제외)
function pairEmails(str) {
  return (str || '').split(',').filter(Boolean).map(tok => {
    const i = tok.indexOf(':');
    return i === -1 ? '' : tok.slice(i + 1).trim();
  }).filter(Boolean);
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
  const archivedOwned = new Set(); // prefix8 — tax_invoice/closed
  const stoppedOwned = new Set();  // prefix8 — stopped (완전 삭제 대상)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split('|');
    if (f[0] === 'C') {
      courses.set(f[1], {
        client: f[2] || '', training: f[3] || '', status: f[4] || '',
        location: f[5] || '', workbook: f[6] || '',
        contactName: f[7] || '', contactPosition: f[8] || '', contactEmail: f[9] || '',
        inviteEmails: [...new Set((f[10] || '').split(',').filter(Boolean))],
      });
    } else if (f[0] === 'S') {
      const key = f[1];
      if (!sessions.has(key)) sessions.set(key, []);
      sessions.get(key).push({
        round: f[2] || '', date: f[3], st: f[4], et: f[5], ins: f[6] || '', tut: f[7] || '',
        insPairs: f[8] || '', tutPairs: f[9] || '',
      });
    } else if (f[0] === 'A') {
      archivedOwned.add(f[1]);
    } else if (f[0] === 'X') {
      stoppedOwned.add(f[1]);
    } else {
      throw new Error(`payload 형식 오류 (알 수 없는 줄): ${line.slice(0, 60)}`);
    }
  }
  if (courses.size === 0) throw new Error('payload에 C(교육) 줄이 없음 — 조회 결과를 확인하세요');
  for (const rows of sessions.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
  return { courses, sessions, archivedOwned, stoppedOwned };
}

async function sbGet(env, select) {
  const url = `${env.SUPABASE_URL}/rest/v1/user_states?owner=eq.${encodeURIComponent(OWNER)}&select=${select}`;
  const res = await fetch(url, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, 'User-Agent': 'node-sync-ax-hub/1.0' },
  });
  if (!res.ok) throw new Error(`Supabase GET 실패 ${res.status}: ${await res.text()}`);
  return res.json();
}

// ax-hub 기준(payload)과 Supabase 현재 상태를 새로 조회해 대조한다.
// 누락(ax-hub엔 진행 중인데 칸반에 없음)·중단 잔존·상태/일정 불일치를 찾아 보고한다. 문제가 있으면 false.
async function verifyAgainstSupabase(env, payload) {
  const rows = await sbGet(env, 'data,updated_at');
  if (!rows.length || !rows[0].data) { console.log('❌ 검증 실패 — Supabase에 데이터가 없음'); return false; }
  const cs = rows[0].data.companies || [];
  const byId = new Map(cs.filter(c => c.ax_hub_course_id).map(c => [c.ax_hub_course_id, c]));
  const problems = [];
  for (const [cid, meta] of payload.courses) {
    const co = byId.get(cid);
    const label = `${meta.client} | ${meta.training}`;
    if (!co) { problems.push(`누락: ${label}`); continue; }
    if (co.archived) problems.push(`보관 상태로 표시됨(진행 중이어야 함): ${label}`);
    // ax-hub 기준 값과 칸반 값을 필드별로 대조한다 (일정 일수만이 아니라 날짜·시간·인원까지)
    const wantRows = payload.sessions.get(cid.slice(0, 8)) || [];
    const haveByDate = new Map((co.sessions || []).filter(x => (x.dates || [])[0]).map(x => [x.dates[0], x]));
    const diffs = [];
    if (haveByDate.size !== wantRows.length) diffs.push(`일정 일수(칸반 ${haveByDate.size} / ax-hub ${wantRows.length})`);
    const names = v => [...new Set((v || '').split(',').map(x => x.trim()).filter(Boolean))].sort().join(',');
    for (const r of wantRows) {
      const have = haveByDate.get(r.date);
      if (!have) { diffs.push(`${r.date} 일정 없음`); continue; }
      if (have.startTime !== hhmm(r.st) || have.endTime !== hhmm(r.et)) diffs.push(`${r.date} 시간(칸반 ${have.startTime}~${have.endTime} / ax-hub ${hhmm(r.st)}~${hhmm(r.et)})`);
      if (names(have.instructorName) !== names(r.ins)) diffs.push(`${r.date} 강사(칸반 ${have.instructorName || '-'} / ax-hub ${r.ins || '-'})`);
      if (names(have.tutorName) !== names(r.tut)) diffs.push(`${r.date} 튜터(칸반 ${have.tutorName || '-'} / ax-hub ${r.tut || '-'})`);
    }
    if (co.name !== meta.client) diffs.push('기업명');
    if (co.trainingName !== meta.training) diffs.push('교육명');
    if ((co.workbookUrl || '') !== meta.workbook) diffs.push('교안 링크');
    for (const f of OVERWRITE_IF_PRESENT) if (meta[f] && co[f] !== meta[f]) diffs.push(`${f}(칸반 ${co[f] || '-'} / ax-hub ${meta[f]})`);
    if (diffs.length) problems.push(`불일치 — ${label}\n      ${diffs.join('\n      ')}`);
  }
  for (const cid of payload.stoppedOwned) {
    const left = cs.find(c => c.ax_hub_course_id && c.ax_hub_course_id.startsWith(cid));
    if (left) problems.push(`중단된 교육이 남아 있음: ${left.name} | ${left.trainingName}`);
  }
  console.log(`\n=== 검증 (Supabase 재조회, updated_at ${rows[0].updated_at}) ===`);
  console.log(`ax-hub 진행 대상 ${payload.courses.size}건 / 칸반 반영 ${[...payload.courses.keys()].filter(k => byId.has(k)).length}건 (칸반 전체 ${cs.length}건)`);
  if (problems.length) { console.log('❌ 문제 ' + problems.length + '건\n' + problems.map(x => '  - ' + x).join('\n')); return false; }
  console.log('✅ 빠진 교육 없음');
  return true;
}

async function main() {
  const env = loadEnv();
  const payload = parsePayload(fs.readFileSync(PAYLOAD_PATH, 'utf8'));
  if (VERIFY_ONLY) { process.exit((await verifyAgainstSupabase(env, payload)) ? 0 : 3); }

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

  const added = [], updated = [], unchanged = [], archivedFixed = [], removedStopped = [], suspect = [];

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
    for (const f of [...FACT_FIELDS, ...OVERWRITE_IF_PRESENT]) before[f] = canon(co[f]);

    co.sessions = rowsFor.length
      ? rowsFor.map((r, i) => ({
          id: `session_${co.id}_${i + 1}`,
          round: r.round || '',
          dates: [r.date],
          startTime: hhmm(r.st),
          endTime: hhmm(r.et),
          instructorName: r.ins.split(',').filter(Boolean).join(', '),
          tutorName: r.tut.split(',').filter(Boolean).join(', '),
          instructorEmails: pairEmails(r.insPairs),
          tutorEmails: pairEmails(r.tutPairs),
        }))
      : [{ id: `session_${co.id}_1`, round: '', dates: [], startTime: '', endTime: '', instructorName: '', tutorName: '', instructorEmails: [], tutorEmails: [] }];
    co.name = meta.client;
    co.trainingName = meta.training;
    co.instructorName = allIns.join(', ');
    co.tutorName = allTut.join(', ');
    co.startAt = rowsFor.length ? `${rowsFor[0].date}T${hhmm(rowsFor[0].st)}` : '';
    co.endAt = rowsFor.length ? `${rowsFor.at(-1).date}T${hhmm(rowsFor.at(-1).et)}` : '';
    co.workbookUrl = meta.workbook;
    co.inviteEmails = meta.inviteEmails;
    co.trainingStatus = STATUS_MAP[meta.status] || co.trainingStatus || '';
    co.archived = false;
    for (const f of OVERWRITE_IF_PRESENT) if (meta[f]) co[f] = meta[f];

    const label = `${meta.client} | ${meta.training}`;
    if (isNew) {
      state.companies.push(co);
      added.push(`${label} | ${co.instructorName || '강사 미배정'}`);
      continue;
    }
    const diffs = [...FACT_FIELDS, ...OVERWRITE_IF_PRESENT].filter(f => before[f] !== canon(co[f]));
    if (diffs.length) updated.push(`${label} → ${diffs.join(', ')}`);
    else unchanged.push(label);
  }

  // 중단(stopped) 교육: 로컬에 있으면 완전히 삭제 (act에는 원래부터 없으므로 신규 생성도 안 됨)
  if (payload.stoppedOwned.size) {
    for (const co of state.companies) {
      if (!co.ax_hub_course_id) continue;
      if (payload.stoppedOwned.has(co.ax_hub_course_id.slice(0, 8))) {
        removedStopped.push(`${co.name} | ${co.trainingName}`);
      }
    }
    if (removedStopped.length) {
      state.companies = state.companies.filter(co =>
        !co.ax_hub_course_id || !payload.stoppedOwned.has(co.ax_hub_course_id.slice(0, 8)));
    }
  }

  // 보관 대상(tax_invoice/closed): archived만 true로, 나머지는 손대지 않음
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
      sec('중단(stopped)으로 삭제', removedStopped),
      sec('확인 필요(다른 담당자로 보임 — 삭제하지 않음)', suspect),
      `총 companies: ${state.companies.length}건`,
    ].join('\n');
  }

  console.log(summary());
  console.log(postResult);
  if (!DRY_RUN) {
    // 반영 직후 새로 조회해 대조. 이후 열려 있던 옛 화면이 덮어쓰는 경우는 --verify로 잠시 뒤 다시 확인한다.
    if (!(await verifyAgainstSupabase(env, payload))) process.exit(3);
  }
}

main().catch(err => { console.error('ERROR: ' + err.message); process.exit(1); });
