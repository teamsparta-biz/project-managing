const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'k';

// Supabase 대역: 현재 서버 버전(updated_at)이 DB 값과 같을 때만 PATCH가 행을 돌려준다
let dbVersion = '2026-10-13T01:10:18.444+00:00';
const calls = [];
https.request = (opts, cb) => {
  const req = new EventEmitter();
  let body = '';
  req.write = c => { body += c; };
  req.end = () => {
    calls.push({ method: opts.method, path: opts.path });
    let out = null;
    if (opts.method === 'GET') out = [{ data: { tasks: [], companies: [] }, updated_at: dbVersion }];
    if (opts.method === 'PATCH') {
      const base = decodeURIComponent(opts.path.match(/updated_at=eq\.([^&]+)/)[1]);
      out = Date.parse(base) === Date.parse(dbVersion) ? [{ owner: 'x' }] : [];
      if (out.length) dbVersion = JSON.parse(body).updated_at;
    }
    const r = new EventEmitter();
    r.statusCode = 200;
    cb(r);
    if (out) r.emit('data', Buffer.from(JSON.stringify(out)));
    r.emit('end');
  };
  return req;
};
const handler = require('./api/state.js');

function call(method, query, body) {
  return new Promise(resolve => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, body: b, headers: this.headers }); }, end() { resolve({ code: this.code, headers: this.headers }); } };
    handler({ method, query, body }, res);
  });
}

test('GET은 현재 버전을 X-State-Version 헤더로 알려준다', async () => {
  const r = await call('GET', { owner: '송찬호' });
  assert.equal(r.headers['X-State-Version'], '2026-10-13T01:10:18.444+00:00');
});

test('같은 버전(표기가 달라도)으로 저장하면 성공하고 새 버전을 돌려준다', async () => {
  const r = await call('POST', { owner: '송찬호', base: '2026-10-13T01:10:18.444Z' }, { companies: [] });
  assert.equal(r.code, 200);
  assert.ok(r.body.version);
});

test('서버가 그 사이 바뀌었다면(오래된 base) 409로 거절한다', async () => {
  const before = dbVersion;
  const r = await call('POST', { owner: '송찬호', base: '2026-10-13T01:00:00.000Z' }, { companies: [] });
  assert.equal(r.code, 409);
  assert.equal(dbVersion, before, '거절된 저장은 DB를 바꾸지 않는다');
});
