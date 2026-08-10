// api.js — lecture de l'API 1xbet Baccara (LiveFeed/GetChampZip)
// Un jeu renvoie TOUTES les cartes et TOUS les costumes des deux mains ;
// la main réellement vérifiée est choisie dans le prédicteur (joueur par défaut).
const config = require('./config');

const SUIT_MAP = { 0: '♠️', 1: '♣️', 2: '♦️', 3: '❤️' };
const RANK_MAP = {
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8',
  9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K',
};

const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'content-type': 'application/json',
  'is-srv': 'false',
  'x-app-n': 'BETTING_APP',
  'x-requested-with': 'XMLHttpRequest',
  'x-svc-source': 'BETTING_APP',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const FINISHED_PHASES = ['Win1', 'Win2', 'Tie', 'Match finished'];

function cardLabel(c) {
  if (!c) return null;
  const rank = RANK_MAP[c.V] || (c.V != null ? String(c.V) : '?');
  return `${rank}${SUIT_MAP[c.S] || ''}`;
}

// valeur baccara d'une carte : A=1, 2..9 = valeur, 10/J/Q/K = 0
function cardValue(c) {
  const v = Number(c && c.V);
  if (!Number.isFinite(v)) return 0;
  return v >= 10 ? 0 : v;
}

function handValue(list) {
  return (list || []).reduce((s, c) => s + cardValue(c), 0) % 10;
}

function suitsOf(list) {
  return (list || []).map((c) => SUIT_MAP[c.S]).filter(Boolean);
}

function parseCards(scS) {
  const out = { player: [], banker: [] };
  for (const e of scS || []) {
    let cards = [];
    try { cards = JSON.parse(e.Value || '[]'); } catch { cards = []; }
    if (e.Key === 'P') out.player = cards;
    else if (e.Key === 'B') out.banker = cards;
  }
  return out;
}

function phaseOf(scS) {
  const e = (scS || []).find((x) => x.Key === 'S');
  return e ? e.Value : null;
}

function winnerOf(scS) {
  const p = phaseOf(scS);
  if (p === 'Win1') return 'Joueur';
  if (p === 'Win2') return 'Banquier';
  if (p === 'Tie') return 'Égalité';
  return null;
}

const parity = (n) => (n == null ? null : n % 2 === 0 ? 'pair' : 'impair');

function parseChamp(data) {
  const games = data && data.Value && data.Value.G;
  if (!Array.isArray(games)) return [];
  const out = [];
  for (const g of games) {
    const number = parseInt(g.DI, 10);
    if (!Number.isFinite(number) || number <= 0) continue;
    const sc = g.SC || {};
    const scS = sc.S || [];
    const cards = parseCards(scS);
    const ph = phaseOf(scS);
    const finished = !!g.F || sc.CPS === 'Match finished' || FINISHED_PHASES.includes(ph);
    const playerValue = cards.player.length ? handValue(cards.player) : null;
    const bankerValue = cards.banker.length ? handValue(cards.banker) : null;

    out.push({
      number,
      // toutes les cartes et tous les costumes des deux mains
      player: cards.player.map(cardLabel),
      banker: cards.banker.map(cardLabel),
      playerSuits: suitsOf(cards.player),
      bankerSuits: suitsOf(cards.banker),
      playerValue,
      bankerValue,
      playerParity: parity(playerValue),
      bankerParity: parity(bankerValue),
      playerCards: cards.player.length,
      bankerCards: cards.banker.length,
      dealing: cards.player.length > 0 || cards.banker.length > 0,
      winner: winnerOf(scS),
      phase: ph,
      finished,
      score: sc.FS || {},
      at: Date.now(),
    });
  }
  return out.sort((a, b) => b.number - a.number);
}

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function endpoints() {
  const qs = `champ=${config.CHAMP_ID}&lng=en&country=96&groupChamps=true`;
  return config.API_HOSTS.map((h) => `${h}/LiveFeed/GetChampZip?${qs}`);
}

async function fetchGames() {
  for (const url of endpoints()) {
    const data = await get(url);
    const parsed = data ? parseChamp(data) : [];
    if (parsed.length) return parsed;
  }
  for (const url of endpoints().slice(0, 2)) {
    for (const p of config.PROXIES) {
      const data = await get(p(url));
      const parsed = data ? parseChamp(data) : [];
      if (parsed.length) return parsed;
    }
  }
  throw new Error('API 1xbet Baccara injoignable');
}

module.exports = { fetchGames, parseChamp, endpoints, SUIT_MAP, RANK_MAP, cardLabel, handValue };
