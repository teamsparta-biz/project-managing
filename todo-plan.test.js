const test = require('node:test');
const assert = require('node:assert/strict');
const { sameTask, applyPlan } = require('./scripts/todo-plan.js');

const D = '2026-11-05';
const base = () => ({
  companies: [
    { id: 1, name: '한화에어로스페이스', archived: false },
    { id: 2, name: '(주)넥슨코리아', archived: false },
    { id: 3, name: '디케이메디칼솔루션(주)', archived: false },
  ],
  todos: [
    { id: 't1', title: '운영매니저 온보딩', company: '한화에어로스페이스', companyId: 1, due: '2026-11-04', plannedFor: '2026-11-04', done: false },
    { id: 't2', title: '1회차 세금계산서 발행', company: '디케이메디칼솔루션(주)', companyId: 3, due: '2026-11-04', done: false },
    { id: 't3', title: '한국투자리얼에셋 윤리실천서약서 송부', company: '', companyId: null, done: false },
    { id: 't4', title: '노트북 대여', company: '한화에어로스페이스', companyId: 1, done: true },
  ],
});

test('제목 비교: 같거나 한쪽이 다른 쪽을 포함하면 같은 일', () => {
  assert.ok(sameTask('세금계산서 발행', '1회차 세금계산서 발행'));
  assert.ok(sameTask('와이파이 도시락 대여', '와이파이도시락 대여'));
  assert.ok(!sameTask('대여', '노트북 대여')); // 너무 짧은 말은 포함으로 보지 않는다
  assert.ok(!sameTask('노트북 대여', '와이파이도시락 대여'));
});

test('같은 기업의 기존 할 일은 할 날만 바꾸고, 없으면 새로 만든다', () => {
  const s = base();
  const { planned, created } = applyPlan(s, [
    { title: '운영매니저 온보딩', company: '한화에어로스페이스' },
    { title: '세금계산서 발행', company: '디케이메디칼솔루션' },          // (주) 없는 이름도 맞춘다
    { title: '윤리실천서약서 송부', company: '한국투자리얼에셋' },          // 기업명이 제목에 붙은 예전 항목
    { title: '노트북 대여', company: '한화에어로스페이스' },               // 완료한 일은 다시 쓰지 않는다
    { title: 'Stage1 작업내용 정리', company: '넥슨코리아', time: '10:00' },
  ], D, '2026-11-05T00:00:00Z');
  assert.deepEqual(planned.map(t => t.id), ['t1', 't2', 't3']);
  assert.ok(planned.every(t => t.plannedFor === D));
  assert.equal(created.length, 2);
  const nexon = created.find(t => t.title.startsWith('Stage1'));
  assert.equal(nexon.company, '(주)넥슨코리아');
  assert.equal(nexon.companyId, 2);
  assert.equal(nexon.time, '10:00');
  assert.equal(s.todos.find(t => t.id === 't4').plannedFor, undefined);
});

test('다른 기업의 비슷한 제목과는 합치지 않는다', () => {
  const s = base();
  const { planned, created } = applyPlan(s, [{ title: '운영매니저 온보딩', company: '기아' }], D);
  assert.equal(planned.length, 0);
  assert.equal(created.length, 1);
});
