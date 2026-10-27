// Giveaway Runner API: proxies Airtable so the token never reaches the browser.
// Env vars (Netlify > Site configuration > Environment variables):
//   AIRTABLE_TOKEN    personal access token (data.records:read + data.records:write on the base)
//   AIRTABLE_BASE_ID  appXXXXXXXXXXXXXX
//   ADMIN_KEY         passphrase (12+ characters). Each device enters it once and gets its own signed
//                     device token; the key itself is never stored on devices. Changing ADMIN_KEY
//                     signs out every device.
const crypto = require('crypto');

const BASE = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY;
const T = { g: 'Giveaways', e: 'Entries', p: 'Prizes' };

// ---------- Airtable helpers ----------
async function at(table, { method = 'GET', query = '', body } = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}${query}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error;
    const msg = typeof e === 'string' ? e : (e && (e.message || e.type)) || res.statusText;
    throw new Error(`Airtable (${table}): ${msg}`);
  }
  return data;
}
const chunk = (a, n = 10) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function listAll(table, formula) {
  let out = [], offset;
  do {
    const p = new URLSearchParams({ pageSize: '100' });
    if (formula) p.set('filterByFormula', formula);
    if (offset) p.set('offset', offset);
    const d = await at(table, { query: '?' + p.toString() });
    out = out.concat(d.records || []);
    offset = d.offset;
  } while (offset);
  return out;
}
async function create(table, list) {
  let out = [];
  for (const c of chunk(list)) {
    const d = await at(table, { method: 'POST', body: { records: c.map(fields => ({ fields })), typecast: true } });
    out = out.concat(d.records);
  }
  return out;
}
async function update(table, list) {
  let out = [];
  for (const c of chunk(list)) {
    const d = await at(table, { method: 'PATCH', body: { records: c, typecast: true } });
    out = out.concat(d.records);
  }
  return out;
}
async function destroy(table, ids) {
  for (const c of chunk(ids)) {
    const q = '?' + c.map(id => 'records[]=' + encodeURIComponent(id)).join('&');
    await at(table, { method: 'DELETE', query: q });
  }
}
// Safe Airtable formula string literal (usernames/SKUs never get spliced in raw)
const lit = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const byGiveaway = id => `{GiveawayId}=${lit(id)}`;
const recId = id => { if (!/^rec[A-Za-z0-9]{14}$/.test(String(id || ''))) throw new Error('Bad record id'); return id; };

// ---------- Mappers ----------
const mapG = r => ({ id: r.id, name: r.fields.Name || 'Untitled', created: r.createdTime });
const mapE = r => ({ id: r.id, u: r.fields.Username || '', c: Math.max(1, Math.floor(Number(r.fields.Count) || 1)) });
const mapP = r => ({
  id: r.id,
  name: r.fields.Name || '',
  sku: r.fields.SKU || '',
  giveawayId: r.fields.GiveawayId || '',
  status: r.fields.Status || 'Available',
  winner: r.fields.Winner || '',
  winnerEntries: Number(r.fields.WinnerEntries) || 0,
  wonAt: r.fields.WonAt || '',
});
const cleanName = u => String(u || '').trim().replace(/^@+/, '').trim().slice(0, 100);
const cleanCount = c => { const n = Math.floor(Number(c)); return n >= 1 ? Math.min(n, 100000) : 1; };
const newSku = () => 'PRZ-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 7);

async function entriesFor(gid) { return (await listAll(T.e, byGiveaway(gid))).map(mapE); }
async function prizesFor(gid) { return (await listAll(T.p, byGiveaway(gid))).map(mapP); }

