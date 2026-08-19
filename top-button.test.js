const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('provides an accessible fixed scroll-to-top button', () => {
  assert.match(
    html,
    /<button\s+id="scroll-to-top"[^>]*aria-label="맨 위로 이동"[^>]*>/,
    'an accessible scroll-to-top button should be rendered'
  );
  assert.match(html, /\.scroll-to-top\s*\{[^}]*position:\s*fixed;/s);
  assert.match(html, /function scrollToTop\(\)/);
  assert.match(html, /scrollTo\(\{\s*top:\s*0/s);
});
