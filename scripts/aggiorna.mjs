// FantaFormazione — aggiornamento automatico dei dati di Serie A.
// Gira su GitHub Actions e legge da BSD (Bzzoiro Sports Data, calcio gratuito).
// Scrive docs/data.json, il file che l'app scarica. Tiene in cache/ quello che non serve riscaricare.
// Licenza BSD: si pubblicano solo valori calcolati (stime), non i dati grezzi.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const KEY = process.env.BSD_API_KEY;
const BASE = process.env.BSD_BASE || 'https://sports.bzzoiro.com/api/v2';
const LEAGUE = 4;                 // Serie A su BSD
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const PAUSE = Number(process.env.PAUSE ?? 150); // ms tra una richiesta e l'altra, per gentilezza

if (!KEY) { console.error('Manca BSD_API_KEY (Settings → Secrets → Actions)'); process.exit(1); }

let used = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    used++;
    const r = await fetch(BASE + path, { headers: { Authorization: 'Token ' + KEY } });
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    await sleep(PAUSE);
    return r.json();
  }
  throw new Error(`${path} → non risponde`);
}
async function all(path) { // tutte le pagine (limit/offset)
  const out = []; let offset = 0;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const j = await api(`${path}${sep}limit=200&offset=${offset}`);
    const rows = j.results || [];
    out.push(...rows); offset += rows.length;
    if (!j.next || !rows.length) return out;
  }
}
const readJSON = async (f, d) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return d; } };
const writeJSON = async (f, o) => { await mkdir(f.split('/').slice(0, -1).join('/'), { recursive: true }); await writeFile(f, JSON.stringify(o)); };
const hours = (a, b) => (b - a) / 3600000;
const num = x => (x == null || x === '' ? 0 : Number(x) || 0);
const round2 = x => Math.round(x * 100) / 100;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ROLE = { G: 'P', D: 'D', M: 'C', F: 'A' };
const FINISHED = s => ['finished', 'ended', 'ft', 'aet', 'ap'].includes(String(s).toLowerCase());

// Voto stimato dal rating per partita (scala tipo 6,0-8,0): non è il voto dei giornali, serve solo a prevedere.
const votoDaRating = r => clamp(6 + (num(r) - 6.85) * 0.9, 4, 8.5);
// Bonus/malus del fantacalcio classico. Gol e assist sono mescolati a metà con xG e xA: tolgono un po' di fortuna.
function bonus(s, gk) {
  const g = s.xg == null ? s.g : .5 * s.g + .5 * s.xg, a = s.xa == null ? s.a : .5 * s.a + .5 * s.xa;
  return 3 * g + a - .5 * s.y - s.r - 3 * (s.pm || 0) + 3 * (s.ps || 0) - (gk ? s.conc : 0);
}
// Dalle quote 1X2 e over 2,5 ai gol attesi delle due squadre (stessa funzione dell'app)
function pois(l) { const o = []; let p = Math.exp(-l); for (let k = 0; k < 11; k++) { o.push(p); p *= l / (k + 1); } return o; }
function oddsToGoals(q1, qx, q2, qo) {
  const s = 1 / q1 + 1 / qx + 1 / q2, p1 = 1 / q1 / s, p2 = 1 / q2 / s, po = qo ? Math.min(.9, 1 / qo / 1.05) : null; let best = null;
  for (let h = .2; h <= 3.6; h += .05) for (let a = .2; a <= 3.6; a += .05) {
    const ph = pois(h), pa = pois(a); let w = 0, l = 0, o = 0;
    for (let i = 0; i < 11; i++) for (let j = 0; j < 11; j++) { const pr = ph[i] * pa[j]; if (i > j) w += pr; else if (j > i) l += pr; if (i + j > 2) o += pr; }
    const e = (w - p1) ** 2 + (l - p2) ** 2 + (po == null ? .004 * (h + a - 2.6) ** 2 : (o - po) ** 2);
    if (!best || e < best.e) best = { e, h, a };
  }
  return { lh: round2(best.h), la: round2(best.a) };
}
// Rigori dagli eventi della partita: struttura non documentata del tutto, quindi lettura prudente
function penaltiesFrom(incidents) {
  const out = [];
  for (const inc of incidents || []) {
    const t = JSON.stringify(inc).toLowerCase();
    if (!t.includes('penalt')) continue;
    const pid = inc.player_id ?? inc.player?.id ?? inc.playerId;
    if (!pid) continue;
    const missed = String(inc.type || '').toLowerCase().includes('miss') || /"reason":"(saved|post|miss)"/.test(t);
    out.push({ pid, missed, keeper: inc.goalkeeper_id ?? inc.keeper_id ?? null });
  }
  return out;
}

