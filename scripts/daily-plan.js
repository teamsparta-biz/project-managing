#!/usr/bin/env node
/**
 * daily-plan.js — 칸반보드(Supabase) 상태로 "오늘의 업무 정리" 초안을 만든다.
 *
 * 사용법:
 *   node scripts/daily-plan.js [담당자명] [--date YYYY-MM-DD] [--local]
 *     - 담당자 기본값: 송찬호
 *     - --date: 기준 날짜(기본: 오늘, KST)
 *     - --local: Supabase 대신 data/state.json 사용(테스트용)
 *
 * 출력: Slack에 그대로 보낼 수 있는 마크다운(표 없음). 모델이 캘린더 일정·이유를 다듬어 보낸다.
 * 읽기 전용 — 칸반보드 데이터는 수정하지 않는다.
 *
 * 포함 규칙
 *   - Goal & KPI: .claude/skills/daily-plan/config.json
 *   - 금주 집중 프로젝트: 이번 주(월~일)에 교육일이 있거나 7일 안에 시작하는 교육
 *     (config.json의 excludeFocus에 적은 문구가 교육명에 들어 있으면 뺀다)
 *   - 오늘 할 일: 할 날(plannedFor)이 오늘이거나 지난 미완료 할 일 (칸반 '오늘 할 일' 패널과 같은 목록, 이월 표시)
 *     지정된 일이 하나도 없을 때만 아래 규칙으로 자동으로 모은다 (기업별로 묶음)
 *       · 내 할 일: 미완료 + 마감이 지났거나 오늘~3일 안 (마감 없는 항목은 맨 아래 별도)
 *       · 체크리스트 "before" 항목: 14일 안에 시작하는데 미완료
 *       · 체크리스트 "after" 항목: 종료 후 30일 안인데 미완료 (보관된 교육 포함)
 *       · 교육 노트의 "- [ ]" 항목
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');
const CONFIG_PATH = path.join(ROOT, '.claude', 'skills', 'daily-plan', 'config.json');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const OWNER = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--date') || '송찬호';
const LOCAL = args.includes('--local');

const DAY = 86400000;
const WD = ['일', '월', '화', '수', '목', '금', '토'];

function todayKST() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}
const TODAY = flag('--date') || todayKST();
const toDate = (ymd) => new Date(ymd + 'T00:00:00Z');
const ymd = (d) => d.toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((toDate(a) - toDate(b)) / DAY); // a - b
const md = (s) => { const d = toDate(s); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`; };

const t = toDate(TODAY);
const dow = (t.getUTCDay() + 6) % 7; // 월=0
const WEEK_START = ymd(new Date(t - dow * DAY));
const WEEK_END = ymd(new Date(t.getTime() + (6 - dow) * DAY));

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) throw new Error('.env에 SUPABASE_URL / SUPABASE_KEY 없음');
  return env;
}

async function loadState() {
  if (LOCAL) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const env = loadEnv();
  const url = `${env.SUPABASE_URL}/rest/v1/user_states?owner=eq.${encodeURIComponent(OWNER)}&select=data`;
  const res = await fetch(url, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, 'User-Agent': 'node-daily-plan/1.0' },
  });
  if (!res.ok) throw new Error(`Supabase GET 실패 ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  if (!rows.length || !rows[0].data) throw new Error(`Supabase에 '${OWNER}' 담당자 데이터가 없음`);
  return rows[0].data;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

const cleanName = (n) => String(n || '').replace(/\(주\)|주식회사|유한회사|㈜/g, '').trim();

function courseLabel(c) {
  const name = cleanName(c.name);
  const tn = String(c.trainingName || '').replace(/^\[[^\]]*\]\s*/, '').trim();
  if (!tn) return name;
  return tn.startsWith(name) ? tn : `${name} ${tn}`;
}

function sessionDates(c) {
  const out = [];
  for (const s of c.sessions || []) for (const d of s.dates || []) out.push(d);
  return [...new Set(out)].sort();
}

