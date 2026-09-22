const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// index.html 안의 패들렛 회차 그룹핑 함수만 떼어내 실행한다.
function loadPadletHelpers() {
  const src = ['padletRoundGroups', 'fmtYYMMDD']
    .map(name => {
      const m = html.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
      assert.ok(m, `${name}() 함수를 index.html에서 찾지 못했습니다`);
      return m[0];
    })
    .join('\n');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

// vm 컨텍스트에서 만들어진 Map/Set/Array는 이 realm의 Array와 realm이 달라
// assert.deepEqual이 구조가 같아도 실패한다 — JSON 왕복으로 이 realm의 순수
// 구조체로 바꿔서 비교한다.
function plain(v) {
  const isSet = (val) => val != null && Object.prototype.toString.call(val) === '[object Set]';
  return JSON.parse(JSON.stringify(v, (_, val) => (isSet(val) ? [...val] : val)));
}

test('회차 번호(round)로 묶어 회차별 날짜 범위와 이메일을 만든다', () => {
  const { padletRoundGroups, fmtYYMMDD } = loadPadletHelpers();
  const c = {
    sessions: [
      { round: '1', dates: ['2026-09-21'], instructorEmails: ['a@x.com'], tutorEmails: ['b@x.com'] },
      { round: '1', dates: ['2026-09-22'], instructorEmails: ['a@x.com'], tutorEmails: ['b@x.com'] },
      { round: '2', dates: ['2026-09-28'], instructorEmails: ['c@x.com'], tutorEmails: [] },
    ],
  };
  const groups = plain(padletRoundGroups(c));
  assert.deepEqual(groups.map(([round]) => round), ['1', '2']);
  assert.deepEqual(groups[0][1].dates.slice().sort(), ['2026-09-21', '2026-09-22']);
  assert.deepEqual(groups[0][1].emails, ['a@x.com', 'b@x.com']);
  assert.equal(fmtYYMMDD('2026-09-21'), '26.09.21');
});

test('이메일이나 날짜가 없는 회차는 그룹에서 제외된다', () => {
  const { padletRoundGroups } = loadPadletHelpers();
  const c = {
    sessions: [
      { round: '1', dates: ['2026-09-21'], instructorEmails: [], tutorEmails: [] },
      { round: '2', dates: [], instructorEmails: ['a@x.com'], tutorEmails: [] },
    ],
  };
  assert.deepEqual(plain(padletRoundGroups(c)), []);
});

test('round 정보가 없는 옛 데이터는 하나의 그룹으로 합쳐진다', () => {
  const { padletRoundGroups } = loadPadletHelpers();
  const c = {
    sessions: [
      { dates: ['2026-09-21'], instructorEmails: ['a@x.com'], tutorEmails: [] },
      { dates: ['2026-09-22'], instructorEmails: ['b@x.com'], tutorEmails: [] },
    ],
  };
  const groups = plain(padletRoundGroups(c));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0][1].emails.sort(), ['a@x.com', 'b@x.com']);
});