async function main() {
  const meta = await readJSON('cache/meta.json', {});
  const hist = await readJSON('cache/history.json', { done: [], rows: [], pens: [] });
  const fullRun = !meta.fullAt || hours(new Date(meta.fullAt), NOW) > 20 || process.env.FULL === '1';

  // 1. Stagione e calendario completo
  let season = meta.season, events = meta.events || [];
  if (fullRun) {
    const s = await api(`/leagues/${LEAGUE}/season/`);
    season = (s.season || s).id;
    const ev = await all(`/events/?league_id=${LEAGUE}&season_id=${season}`);
    events = ev.filter(e => e.league_id === LEAGUE).map(e => ({ id: e.id, date: e.event_date, status: e.status, round: e.round_number,
      h: e.home_team, a: e.away_team, hid: e.home_team_id, aid: e.away_team_id, hs: e.home_score, as: e.away_score }));
  }
  const upcoming = events.filter(e => !FINISHED(e.status) && !['cancelled', 'postponed'].includes(String(e.status).toLowerCase()))
    .sort((a, b) => a.date < b.date ? -1 : 1);
  const round = upcoming[0]?.round || Math.max(0, ...events.map(e => e.round || 0));
  const roundEvents = events.filter(e => e.round === round);
  const teamIds = [...new Set(events.flatMap(e => [e.hid, e.aid]))];

  // 2. Rose delle 20 squadre, con disponibilità (infortunati, squalificati, in dubbio)
  let squads = meta.squads || {};
  if (fullRun) {
    squads = {};
    for (const tid of teamIds) {
      const j = await api(`/teams/${tid}/squad/?played_within_days=365`);
      squads[tid] = (j.players || []).map(p => ({ id: p.id, name: p.name, short: p.short_name, pos: p.position, av: p.availability }));
    }
  }
  const teamName = {};
  for (const e of events) { teamName[e.hid] = e.h; teamName[e.aid] = e.a; }

  // 3. Statistiche delle partite finite (solo quelle non ancora salvate): voti, gol, assist, xG, titolari, rigori
  if (fullRun) {
    for (const e of events.filter(e => FINISHED(e.status) && !hist.done.includes(e.id))) {
      const ps = await api(`/events/${e.id}/player-stats/`);
      let starters = null;
      try {
        const lu = await api(`/events/${e.id}/lineups/`);
        if (lu.lineups) starters = ['home', 'away'].flatMap(s => (lu.lineups[s]?.players || []).map(p => p.id));
      } catch { /* formazione non disponibile */ }
      try { hist.pens.push(...penaltiesFrom((await api(`/events/${e.id}/incidents/`)).incidents).map(p => ({ ...p, ev: e.id }))); } catch { }
      for (const s of ps.player_stats || []) {
        if (!(s.minutes_played > 0)) continue;
        hist.rows.push({ pid: s.player_id, tid: s.team_id, ev: e.id, date: e.date, min: s.minutes_played,
          start: starters ? starters.includes(s.player_id) : s.minutes_played >= 55,
          rating: s.rating, g: num(s.goals), a: num(s.goal_assist), xg: s.expected_goals, xa: s.expected_assists,
          y: num(s.yellow_card), r: num(s.red_card), conc: num(s.goals_conceded) });
      }
      hist.done.push(e.id);
    }
    await writeJSON('cache/history.json', hist);
  }

  // 4. Forza delle squadre dai risultati della stagione (serve quando mancano le quote)
  const played = events.filter(e => FINISHED(e.status) && e.hs != null && e.as != null);
  const avgH = played.length ? played.reduce((s, e) => s + e.hs, 0) / played.length : 1.45;
  const avgA = played.length ? played.reduce((s, e) => s + e.as, 0) / played.length : 1.15;
  const T = {}; const t = id => (T[id] ||= { hf: 0, ha: 0, hn: 0, af: 0, aa: 0, an: 0 });
  for (const e of played) { const h = t(e.hid), a = t(e.aid); h.hf += e.hs; h.ha += e.as; h.hn++; a.af += e.as; a.aa += e.hs; a.an++; }
  const K = 4; // partite "virtuali" nella media: con poche partite la forza resta vicina alla media
  const att = (id, home) => { const x = t(id); return home ? (x.hf + K * avgH) / (x.hn * 1 + K) / avgH : (x.af + K * avgA) / (x.an + K) / avgA; };
  const def = (id, home) => { const x = t(id); return home ? (x.ha + K * avgA) / (x.hn + K) / avgA : (x.aa + K * avgH) / (x.an + K) / avgH; };
  const strengthGoals = e => ({ lh: round2(clamp(avgH * att(e.hid, true) * def(e.aid, false), .3, 3.5)), la: round2(clamp(avgA * att(e.aid, false) * def(e.hid, true), .2, 3.2)) });

  // 5. Quote della giornata → gol attesi (se mancano: stima dalla forza delle squadre)
  let matches = meta.matches || [];
  if (fullRun) {
    matches = [];
    for (const e of roundEvents) {
      const m = { id: e.id, h: e.h, a: e.a, date: e.date };
      if (!FINISHED(e.status)) {
        try {
          const o = (await api(`/events/${e.id}/odds/`)).odds || {};
          if (o.home_win > 1 && o.draw > 1 && o.away_win > 1) {
            const qo = o.over_25_goals > 1 ? o.over_25_goals : null;
            Object.assign(m, { q1: o.home_win, qx: o.draw, q2: o.away_win, qo }, oddsToGoals(o.home_win, o.draw, o.away_win, qo));
          }
        } catch (err) { console.warn('Quote non disponibili per', e.h, '-', e.a, err.message); }
        if (m.lh == null) Object.assign(m, strengthGoals(e), { stima: true });
      }
      matches.push(m);
    }
  }

  // 6. Formazioni della giornata: probabili (con fiducia) o ufficiali, più indisponibili.
  //    Nelle corse orarie si aggiornano solo le partite che iniziano entro 3 ore.
  const lineups = fullRun ? {} : (meta.lineups || {});
  for (const e of roundEvents) {
    const h = hours(NOW, new Date(e.date));
    if (FINISHED(e.status)) continue;
    if (!fullRun && (h > 3 || h < -2 || lineups[e.id]?.status === 'confirmed')) continue;
    try {
      const lu = await api(`/events/${e.id}/lineups/`);
      const rec = { status: lu.lineup_status, teams: [e.hid, e.aid], start: {}, bench: {}, out: {} };
      if (lu.lineups) for (const side of ['home', 'away']) {
        const L = lu.lineups[side]; if (!L) continue;
        let conf = L.confidence == null ? 1 : Number(L.confidence); if (conf > 1) conf /= 100;
        (L.players || []).forEach(p => rec.start[p.id] = conf);
        (L.substitutes || []).forEach(p => rec.bench[p.id] = 1);
      }
      for (const side of ['home', 'away']) for (const u of (lu.unavailable_players?.[side] || []))
        rec.out[u.id] = String(u.status).toLowerCase() === 'doubtful' ? 'B' : 'X';
      lineups[e.id] = rec;
    } catch (err) { console.warn('Formazioni non disponibili per', e.h, '-', e.a, err.message); }
  }

  // 7. Calcolo per ogni giocatore
  const rowsBy = {}; for (const r of hist.rows) (rowsBy[r.pid] ||= []).push(r);
  const teamEv = {}; for (const r of hist.rows) (teamEv[r.tid] ||= new Map()).set(r.ev, r.date);
  const lastTeam = tid => [...(teamEv[tid] || new Map()).entries()].sort((a, b) => a[1] < b[1] ? -1 : 1).slice(-5).map(x => x[0]);
  const teamGames = tid => (teamEv[tid] || new Map()).size;
  // rigoristi: rigori calciati in stagione, per squadra
  const pensBy = {}; for (const p of hist.pens) pensBy[p.pid] = (pensBy[p.pid] || 0) + 1;
  const missBy = {}; for (const p of hist.pens) if (p.missed) missBy[p.pid] = (missBy[p.pid] || 0) + 1;
  const penRank = {};
  for (const [tid, list] of Object.entries(squads)) list.filter(p => pensBy[p.id]).sort((a, b) => pensBy[b.id] - pensBy[a.id]).slice(0, 3).forEach((p, i) => penRank[p.id] = i + 1);

  const surname = p => { const s = p.short || p.name || ''; const m = s.match(/^[A-ZÀ-Ý]\.\s+(.+)$/); return m ? m[1] : (p.name || s).split(' ').slice(-1)[0]; };
  const count = {}; for (const list of Object.values(squads)) for (const p of list) { const k = surname(p).toLowerCase(); count[k] = (count[k] || 0) + 1; }

  const out = [];
  for (const [tid, list] of Object.entries(squads)) {
    const tidN = Number(tid);
    const lu = Object.values(lineups).find(l => l.teams.includes(tidN));
    const last5 = lastTeam(tidN), tg = teamGames(tidN);
    for (const p of list) {
      const r = ROLE[p.pos] || 'C', gk = r === 'P';
      const mine = (rowsBy[p.id] || []).sort((a, b) => a.date < b.date ? -1 : 1);
      const voted = mine.filter(x => x.rating);
      const pv = voted.length;
      const mvs = pv ? voted.reduce((s, x) => s + votoDaRating(x.rating), 0) / pv : 6;
      const pm = missBy[p.id] || 0;
      const fm = pv ? voted.reduce((s, x) => s + votoDaRating(x.rating) + bonus(x, gk), 0) / pv - 3 * pm / pv : null;
      const v5 = voted.slice(-5);
      const fm5 = v5.length >= 3 ? v5.reduce((s, x) => s + votoDaRating(x.rating) + bonus(x, gk), 0) / v5.length : null;
      // titolarità: 40% stagione + 60% ultime 5 partite della squadra
      const tSeason = tg ? mine.filter(x => x.start).length / tg : 0;
      const tRecent = last5.length >= 3 ? mine.filter(x => last5.includes(x.ev) && x.start).length / last5.length : null;
      let tit = 100 * (tRecent == null ? tSeason : .4 * tSeason + .6 * tRecent);
      let st = p.av === 'injured' || p.av === 'suspended' ? 'X' : p.av === 'doubtful' ? 'B' : 'T';
      let lineup = null;
      if (lu) {
        if (lu.out[p.id]) st = lu.out[p.id];
        if (lu.status === 'confirmed') {
          lineup = 'ufficiale';
          if (lu.start[p.id] != null) { tit = 99; st = 'T'; } else if (lu.bench[p.id]) { tit = 15; st = 'T'; } else { tit = 0; st = 'X'; }
        } else if (lu.status === 'predicted') {
          lineup = 'probabile';
          if (lu.start[p.id] != null) tit = Math.max(tit, 55 + 40 * clamp(lu.start[p.id], 0, 1));
          else if (lu.bench[p.id]) tit = Math.min(tit, 30);
          else tit = Math.min(tit, 10);
        }
      }
      tit = clamp(Math.round(tit / 5) * 5, lineup === 'ufficiale' ? 0 : 3, lineup === 'ufficiale' ? 99 : 95);
      const sn = surname(p);
      out.push({ id: p.id, n: count[sn.toLowerCase()] > 1 ? `${sn} ${(p.name || '')[0] || ''}.` : sn, full: p.name, club: teamName[tidN] || '', r, tit, st,
        fm: fm == null ? null : round2(fm), fm5: fm5 == null ? null : round2(fm5), pv, mv: round2(mvs), rig: penRank[p.id] || 0, lineup });
    }
  }

  const data = { v: 1, updated: NOW.toISOString(), season, round,
    note: 'Valori stimati da FantaFormazione su dati BSD. Voti e fantamedie sono stime, non i voti ufficiali dei giornali.',
    matches, players: out };
  await writeJSON('docs/data.json', data);
  if (fullRun) meta.fullAt = NOW.toISOString();
  Object.assign(meta, { season, events, squads, matches, lineups });
  await writeJSON('cache/meta.json', meta);
  console.log(`Fatto: ${out.length} giocatori, ${matches.length} partite (giornata ${round}), ${used} richieste.`);
}

main().catch(e => { console.error('Errore:', e.message); process.exit(1); });