// ---------- Operations ----------
const ops = {
  async listGiveaways() {
    const g = (await listAll(T.g)).map(mapG).sort((a, b) => (a.created < b.created ? 1 : -1));
    return { giveaways: g };
  },
  async createGiveaway({ name }) {
    name = String(name || '').trim().slice(0, 200);
    if (!name) throw new Error('Giveaway needs a name');
    const [r] = await create(T.g, [{ Name: name }]);
    return { giveaway: mapG(r) };
  },
  async deleteGiveaway({ id }) {
    recId(id);
    const entries = await listAll(T.e, byGiveaway(id));
    await destroy(T.e, entries.map(r => r.id));
    // Prizes are physical items: keep them (still scannable), just unassign.
    const prizes = await listAll(T.p, byGiveaway(id));
    await update(T.p, prizes.map(r => ({ id: r.id, fields: { GiveawayId: '' } })));
    await destroy(T.g, [id]);
    return { ok: true };
  },
  async loadGiveaway({ id }) {
    recId(id);
    const [entries, prizes] = await Promise.all([entriesFor(id), prizesFor(id)]);
    return { entries, prizes };
  },
  async addEntries({ giveawayId, items }) {
    recId(giveawayId);
    if (!Array.isArray(items) || !items.length) throw new Error('No entries to add');
    const existing = await listAll(T.e, byGiveaway(giveawayId));
    const map = new Map(existing.map(r => [String(r.fields.Username || '').toLowerCase(), mapE(r)]));
    const toCreate = new Map(), toUpdate = new Map(), results = [];
    for (const it of items) {
      const u = cleanName(it.u); if (!u) continue;
      const c = cleanCount(it.c), key = u.toLowerCase();
      if (map.has(key)) {
        const e = map.get(key); e.c += c; toUpdate.set(e.id, e);
        results.push({ u: e.u, c: e.c, added: c, existing: true });
      } else if (toCreate.has(key)) {
        const e = toCreate.get(key); e.c += c;
        results.push({ u: e.u, c: e.c, added: c, existing: true });
      } else {
        toCreate.set(key, { u, c });
        results.push({ u, c, added: c, existing: false });
      }
    }
    if (toUpdate.size) await update(T.e, [...toUpdate.values()].map(e => ({ id: e.id, fields: { Count: e.c } })));
    if (toCreate.size) await create(T.e, [...toCreate.values()].map(e => ({ Username: e.u, Count: e.c, GiveawayId: giveawayId })));
    return { results, entries: await entriesFor(giveawayId) };
  },
  async setCount({ id, c }) {
    const [r] = await update(T.e, [{ id: recId(id), fields: { Count: cleanCount(c) } }]);
    return { entry: mapE(r) };
  },
  async deleteEntry({ id }) { await destroy(T.e, [recId(id)]); return { ok: true }; },
  async clearEntries({ giveawayId }) {
    const recs = await listAll(T.e, byGiveaway(recId(giveawayId)));
    await destroy(T.e, recs.map(r => r.id));
    return { ok: true };
  },
  async createPrize({ giveawayId, name, sku }) {
    recId(giveawayId);
    name = String(name || '').trim().slice(0, 200);
    if (!name) throw new Error('Prize needs a name');
    sku = String(sku || '').trim().slice(0, 80);
    if (sku) {
      const dup = await listAll(T.p, `{SKU}=${lit(sku)}`);
      if (dup.length) throw new Error(`Barcode ${sku} is already on “${dup[0].fields.Name || 'another prize'}”`);
    } else {
      do { sku = newSku(); } while ((await listAll(T.p, `{SKU}=${lit(sku)}`)).length);
    }
    const [r] = await create(T.p, [{ Name: name, SKU: sku, GiveawayId: giveawayId, Status: 'Available' }]);
    return { prize: mapP(r) };
  },
  async setPrizeStatus({ id, status }) {
    const allowed = ['Available', 'Won', 'Shipped'];
    if (!allowed.includes(status)) throw new Error('Bad status');
    const fields = { Status: status };
    if (status === 'Available') Object.assign(fields, { Winner: '', WinnerEntries: null, WonAt: '' });
    const [r] = await update(T.p, [{ id: recId(id), fields }]);
    return { prize: mapP(r) };
  },
  async deletePrize({ id }) { await destroy(T.p, [recId(id)]); return { ok: true }; },
  async findPrize({ sku }) {
    sku = String(sku || '').trim();
    if (!sku) throw new Error('Scan or type a barcode');
    const recs = await listAll(T.p, `{SKU}=${lit(sku)}`);
    if (!recs.length) return { prize: null };
    const prize = mapP(recs[0]);
    let giveawayName = '';
    if (prize.giveawayId) {
      try { giveawayName = mapG(await at(T.g, { query: '/' + recId(prize.giveawayId) })).name; } catch (e) {}
    }
    return { prize, giveawayName };
  },
  // Server-side draw: uses the live Airtable entries and crypto randomness, then records the win.
  async draw({ giveawayId, prizeId, removeWinner }) {
    recId(giveawayId); recId(prizeId);
    const prizeRec = await at(T.p, { query: '/' + prizeId });
    const prize = mapP(prizeRec);
    if (prize.giveawayId !== giveawayId) throw new Error('That prize is not in this giveaway');
    if (prize.status !== 'Available') throw new Error(`“${prize.name}” already has a winner`);
    const entries = await entriesFor(giveawayId);
    const total = entries.reduce((s, e) => s + e.c, 0);
    if (!total) throw new Error('No entries to draw from');
    let r = crypto.randomInt(total), winner = entries[entries.length - 1];
    for (const e of entries) { if (r < e.c) { winner = e; break; } r -= e.c; }
    const [upd] = await update(T.p, [{ id: prizeId, fields: {
      Status: 'Won', Winner: winner.u, WinnerEntries: winner.c, WonAt: new Date().toISOString(),
    } }]);
    if (removeWinner) await destroy(T.e, [winner.id]);
    return {
      winner: { u: winner.u, c: winner.c },
      totalEntries: total,
      prize: mapP(upd),
      entries: removeWinner ? entries.filter(e => e.id !== winner.id) : entries,
    };
  },
};

