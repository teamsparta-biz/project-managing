const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// index.html 안의 교육 노트 순수 함수만 떼어내 실행한다.
function load() {
  const re = html.match(/\nconst PAGE_TASK_RE = [^\n]*\n/);
  assert.ok(re, 'PAGE_TASK_RE를 index.html에서 찾지 못했습니다');
  const src = [re[0], ...['togglePageTaskLine', 'pagePeekText'].map(name => {
    const m = html.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
    assert.ok(m, `${name}() 함수를 index.html에서 찾지 못했습니다`);
    return m[0];
  })].join('\n') + '\nthis.togglePageTaskLine = togglePageTaskLine; this.pagePeekText = pagePeekText;';
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

const { togglePageTaskLine, pagePeekText } = load();

test('n번째 체크박스 줄만 토글한다', () => {
  const src = '## 리뷰\n- [ ] 첫째\n- 일반 항목\n  - [x] 둘째\n1. [ ] 셋째';
  assert.equal(togglePageTaskLine(src, 0), '## 리뷰\n- [x] 첫째\n- 일반 항목\n  - [x] 둘째\n1. [ ] 셋째');
  assert.equal(togglePageTaskLine(src, 1), '## 리뷰\n- [ ] 첫째\n- 일반 항목\n  - [ ] 둘째\n1. [ ] 셋째');
  assert.equal(togglePageTaskLine(src, 2), '## 리뷰\n- [ ] 첫째\n- 일반 항목\n  - [x] 둘째\n1. [x] 셋째');
});

test('코드블록 안의 체크박스 모양은 세지 않는다', () => {
  const src = '```\n- [ ] 코드\n```\n- [ ] 진짜';
  assert.equal(togglePageTaskLine(src, 0), '```\n- [ ] 코드\n```\n- [x] 진짜');
});

test('범위를 벗어난 index는 원문 그대로', () => {
  assert.equal(togglePageTaskLine('- [ ] a', 3), '- [ ] a');
});

test('미리보기 한 줄은 제목·목록 기호를 뗀 첫 줄', () => {
  assert.equal(pagePeekText({ page: '\n## 황대환 강사 교육리뷰\n- 실습 자료 순서변경' }), '황대환 강사 교육리뷰');
  assert.equal(pagePeekText({ page: '- [ ] 교안 확인' }), '교안 확인');
  assert.equal(pagePeekText({}), '');
});
