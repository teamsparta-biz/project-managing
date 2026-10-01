const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// index.html 안의 완료 이력 묶음 함수만 떼어내 실행한다.
function load() {
  const src = ['todoYmd', 'todoDoneByDate', 'todoDoneTime'].map(name => {
    const m = html.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
    assert.ok(m, `${name}() 함수를 index.html에서 찾지 못했습니다`);
    return m[0];
  }).join('\n') + '\nthis.todoDoneByDate = todoDoneByDate; this.todoDoneTime = todoDoneTime;';
  const ctx = { Date, isNaN, String };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

const { todoDoneByDate, todoDoneTime } = load();
// 로컬 시각 기준 ISO 문자열
const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi).toISOString();

test('완료한 일을 처리한 날짜별로 묶고 순서를 유지한다', () => {
  const done = [
    { id: 'a', doneAt: at(2026, 10, 1, 15, 30) },
    { id: 'b', doneAt: at(2026, 10, 1, 9, 5) },
    { id: 'c', doneAt: at(2026, 9, 29, 18, 0) },
  ];
  const days = JSON.parse(JSON.stringify(todoDoneByDate(done)));
  assert.deepEqual(days.map(d => [d.date, d.items.map(t => t.id)]), [
    ['2026-10-01', ['a', 'b']],
    ['2026-09-29', ['c']],
  ]);
});

test('doneAt이 없는 예전 항목은 맨 뒤 완료일 미상으로 모은다', () => {
  const days = todoDoneByDate([{ id: 'x', doneAt: null }, { id: 'a', doneAt: at(2026, 10, 1, 10, 0) }]);
  assert.equal(days.length, 2);
  assert.equal(days[0].date, '2026-10-01');
  assert.equal(days[1].date, '');
  assert.equal(days[1].items[0].id, 'x');
});

test('완료 시각은 HH:MM으로 표시하고 값이 없으면 빈 문자열이다', () => {
  assert.equal(todoDoneTime(at(2026, 10, 1, 9, 5)), '09:05');
  assert.equal(todoDoneTime(null), '');
});
