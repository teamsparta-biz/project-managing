const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// index.html 안의 자동 아카이브 관련 함수만 떼어내 실행한다.
function loadAutoArchive(companies, now) {
  const src = ['todayKey', 'lastTrainingDate', 'autoArchivePastTrainings']
    .map(name => {
      const m = html.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
      assert.ok(m, `${name}() 함수를 index.html에서 찾지 못했습니다`);
      return m[0];
    })
    .join('\n');
  const ctx = { state: { companies }, Date: class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
  } };
  vm.createContext(ctx);
  vm.runInContext(src + '\nvar __result = autoArchivePastTrainings();', ctx);
  return { changed: ctx.__result, companies: ctx.state.companies };
}

const NOW = '2026-09-21T10:00:00';
const mk = (over) => Object.assign({ id: 1, archived: false, sessions: [] }, over);

test('교육 마지막 일자가 지나면 교육 완료로 이동한다', () => {
  const { changed, companies } = loadAutoArchive([
    mk({ id: 1, sessions: [{ dates: ['2026-09-18', '2026-09-19'] }] })
  ], NOW);
  assert.equal(changed, true);
  assert.equal(companies[0].archived, true);
});

test('오늘 진행 중이거나 예정된 교육은 그대로 둔다', () => {
  const { companies } = loadAutoArchive([
    mk({ id: 1, sessions: [{ dates: ['2026-09-19', '2026-09-21'] }] }),
    mk({ id: 2, sessions: [{ dates: ['2026-09-25'] }] }),
    mk({ id: 3, sessions: [{ dates: [] }] })
  ], NOW);
  assert.deepEqual(companies.map(c => c.archived), [false, false, false]);
});

test('구형 단일 date 필드도 인식한다', () => {
  const { companies } = loadAutoArchive([
    mk({ sessions: [{ date: '2026-09-20' }] })
  ], NOW);
  assert.equal(companies[0].archived, true);
});

test('수동 복원한 프로젝트는 다시 자동 아카이브하지 않는다', () => {
  const { companies } = loadAutoArchive([
    mk({ sessions: [{ dates: ['2026-09-10'] }], autoArchiveExempt: true })
  ], NOW);
  assert.equal(companies[0].archived, false);
});

test('일정이 다시 미래로 바뀌면 복원 예외가 해제된다', () => {
  const { companies } = loadAutoArchive([
    mk({ sessions: [{ dates: ['2026-10-01'] }], autoArchiveExempt: true })
  ], NOW);
  assert.equal(companies[0].autoArchiveExempt, undefined);
  assert.equal(companies[0].archived, false);
});
