// FantaFormazione — aggiornamento automatico dei dati di Serie A.
// Gira su GitHub Actions. Legge da API-Football (piano gratuito: max 100 richieste al giorno)
// e scrive docs/data.json, il file che l'app scarica. Tiene in cache/ quello che non serve riscaricare.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const KEY = process.env.API_FOOTBALL_KEY;
const BASE = process.env.API_BASE || 'https://v3.football.api-sports.io';
const LEAGUE = 135;              // Serie A
const BOOKMAKER = 8;             // bet365
const MAX_REQ = Number(process.env.MAX_REQ || 90); // margine sotto le 100 giornaliere
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const PLAYERS_EVERY_DAYS = 6;    // statistiche stagionali: una volta a settimana

if (!KEY) { console.error('Manca API_FOOTBALL_KEY (Settings → Secrets → Actions)'); process.exit(1); }

let used = 0;
async function api(path, params = {}) {
  if (used >= MAX_REQ) throw new Error('Limite di richieste raggiunto per oggi');
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  used++;
  const r = await fetch(url, { headers: { 'x-apisports-key': KEY } });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  const j = await r.json();
  const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
  if (errs && errs.length) throw new Error(`${path} → ${JSON.stringify(j.errors)}`);
  return j;
}
const readJSON = async (f, d) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return d; } };
const writeJSON = async (f, o) => { await mkdir(f.split('/').slice(0, -1).join('/'), { recursive: true }); await writeFile(f, JSON.stringify(o)); };
const days = (a, b) => (b - a) / 86400000;
const num = x => (x == null || x === '' ? 0 : Number(x) || 0);
const round2 = x => Math.round(x * 100) / 100;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ROLE = { Goalkeeper: 'P', Defender: 'D', Midfielder: 'C', Attacker: 'A', G: 'P', D: 'D', M: 'C', F: 'A' };

// Voto stimato dal rating del fornitore (non è il voto dei giornali: serve solo a prevedere).
const votoDaRating = r => clamp(6 + (num(r) - 6.9) * 0.9, 4, 8.5);
// Bonus/malus del fantacalcio classico ricavati dalle statistiche
const bonus = (s, gk) => 3 * num(s.g) + num(s.a) - 0.5 * num(s.y) - num(s.r) - 3 * num(s.pm) + 3 * num(s.ps) - (gk ? num(s.conc) : 0);

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

