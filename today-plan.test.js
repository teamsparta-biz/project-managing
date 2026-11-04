const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// index.html 안의 오늘 할 일 묶음 함수만 떼어내 실행한다.
function load() {
  const src = ['todoYmd', 'todoDisplayCompany', 'todayPlan', 'todayCarryDays'].map(name => {
    const m = html.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
    assert.ok(m, `${name}() 함수를 index.html에서 찾지 못했습니다`);
    return m[0];
  }).join('\n') + "\nconst TODO_GENERAL_TAGS = ['공통', '기타'];\nthis.todayPlan = todayPlan; this.todayCarryDays = todayCarryDays;";
  const ctx = { Date, isNaN, String };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

const { todayPlan, todayCarryDays } = load();
const plain = v => JSON.parse(JSON.stringify(v));
const T = '2026-11-05';

test('할 날이 오늘이거나 지난 미완료 할 일만 오늘 할 일에 들어간다', () => {
  const todos = [
    { id: 'a', title: '오늘', company: '삼성생명', plannedFor: T },
    { id: 'b', title: '어제 못 함', company: '삼성생명', plannedFor: '2026-11-04' },
    { id: 'c', title: '내일', company: '삼성생명', plannedFor: '2026-11-06' },
    { id: 'd', title: '할 날 없음', company: '삼성생명', due: T },
    { id: 'e', title: '완료', company: '삼성생명', plannedFor: T, done: true },
    { id: 'f', title: '삭제', company: '삼성생명', plannedFor: T, deletedAt: '2026-11-05T01:00:00Z' },
  ];
  assert.deepEqual(plain(todayPlan(todos, T).open.map(t => t.id)).sort(), ['a', 'b']);
});

test('기업별로 묶고, 이월된 일이 있는 기업이 먼저, 공통·기타는 맨 뒤', () => {
  const todos = [
    { id: '1', title: '인건비 정리', company: '공통', plannedFor: T },
    { id: '2', title: '견적서 논의', company: '삼성생명', plannedFor: T },
    { id: '3', title: 'drop 방향 논의', company: '(주)넥슨코리아', plannedFor: '2026-11-04' },
    { id: '4', title: '전자서명 확인', company: '(주)넥슨코리아', plannedFor: T },
  ];
  const { groups } = plain(todayPlan(todos, T));
  assert.deepEqual(groups.map(g => [g.label, g.items.map(t => t.id)]), [
    ['넥슨코리아', ['3', '4']],
    ['삼성생명', ['2']],
    ['공통', ['1']],
  ]);
});

test('시간이 있는 일은 따로 시간순으로 모은다', () => {
  const todos = [
    { id: 'x', title: '미팅', company: '기아', plannedFor: T, time: '14:00' },
    { id: 'y', title: '운영매니저 수행', company: '기아', plannedFor: T, time: '06:00-16:00' },
    { id: 'z', title: '정리', company: '기아', plannedFor: T },
  ];
  const r = plain(todayPlan(todos, T));
  assert.deepEqual(r.timed.map(t => t.id), ['y', 'x']);
  assert.deepEqual(r.groups.map(g => g.items.map(t => t.id)), [['z']]);
});

test('오늘 완료한 일(할 날이 있던 것)만 오늘 완료에 모은다', () => {
  const local = (h) => new Date(2026, 10, 5, h, 0).toISOString();
  const todos = [
    { id: 'a', title: 'A', plannedFor: T, done: true, doneAt: local(10) },
    { id: 'b', title: 'B', plannedFor: T, done: true, doneAt: new Date(2026, 10, 4, 10, 0).toISOString() },
    { id: 'c', title: 'C', done: true, doneAt: local(11) },
  ];
  assert.deepEqual(plain(todayPlan(todos, T).doneToday.map(t => t.id)), ['a']);
});

test('이월 일수', () => {
  assert.equal(todayCarryDays({ plannedFor: '2026-11-03' }, T), 2);
  assert.equal(todayCarryDays({ plannedFor: T }, T), 0);
});
