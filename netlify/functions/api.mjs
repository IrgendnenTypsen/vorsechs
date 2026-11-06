// vorsechs – anonyme Nutzungszahlen + Umfragen. Speichert NUR Zähler, keine Namen, Adressen, Standorte oder IPs.
// Endpunkte: POST /api/ping · POST /api/survey · GET /api/stats?key=…
import { getStore } from '@netlify/blobs';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
// die zufällige App-Nummer wird nur gehasht gespeichert
async function hash(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vorsechs:${s}`));
  return [...new Uint8Array(b)].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
}
const clean = (s, n = 20) => String(s ?? '').replace(/[^\w.\- ]/g, '').slice(0, n);
const EVENTS = new Set(['open', 'close', 'tour', 'download']);

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\//, '');
  const store = getStore('stats');

  if (path === 'ping' && req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    const ev = clean(b.ev);
    if (!EVENTS.has(ev)) return json({ error: 'bad event' }, 400);
    const key = `day/${day()}`;
    // shortcut: lesen-ändern-schreiben ohne Sperre; bei gleichzeitigen Pings kann einer verloren gehen – egal bei <1000 Nutzern, sonst auf eine DB umsteigen
    const d = (await store.get(key, { type: 'json' })) || { users: {}, downloads: {}, versions: {} };
    if (ev === 'download') { const k = clean(b.kind, 10) || 'apk'; d.downloads[k] = (d.downloads[k] || 0) + 1; }
    else {
      if (!b.id || String(b.id).length < 8) return json({ error: 'no id' }, 400);
      const h = await hash(b.id);
      const u = d.users[h] || (d.users[h] = { opens: 0, secs: 0, tours: 0, stops: 0 });
      if (ev === 'open') u.opens++;
      if (ev === 'close') u.secs += Math.max(0, Math.min(6 * 3600, Number(b.secs) || 0));
      if (ev === 'tour') { u.tours++; u.stops += Math.max(0, Math.min(2000, Number(b.stops) || 0)); }
      const v = `${clean(b.v, 12)}${b.flavor === 'test' ? '-test' : ''}`;
      if (v) d.versions[v] = (d.versions[v] || 0) + (ev === 'open' ? 1 : 0);
      // erster Kontakt → zählt als neue Installation
      const seen = (await store.get('installs', { type: 'json' })) || {};
      if (!seen[h]) { seen[h] = day(); await store.setJSON('installs', seen); }
    }
    await store.setJSON(key, d);
    return json({ ok: true });
  }

  if (path === 'survey' && req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    if (!b.id || !b.survey || typeof b.answers !== 'object') return json({ error: 'bad survey' }, 400);
    const answers = Object.fromEntries(Object.entries(b.answers).slice(0, 10).map(([k, v]) => [clean(k), clean(v, 300)]));
    await getStore('surveys').setJSON(`${clean(b.survey, 40)}/${await hash(b.id)}`, { at: day(), answers });
    return json({ ok: true });
  }

  if (path === 'stats' && req.method === 'GET') {
    if (!process.env.STATS_KEY || url.searchParams.get('key') !== process.env.STATS_KEY) return json({ error: 'falsches Passwort' }, 401);
    const days = [];
    for (let i = 59; i >= 0; i--) {
      const k = day(Date.now() - i * 864e5);
      const d = (await store.get(`day/${k}`, { type: 'json' })) || { users: {}, downloads: {}, versions: {} };
      const us = Object.values(d.users);
      days.push({ day: k, active: us.length, opens: us.reduce((a, u) => a + u.opens, 0), secs: us.reduce((a, u) => a + u.secs, 0),
        tours: us.reduce((a, u) => a + u.tours, 0), stops: us.reduce((a, u) => a + u.stops, 0), downloads: d.downloads, versions: d.versions, ids: Object.keys(d.users) });
    }
    const uniq = (list) => new Set(list.flatMap((x) => x.ids)).size;
    const installs = (await store.get('installs', { type: 'json' })) || {};
    // Stammnutzer: an mindestens 3 der letzten 7 Tage aktiv
    const last7 = days.slice(-7), cnt = {};
    last7.forEach((d) => d.ids.forEach((h) => { cnt[h] = (cnt[h] || 0) + 1; }));
    const surveys = {};
    const ss = getStore('surveys');
    for (const { key } of (await ss.list()).blobs) {
      const [sid] = key.split('/');
      const r = await ss.get(key, { type: 'json' });
      (surveys[sid] ||= []).push(r);
    }
    return json({
      installs: Object.keys(installs).length,
      wau: uniq(last7), mau: uniq(days.slice(-30)), regular: Object.values(cnt).filter((n) => n >= 3).length,
      days: days.map(({ ids, ...rest }) => rest), surveys,
    });
  }
  return json({ error: 'not found' }, 404);
};
export const config = { path: '/api/*' };
