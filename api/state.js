const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function sb(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const hostname = new URL(SUPABASE_URL).hostname;
    const headers = {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };
    if (method === 'POST') headers['Prefer'] = 'resolution=merge-duplicates,return=minimal';
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request({ hostname, path, method, headers }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const d = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
        try { resolve({ status: r.statusCode, body: d ? JSON.parse(d) : null }); }
        catch (e) { resolve({ status: r.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const owner = req.query.owner;
  if (!owner) { res.status(400).json({ error: 'owner required' }); return; }

  const enc = encodeURIComponent(owner);

  if (req.method === 'GET') {
    const r = await sb('GET', `/rest/v1/user_states?owner=eq.${enc}&select=data`);
    if (r.status >= 400) { res.status(500).json({ error: 'DB error' }); return; }
    const rows = Array.isArray(r.body) ? r.body : [];
    res.status(200).json(rows.length > 0 ? rows[0].data : null);
    return;
  }

  if (req.method === 'POST') {
    const r = await sb('POST', '/rest/v1/user_states', {
      owner,
      data: req.body,
      updated_at: new Date().toISOString()
    });
    if (r.status >= 400) { res.status(500).json({ error: 'DB error' }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const r = await sb('DELETE', `/rest/v1/user_states?owner=eq.${enc}`);
    if (r.status >= 400) { res.status(500).json({ error: 'DB error' }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).end();
};
