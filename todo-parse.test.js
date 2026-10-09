const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// index.html 안의 할 일 파싱 함수만 떼어내 실행한다.
function loadParser() {
  const week = html.match(/\nconst TODO_WEEKDAYS = [^\n]*\n/);
  assert.ok(week, 'TODO_WEEKDAYS를 index.html에서 찾지 못했습니다');
  const tags = html.match(/\nconst TODO_GENERAL_TAGS = [^\n]*\n/);
  assert.ok(tags, 'TODO_GENERAL_TAGS를 index.html에서 찾지 못했습니다');
  const src = [week[0], tags[0], ...['todoYmd', 'parseTodoInput'].map(name => {
    const m = html.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
    assert.ok(m, `${name}() 함수를 index.html에서 찾지 못했습니다`);
    return m[0];
  })].join('\n') + '\nthis.parseTodoInput = parseTodoInput;';
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.parseTodoInput;
}

const parse = loadParser();
const COMPANIES = ['삼성전자', '삼성', 'SK하이닉스'];
const TODAY = '2026-09-29'; // 화요일
const p = (text) => JSON.parse(JSON.stringify(parse(text, COMPANIES, TODAY)));

test('기업명·할 일·"M월 D일까지"를 분리한다', () => {
  assert.deepEqual(p('삼성전자 TSP 일정확인 10월 1일까지'), { title: 'TSP 일정확인', company: '삼성전자', due: '2026-10-01' });
});

test('가장 긴 기업명을 우선 매칭한다', () => {
  assert.equal(p('삼성전자 교안 확인').company, '삼성전자');
});

test('M/D, YYYY-MM-DD, 오늘·내일 표현을 인식한다', () => {
  assert.equal(p('SK하이닉스 견적서 10/2').due, '2026-10-02');
  assert.equal(p('보고서 제출 2026-11-03 마감').due, '2026-11-03');
  assert.equal(p('보고서 제출 2026-11-03 마감').title, '보고서 제출');
  assert.equal(p('강사 섭외 내일까지').due, '2026-09-30');
  assert.equal(p('강사 섭외 오늘').due, '2026-09-29');
});

test('요일은 이번 주 기준, "다음주"는 다음 주 월~일 기준이다', () => {
  assert.equal(p('회의록 금요일까지').due, '2026-10-02');
  assert.equal(p('회의록 다음주 화요일까지').due, '2026-10-06');
  assert.equal(p('회의록 다음주 월요일').due, '2026-10-05');
});

test('연도 없는 지난 날짜는 내년으로 본다', () => {
  assert.equal(p('계약서 1월 5일까지').due, '2027-01-05');
  assert.equal(p('정산 9월 20일').due, '2026-09-20');
});

test('마감이 없으면 due는 빈 값이다', () => {
  assert.deepEqual(p('주간회의 자료 준비'), { title: '주간회의 자료 준비', company: '', due: '' });
});

test('기업 업무가 아니면 공통·기타를 태그로 인식한다', () => {
  assert.deepEqual(p('공통 주간회의 자료 준비 금요일까지'), { title: '주간회의 자료 준비', company: '공통', due: '2026-10-02' });
  assert.deepEqual(p('[기타] 노트북 반납'), { title: '노트북 반납', company: '기타', due: '' });
  assert.deepEqual(p('법인카드 정산 #공통'), { title: '법인카드 정산', company: '공통', due: '' });
});

test('공통·기타는 단독 단어일 때만 태그로 본다', () => {
  assert.deepEqual(p('기타리스트 섭외'), { title: '기타리스트 섭외', company: '', due: '' });
  assert.equal(p('공통교안 정리').company, '');
});

test('기업명이 있으면 기업명을 우선한다', () => {
  assert.deepEqual(p('삼성전자 기타 비용 정리'), { title: '기타 비용 정리', company: '삼성전자', due: '' });
});
