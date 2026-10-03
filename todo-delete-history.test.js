const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// index.html 안의 할 일 묶음 함수만 떼어내 실행한다.
function load() {
  const src = ['todoYmd', 'todoDiff', 'todoGroups'].map(name => {
    const m = html.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
    assert.ok(m, `${name}() 함수를 index.html에서 찾지 못했습니다`);
    return m[0];
  }).join('\n') + '\nthis.todoGroups = todoGroups;';
  const ctx = { Date, Math, todayKey: () => '2026-10-03' };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

const { todoGroups } = load();

test('삭제한 할 일은 남은 일·완료한 일에서 빠지고 삭제 목록에 최근 순으로 모인다', () => {
  const r = JSON.parse(JSON.stringify(todoGroups([
    { id: 'a', title: 'A', due: '2026-10-05', done: false },
    { id: 'b', title: 'B', due: '', done: true, doneAt: '2026-10-02T01:00:00.000Z' },
    { id: 'c', title: 'C', due: '', done: false, deletedAt: '2026-10-01T01:00:00.000Z' },
    { id: 'd', title: 'D', due: '', done: true, doneAt: '2026-10-01T00:00:00.000Z', deletedAt: '2026-10-02T09:00:00.000Z' },
  ])));
  assert.deepEqual(r.open.map(t => t.id), ['a']);
  assert.deepEqual(r.done.map(t => t.id), ['b']);
  assert.deepEqual(r.deleted.map(t => t.id), ['d', 'c']);
});
