const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// index.html 안의 완료 탭 분류 함수만 떼어내 실행한다.
function loadCompletedTab(tasks, companies) {
  const src = ['isFullyDone', 'companiesForTab']
    .map(name => {
      const m = html.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
      assert.ok(m, `${name}() 함수를 index.html에서 찾지 못했습니다`);
      return m[0];
    })
    .join('\n');
  const ctx = { state: { tasks, companies } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

const TASKS = [
  { id: 'before_1', label: '담당자 인계 이메일 송부', section: 'before' },
  { id: 'tax', label: '세금계산서 발행', section: 'after' },
  { id: 'survey', label: '만족도조사 확인', section: 'after' }
];

const mk = (over) => Object.assign({ id: 1, archived: true, status: {} }, over);

test('칸반보드 전 업무(세금계산서 발행, 만족도조사 확인 포함)를 다 채우면 완료 탭으로 분류된다', () => {
  const ctx = loadCompletedTab(TASKS, [
    mk({ id: 1, status: { before_1: 2, tax: 2, survey: 2 } })
  ]);
  assert.equal(ctx.isFullyDone(ctx.state.companies[0]), true);
  assert.deepEqual(ctx.companiesForTab('completed').map(c => c.id), [1]);
  assert.deepEqual(ctx.companiesForTab('archived').map(c => c.id), []);
});

test('세금계산서 발행이나 만족도조사 확인이 남아있으면 교육 완료 탭에 그대로 남는다', () => {
  const ctx = loadCompletedTab(TASKS, [
    mk({ id: 1, status: { before_1: 2, tax: 2, survey: 1 } }),
    mk({ id: 2, status: { before_1: 2, tax: 0, survey: 2 } })
  ]);
  assert.deepEqual(ctx.companiesForTab('archived').map(c => c.id), [1, 2]);
  assert.deepEqual(ctx.companiesForTab('completed').map(c => c.id), []);
});

test('진행 중(미보관) 프로젝트는 업무를 다 채워도 완료 탭이 아니라 진행 중 탭에 남는다', () => {
  const ctx = loadCompletedTab(TASKS, [
    mk({ id: 1, archived: false, status: { before_1: 2, tax: 2, survey: 2 } })
  ]);
  assert.deepEqual(ctx.companiesForTab('active').map(c => c.id), [1]);
  assert.deepEqual(ctx.companiesForTab('completed').map(c => c.id), []);
});

test('overview 탭은 보관 여부와 무관하게 전체 프로젝트를 보여준다', () => {
  const ctx = loadCompletedTab(TASKS, [
    mk({ id: 1, archived: false }),
    mk({ id: 2, archived: true, status: { before_1: 2, tax: 2, survey: 2 } })
  ]);
  assert.deepEqual(ctx.companiesForTab('overview').map(c => c.id), [1, 2]);
});