// ---------- Device tokens ----------
const TOKEN_DAYS = 365;
const b64 = buf => Buffer.from(buf).toString('base64url');
const sign = payload => crypto.createHmac('sha256', 'device-token:' + ADMIN_KEY).update(payload).digest('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function issueToken(device) {
  const payload = b64(JSON.stringify({ d: String(device || 'device').slice(0, 60), iat: Date.now(), n: crypto.randomBytes(6).toString('hex') }));
  return payload + '.' + sign(payload);
}
function verifyToken(token) {
  const [payload, mac] = String(token || '').split('.');
  if (!payload || !mac || !safeEq(mac, sign(payload))) return false;
  try { const d = JSON.parse(Buffer.from(payload, 'base64url').toString()); return Date.now() - d.iat < TOKEN_DAYS * 86400000; }
  catch (e) { return false; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST' });
  if (!BASE || !TOKEN) return json(500, { error: 'Server is missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID' });
  // Fail closed: no key configured means nobody gets in.
  if (!ADMIN_KEY || ADMIN_KEY.length < 12) return json(500, { error: 'Admin is locked: set ADMIN_KEY (12+ characters) in Netlify and redeploy' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad JSON' }); }
  if (body.op === 'login') {
    if (!safeEq(body.key || '', ADMIN_KEY)) { await sleep(1200); return json(401, { error: 'Wrong access key' }); }
    return json(200, { token: issueToken(body.device) });
  }
  if (!verifyToken(event.headers['x-device-token'])) return json(401, { error: 'This device isn’t signed in' });
  const fn = Object.prototype.hasOwnProperty.call(ops, body.op) ? ops[body.op] : null;
  if (!fn) return json(400, { error: 'Unknown op' });
  try { return json(200, await fn(body)); }
  catch (e) { return json(502, { error: e.message || 'Server error' }); }
};