function main(state) {
  const cfg = loadConfig();
  const tasks = state.tasks || [];
  const companies = state.companies || [];
  const byId = new Map(companies.map((c) => [c.id, c]));

  // ---------- 금주 집중 프로젝트 ----------
  const focus = [];
  for (const c of companies) {
    if (c.archived) continue;
    const dates = sessionDates(c);
    const thisWeek = dates.filter((d) => d >= WEEK_START && d <= WEEK_END);
    const start = (c.startAt || '').slice(0, 10);
    const startsSoon = start && diffDays(start, TODAY) > 0 && diffDays(start, TODAY) <= 7;
    if (!thisWeek.length && !startsSoon) continue;
    if ((cfg.excludeFocus || []).some((x) => x && courseLabel(c).includes(x))) continue;
    const reasons = [];
    if (thisWeek.length) reasons.push(`이번 주 교육 ${thisWeek.map(md).join(', ')}`);
    else reasons.push(`${md(start)} 교육 시작`);
    if (start && start > TODAY && diffDays(start, TODAY) <= 14) {
      const open = tasks.filter((tk) => tk.section === 'before' && (c.status || {})[tk.id] !== 2).map((tk) => tk.label);
      if (open.length) reasons.push(`준비 미완료: ${open.join(', ')}`);
    }
    focus.push({ label: courseLabel(c), first: thisWeek[0] || start, reasons });
  }
  focus.sort((a, b) => a.first.localeCompare(b.first));

  // ---------- 오늘 할 일 (기업별) ----------
  const groups = new Map(); // key -> {label, items:[{text, sort}]}
  const add = (key, label, text, sort = 5) => {
    if (!groups.has(key)) groups.set(key, { label, items: [], minSort: 99 });
    const g = groups.get(key);
    if (g.items.some((i) => i.text === text)) return;
    g.items.push({ text, sort });
    g.minSort = Math.min(g.minSort, sort);
  };
  const companyKey = (c) => `c:${c.id}`;

  // 1) 내 할 일
  const noDue = [];
  for (const td of state.todos || []) {
    if (td.done || td.deletedAt) continue;
    let title = String(td.title || '').replace(/^기타\s+/, '').trim();
    let tag = '';
    if (td.due) {
      const d = diffDays(td.due, TODAY);
      if (d > 3) continue;
      tag = d < 0 ? ` (마감 ${md(td.due)} · ${-d}일 지남)` : d === 0 ? ' (오늘 마감)' : ` (D-${d})`;
    }
    const sort = !td.due ? 9 : Math.max(0, diffDays(td.due, TODAY) + 3);
    const c = td.companyId != null ? byId.get(td.companyId) : null;
    let key, label;
    if (c) { key = companyKey(c); label = courseLabel(c); }
    else {
      let comp = cleanName(td.company);
      if (!comp) {
        const words = title.split(/\s+/);
        if (words.length >= 3) { comp = words[0]; title = words.slice(1).join(' '); }
      }
      comp = comp || '기타';
      key = `n:${comp}`; label = comp;
    }
    if (!td.due) { noDue.push({ label, title }); continue; }
    add(key, label, title + tag, sort);
  }

  // 2) 체크리스트 + 3) 교육 노트
  for (const c of companies) {
    const start = (c.startAt || '').slice(0, 10);
    const end = (c.endAt || '').slice(0, 10);
    const st = c.status || {};
    const fmt = (list) => list.map((x) => x.label + (st[x.id] === 1 ? '(진행 중)' : '')).join(', ');
    if (!c.archived && start && start > TODAY && diffDays(start, TODAY) <= 14) {
      const open = tasks.filter((x) => x.section === 'before' && st[x.id] !== 2);
      if (open.length) add(companyKey(c), courseLabel(c), `준비 미완료: ${fmt(open)} · 교육 ${md(start)}`, diffDays(start, TODAY) <= 3 ? 2 : 4);
    }
    if (end && end < TODAY && diffDays(TODAY, end) <= 30) {
      const open = tasks.filter((x) => x.section === 'after' && st[x.id] !== 2);
      if (open.length) add(companyKey(c), courseLabel(c), `종료 후 미완료: ${fmt(open)} · ${md(end)} 종료`, 6);
    }
    if (!c.archived && c.page) {
      for (const m of String(c.page).matchAll(/^\s*[-*]\s+\[ \]\s+(.+)$/gm)) add(companyKey(c), courseLabel(c), m[1].trim(), 5);
    }
  }

  // ---------- 출력 ----------
  const L = [];
  L.push(`*${md(TODAY)} 오늘의 업무*`, '');
  L.push('*Goal & KPI*');
  L.push(`팀/파트 목표: ${cfg.teamGoal || '(config.json에 teamGoal 입력)'}`);
  L.push(`내 목표: ${cfg.myGoal || '(config.json에 myGoal 입력)'}`, '');
  L.push('*금주에 집중하는 프로젝트들과 그 이유*');
  if (!focus.length) L.push('- 이번 주 진행 교육 없음');
  for (const f of focus) L.push(`- ${f.label}`, `  - ${f.reasons.join(' / ')}`);
  L.push('', '*오늘 할 일*');
  // 할 날(plannedFor)이 지정된 일이 있으면 그것만 쓴다 (칸반보드 '오늘 할 일' 패널과 같은 목록)
  const planned = (state.todos || []).filter((td) => td && !td.done && !td.deletedAt && td.plannedFor && td.plannedFor <= TODAY);
  if (planned.length) {
    const pg = new Map();
    const label = (td) => cleanName(td.company) || '기타';
    planned
      .sort((a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || String(a.time || '').localeCompare(String(b.time || '')) || a.plannedFor.localeCompare(b.plannedFor) || (a.createdAt || '').localeCompare(b.createdAt || ''))
      .forEach((td) => {
        const k = label(td);
        if (!pg.has(k)) pg.set(k, []);
        const carry = diffDays(TODAY, td.plannedFor);
        pg.get(k).push(`${td.time ? td.time + ' ' : ''}${td.title}${carry > 0 ? ` (이월 ${carry}일)` : ''}`);
      });
    const keys = [...pg.keys()].sort((a, b) => (['공통', '기타'].includes(a) ? 1 : 0) - (['공통', '기타'].includes(b) ? 1 : 0));
    for (const k of keys) { L.push(`- ${k}`); for (const x of pg.get(k)) L.push(`  - ${x}`); }
    return L.join('\n');
  }
  const sorted = [...groups.values()].sort((a, b) => a.minSort - b.minSort || a.label.localeCompare(b.label, 'ko'));
  if (!sorted.length) L.push('- 급한 할 일 없음');
  for (const g of sorted) {
    L.push(`- ${g.label}`);
    for (const it of g.items.sort((a, b) => a.sort - b.sort)) L.push(`  - ${it.text}`);
  }
  if (noDue.length) {
    L.push('', '*마감 없는 할 일*');
    for (const n of noDue) L.push(`- ${n.label}: ${n.title}`);
  }
  return L.join('\n');
}

loadState()
  .then((s) => console.log(main(s)))
  .catch((e) => { console.error('오류:', e.message); process.exit(1); });