async function main() {
  const meta = await readJSON('cache/meta.json', {});
  const out = await readJSON('docs/data.json', null);
  const fullRun = !out || !meta.fullAt || days(new Date(meta.fullAt), NOW) > 0.8 || process.env.FULL === '1';

  // 1. Stagione e giornata in corso
  let season = meta.season, roundName = meta.roundName, fixtures = meta.fixtures || [];
  if (fullRun) {
    const lg = await api('/leagues', { id: LEAGUE, current: 'true' });
    season = lg.response[0].seasons.find(s => s.current)?.year ?? lg.response[0].seasons[0].year;
    const rd = await api('/fixtures/rounds', { league: LEAGUE, season, current: 'true' });
    roundName = rd.response[0];
    const fx = await api('/fixtures', { league: LEAGUE, season, round: roundName });
    fixtures = fx.response.map(f => ({ id: f.fixture.id, date: f.fixture.date, status: f.fixture.status.short,
      h: f.teams.home.name, a: f.teams.away.name, hid: f.teams.home.id, aid: f.teams.away.id }));
  }
  const roundNum = Number(String(roundName).match(/(\d+)\s*$/)?.[1] || 0);

  // 2. Statistiche stagionali dei giocatori (una volta a settimana, ~30 richieste)
  let players = await readJSON('cache/players.json', []);
  if (fullRun && (!meta.playersAt || days(new Date(meta.playersAt), NOW) > PLAYERS_EVERY_DAYS || !players.length)) {
    const list = []; let page = 1, total = 1;
    do {
      const j = await api('/players', { league: LEAGUE, season, page });
      total = j.paging?.total || 1;
      for (const it of j.response) {
        const st = (it.statistics || []).filter(s => s.league?.id === LEAGUE).sort((a, b) => num(b.games?.appearences) - num(a.games?.appearences))[0];
        if (!st || !st.team) continue;
        list.push({ id: it.player.id, name: it.player.name, first: it.player.firstname || '', last: it.player.lastname || it.player.name,
          tid: st.team.id, club: st.team.name, r: ROLE[st.games?.position] || 'C',
          apps: num(st.games?.appearences), starts: num(st.games?.lineups), min: num(st.games?.minutes), rating: num(st.games?.rating),
          g: num(st.goals?.total), a: num(st.goals?.assists), conc: num(st.goals?.conceded), y: num(st.cards?.yellow), r2: num(st.cards?.red),
          pens: num(st.penalty?.scored) + num(st.penalty?.missed), pm: num(st.penalty?.missed), ps: num(st.penalty?.saved) });
      }
      page++;
    } while (page <= total);
    players = list; meta.playersAt = NOW.toISOString();
    await writeJSON('cache/players.json', players);
  }

  // 3. Voti delle partite giocate (per le ultime 5): solo partite finite non ancora salvate, 1 richiesta ciascuna
  const hist = await readJSON('cache/history.json', { done: [], rows: [] });
  if (fullRun) {
    const prev = await api('/fixtures', { league: LEAGUE, season, last: 10 });
    for (const f of prev.response) {
      if (!['FT', 'AET', 'PEN'].includes(f.fixture.status.short) || hist.done.includes(f.fixture.id)) continue;
      if (used >= MAX_REQ - 15) break;
      const fp = await api('/fixtures/players', { fixture: f.fixture.id });
      for (const t of fp.response) for (const p of t.players) {
        const s = p.statistics?.[0]; if (!s) continue;
        hist.rows.push({ pid: p.player.id, tid: t.team.id, fx: f.fixture.id, date: f.fixture.date, min: num(s.games?.minutes),
          start: s.games?.substitute === false, rating: s.games?.rating ? num(s.games.rating) : null,
          g: num(s.goals?.total), a: num(s.goals?.assists), conc: num(s.goals?.conceded), y: num(s.cards?.yellow), r: num(s.cards?.red),
          pm: num(s.penalty?.missed), ps: num(s.penalty?.saved), gk: s.games?.position === 'G' });
      }
      hist.done.push(f.fixture.id);
    }
    const cut = new Date(NOW - 120 * 86400000).toISOString(); // tiene ~4 mesi
    hist.rows = hist.rows.filter(r => r.date >= cut);
    await writeJSON('cache/history.json', hist);
  }

  // 4. Infortuni e squalifiche per le partite della giornata
  let injuries = meta.injuries || {};
  if (fullRun) {
    injuries = {};
    for (const f of fixtures) {
      if (used >= MAX_REQ - 12) break;
      const j = await api('/injuries', { fixture: f.id });
      for (const it of j.response) injuries[it.player.id] = it.player.type === 'Questionable' ? 'B' : 'X';
    }
  }

  // 5. Quote → gol attesi
  let matches = out?.matches && !fullRun ? out.matches : [];
  if (fullRun) {
    for (const f of fixtures) {
      const m = { id: f.id, h: f.h, a: f.a, date: f.date };
      if (used < MAX_REQ - 12 && !['FT', 'AET', 'PEN'].includes(f.status)) {
        try {
          const j = await api('/odds', { fixture: f.id, bookmaker: BOOKMAKER });
          const bets = j.response[0]?.bookmakers?.[0]?.bets || [];
          const mw = bets.find(b => b.id === 1)?.values || [], ou = bets.find(b => b.id === 5)?.values || [];
          const q = v => Number(mw.find(x => x.value === v)?.odd), qo = Number(ou.find(x => x.value === 'Over 2.5')?.odd) || null;
          if (q('Home') > 1 && q('Draw') > 1 && q('Away') > 1) Object.assign(m, { q1: q('Home'), qx: q('Draw'), q2: q('Away'), qo }, oddsToGoals(q('Home'), q('Draw'), q('Away'), qo));
        } catch (e) { console.warn('Quote non disponibili per', f.h, '-', f.a, e.message); }
      }
      matches.push(m);
    }
  }

  // 6. Formazioni ufficiali (escono ~1 ora prima): solo per le partite che iniziano entro 90 minuti
  const lineups = meta.lineups || {};
  for (const f of fixtures) {
    const mins = (new Date(f.date) - NOW) / 60000;
    if (lineups[f.id] || mins > 90 || mins < -150 || used >= MAX_REQ) continue;
    const j = await api('/fixtures/lineups', { fixture: f.id });
    if (j.response.length === 2 && j.response.every(t => (t.startXI || []).length === 11)) {
      lineups[f.id] = { teams: j.response.map(t => t.team.id), start: j.response.flatMap(t => t.startXI.map(x => x.player.id)), bench: j.response.flatMap(t => t.substitutes.map(x => x.player.id)) };
    }
  }

  // 7. Calcolo per ogni giocatore
  const byTeam = {};
  for (const p of players) (byTeam[p.tid] ||= []).push(p);
  const teamGames = {}; // partite giocate da ogni squadra ≈ presenze del giocatore più presente
  for (const [tid, ps] of Object.entries(byTeam)) teamGames[tid] = Math.max(1, ...ps.map(p => p.apps));
  const rowsBy = {}; for (const r of hist.rows) (rowsBy[r.pid] ||= []).push(r);
  const teamFx = {}; for (const r of hist.rows) (teamFx[r.tid] ||= new Set()).add(r.fx);
  const lastTeamFx = tid => [...(teamFx[tid] || [])].map(fx => hist.rows.find(r => r.fx === fx && r.tid == tid).date).sort().slice(-5);
  const penRank = {};
  for (const ps of Object.values(byTeam)) ps.filter(p => p.pens > 0).sort((a, b) => b.pens - a.pens).slice(0, 3).forEach((p, i) => penRank[p.id] = i + 1);
  const lastCount = {}; for (const p of players) { const k = p.last.toLowerCase(); lastCount[k] = (lastCount[k] || 0) + 1; }

  const outPlayers = players.map(p => {
    const gk = p.r === 'P';
    const pv = players.length ? (p.rating ? p.apps : 0) : 0;
    const mv = p.rating ? votoDaRating(p.rating) : 6;
    const fm = pv ? mv + bonus({ g: p.g, a: p.a, y: p.y, r: p.r2, pm: p.pm, ps: p.ps, conc: p.conc }, gk) / pv : null;
    // ultime 5 con voto
    const mine = (rowsBy[p.id] || []).sort((a, b) => a.date < b.date ? -1 : 1);
    const voted = mine.filter(r => r.rating).slice(-5);
    const fm5 = voted.length >= 3 ? voted.reduce((s, r) => s + votoDaRating(r.rating) + bonus(r, gk), 0) / voted.length : null;
    // titolarità: stagione + ultime 5 partite della squadra
    const tSeason = p.starts / teamGames[p.tid];
    const last5 = lastTeamFx(p.tid);
    const tRecent = last5.length >= 3 ? mine.filter(r => last5.includes(r.date) && r.start).length / last5.length : null;
    let tit = 100 * (tRecent == null ? tSeason : .4 * tSeason + .6 * tRecent);
    tit = clamp(Math.round(tit / 5) * 5, 3, 95);
    let st = injuries[p.id] || 'T';
    // formazione ufficiale uscita: comanda lei
    const lu = Object.values(lineups).find(l => l.teams.includes(p.tid));
    if (lu) { if (lu.start.includes(p.id)) { tit = 99; st = 'T'; } else if (lu.bench.includes(p.id)) { tit = 15; st = 'T'; } else { tit = 0; st = 'X'; } }
    const n = lastCount[p.last.toLowerCase()] > 1 && p.first ? `${p.last} ${p.first[0]}.` : p.last;
    return { id: p.id, n, full: `${p.first} ${p.last}`.trim(), club: p.club, r: p.r, tit, st,
      fm: fm == null ? null : round2(fm), fm5: fm5 == null ? null : round2(fm5), pv, mv: round2(mv), rig: penRank[p.id] || 0, lineup: !!lu };
  });

  const data = { v: 1, updated: NOW.toISOString(), season, round: roundNum,
    note: 'Valori stimati da FantaFormazione su dati di API-Football. Voti e fantamedie sono stime, non i voti ufficiali dei giornali.',
    matches, players: outPlayers };
  await writeJSON('docs/data.json', data);
  if (fullRun) meta.fullAt = NOW.toISOString();
  Object.assign(meta, { season, roundName, fixtures, injuries, lineups });
  // le formazioni ufficiali vecchie non servono più
  for (const id of Object.keys(lineups)) if (!fixtures.some(f => String(f.id) === id)) delete lineups[id];
  await writeJSON('cache/meta.json', meta);
  console.log(`Fatto: ${outPlayers.length} giocatori, ${matches.length} partite (giornata ${roundNum}), ${used} richieste usate.`);
}

main().catch(e => { console.error('Errore:', e.message); process.exit(1); });
