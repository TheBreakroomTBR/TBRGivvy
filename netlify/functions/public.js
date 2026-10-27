// Public, read-only API for the customer view page (view.html).
// No access key needed. Exposes only giveaway names, usernames + entry counts, and prize names/winners.
// Never writes to Airtable. Responses are cached briefly so a live stream full of viewers
// doesn't hit Airtable's rate limit (5 requests/sec per base).
const BASE = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;
const TTL_MS = 15000;
const memo = new Map();

async function at(table, query = '') {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}${query}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) { const e = new Error('Not found'); e.status = 404; throw e; }
  if (!res.ok) throw new Error(`Airtable ${table} ${res.status}`);
  return data;
}
async function listAll(table, formula) {
  let out = [], offset;
  do {
    const p = new URLSearchParams({ pageSize: '100' });
    if (formula) p.set('filterByFormula', formula);
    if (offset) p.set('offset', offset);
    const d = await at(table, '?' + p.toString());
    out = out.concat(d.records || []);
    offset = d.offset;
  } while (offset);
  return out;
}
const lit = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

async function cached(key, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;
  const v = await fn();
  memo.set(key, { t: Date.now(), v });
  return v;
}

async function listGiveaways() {
  const recs = await listAll('Giveaways');
  return {
    giveaways: recs
      .map(r => ({ id: r.id, name: r.fields.Name || 'Untitled', created: r.createdTime }))
      .sort((a, b) => (a.created < b.created ? 1 : -1)),
  };
}

async function loadGiveaway(id) {
  const g = await at('Giveaways', '/' + id);
  const f = `{GiveawayId}=${lit(id)}`;
  const [eRecs, pRecs] = await Promise.all([listAll('Entries', f), listAll('Prizes', f)]);
  const entries = eRecs
    .map(r => ({ u: r.fields.Username || '', c: Math.max(1, Math.floor(Number(r.fields.Count) || 1)) }))
    .filter(e => e.u)
    .sort((a, b) => b.c - a.c || a.u.localeCompare(b.u));
  const prizes = pRecs.map(r => ({
    name: r.fields.Name || 'Prize',
    status: r.fields.Status || 'Available',
    winner: r.fields.Status && r.fields.Status !== 'Available' ? (r.fields.Winner || '') : '',
    wonAt: r.fields.WonAt || '',
  }));
  return { giveaway: { id: g.id, name: g.fields.Name || 'Untitled' }, entries, prizes, updated: new Date().toISOString() };
}

const reply = (statusCode, body, cache) => ({
  statusCode,
  headers: Object.assign(
    { 'Content-Type': 'application/json' },
    cache
      ? { 'Cache-Control': 'public, max-age=10', 'Netlify-CDN-Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' }
      : { 'Cache-Control': 'no-store' }
  ),
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return reply(405, { error: 'Use GET' });
  if (!BASE || !TOKEN) return reply(500, { error: 'Site is not configured yet' });
  const q = event.queryStringParameters || {};
  try {
    if (q.g) {
      if (!/^rec[A-Za-z0-9]{14}$/.test(q.g)) return reply(400, { error: 'Bad giveaway link' });
      return reply(200, await cached('g:' + q.g, () => loadGiveaway(q.g)), true);
    }
    return reply(200, await cached('list', listGiveaways), true);
  } catch (e) {
    if (e.status === 404) return reply(404, { error: 'That giveaway doesn’t exist anymore' });
    console.error(e);
    return reply(502, { error: 'Couldn’t load giveaways right now. Try again in a moment.' });
  }
};
