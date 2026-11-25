// Esplorazione una tantum dell'API BSD: salva esempi di risposta in samples/ (senza la chiave).
import { writeFile, mkdir } from 'node:fs/promises';
const KEY = process.env.BSD_API_KEY, BASE = 'https://sports.bzzoiro.com/api/v2';
if (!KEY) { console.error('Manca BSD_API_KEY'); process.exit(1); }
await mkdir('samples', { recursive: true });
const cut = (o, n = 4) => Array.isArray(o) ? o.slice(0, n).map(x => cut(x, n)) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, cut(v, k === 'results' || k === 'lineups' || k === 'home' || k === 'away' ? 40 : n)])) : o;
async function get(name, path) {
  try {
    const r = await fetch(BASE + path, { headers: { Authorization: 'Token ' + KEY } });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 2000) }; }
    await writeFile(`samples/${name}.json`, JSON.stringify({ path, status: r.status, body: cut(j) }, null, 1));
    console.log(name, r.status); return j;
  } catch (e) { console.log(name, 'ERR', e.message); return null; }
}
const lg = await get('leagues-italy', '/leagues/?country=Italy');
const list = lg?.results || lg || [];
const sa = (Array.isArray(list) ? list : []).find(l => /serie a/i.test(l.name || '')) || list[0];
const lid = sa?.id; console.log('Serie A id', lid);
const season = await get('season', `/leagues/${lid}/season/`);
const sid = season?.id;
const up = await get('events-upcoming', `/events/?league_id=${lid}&season_id=${sid}&status=upcoming&limit=12`);
const fin = await get('events-finished', `/events/?league_id=${lid}&season_id=${sid}&status=finished&limit=3`);
const e1 = (up?.results || [])[0]?.id, f1 = (fin?.results || [])[0]?.id;
if (e1) { await get('event-detail', `/events/${e1}/`); await get('event-odds', `/events/${e1}/odds/`); await get('event-lineups', `/events/${e1}/lineups/`); }
if (f1) { await get('finished-player-stats', `/events/${f1}/player-stats/`); await get('finished-lineups', `/events/${f1}/lineups/`); await get('finished-incidents', `/events/${f1}/incidents/`); }
const teams = await get('teams', `/teams/?league_id=${lid}&season_id=${sid}&limit=30`);
const t1 = (teams?.results || [])[0]?.id;
if (t1) { const sq = await get('squad', `/teams/${t1}/squad/`); const pl = (sq?.results || sq?.squad || sq?.players || [])[0];
  const pid = pl?.id || pl?.player_id || pl?.player?.id; if (pid) { await get('player', `/players/${pid}/`); await get('player-stats', `/players/${pid}/stats/?season_id=${sid}`); await get('player-career', `/players/${pid}/career/`); } }
await get('players-team', `/players/?team_id=${t1}&limit=5`);
await get('leaderboard', `/leagues/${lid}/top/scorers/`);
