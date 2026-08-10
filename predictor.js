// predictor.js — moteur multi-stratégies (main du JOUEUR uniquement)
//
//  • Chaque stratégie possède sa propre configuration (activation, format,
//    rattrapages, compteur B, canaux) enregistrée en base de données.
//  • La vérification se fait TOUJOURS sur la main du joueur :
//      – kind 'suit'  → le costume prédit apparaît-il dans les cartes du joueur ?
//      – kind 'cards' → le joueur a-t-il le nombre de cartes prédit (et le
//        banquier aussi, pour la distribution) ?
//  • La main du banquier n'est utilisée que pour les filtres/statistiques et
//    l'archivage en base de données.
const config = require('./config');
const fmt = require('./formats');
const strategies = require('./strategies');

const BADGES = ['0⃣', '1⃣', '2⃣', '3⃣', '4⃣', '5⃣', '6⃣', '7⃣', '8⃣', '9⃣'];
const SUITS = strategies.SUITS;
const normSuit = strategies.normSuit;

const state = {
  // réglages globaux (compat : ils pilotent la stratégie « costume »)
  B: config.DEFAULT_B,
  maxR: config.DEFAULT_MAX_R,
  hand: 'joueur',
  format: config.DEFAULT_FORMAT,
  template: null,
  channels: [],
  activeChannels: [],
  strategies: {},          // key -> config
  history: [],
  games: new Map(),
  counters: { '♦️': 0, '❤️': 0, '♣️': 0, '♠️': 0 },
  predictions: [],
  triggersDone: {},        // "clé:déclencheur" -> true (règle 1 : un seul traitement)
  live: null,
  lastFinished: null,
  lastError: null,
  startedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// Configuration des stratégies
// ---------------------------------------------------------------------------
function initStrategies() {
  for (const s of strategies.LIST) {
    if (!state.strategies[s.key]) state.strategies[s.key] = strategies.defaultsFor(s.key);
  }
  syncCostume();
  return state.strategies;
}

// la stratégie « costume » reste pilotée par les réglages globaux (compat /setb…)
function syncCostume() {
  const c = state.strategies.costume;
  if (!c) return;
  c.b = state.B;
  c.maxR = state.maxR;
  c.format = state.format;
  c.template = state.template;
}

function pullCostume() {
  const c = state.strategies.costume;
  if (!c) return;
  state.B = c.b;
  state.maxR = c.maxR;
  state.format = c.format;
  state.template = c.template || null;
}

function strategyConfig(key) {
  return state.strategies[key] || null;
}

// "-1001234, -1005678" ou [ -100... ] -> [ -1001234, -1005678 ]
function parseChannels(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;]+/);
  return list.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n) && n !== 0);
}

function setStrategyConfig(key, patch = {}) {
  const def = strategies.BY_KEY[key];
  if (!def) return null;
  const cur = state.strategies[key] || strategies.defaultsFor(key);
  const next = { ...cur };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.format !== undefined) next.format = fmt.clampFormat(patch.format);
  if (patch.formatDistribution !== undefined) next.formatDistribution = fmt.clampFormat(patch.formatDistribution);
  if (patch.maxR !== undefined) next.maxR = Math.max(0, Math.min(9, parseInt(patch.maxR, 10) || 0));
  if (patch.b !== undefined) next.b = Math.max(0, parseInt(patch.b, 10) || 0);
  if (patch.lead !== undefined) next.lead = Math.max(1, Math.min(9, parseInt(patch.lead, 10) || 1));
  // paramètres de la stratégie Pair / Impair (VAR)
  if (patch.startGame !== undefined) next.startGame = Math.max(1, parseInt(patch.startGame, 10) || 1);
  if (patch.varStep !== undefined) next.varStep = Math.max(0, Math.min(99, parseInt(patch.varStep, 10) || 0));
  if (patch.decalage !== undefined) next.decalage = Math.max(1, Math.min(99, parseInt(patch.decalage, 10) || 1));
  if (patch.template !== undefined) next.template = patch.template ? String(patch.template) : null;
  if (patch.channels !== undefined) next.channels = parseChannels(patch.channels);
  if (patch.channelId !== undefined) next.channels = parseChannels(patch.channelId);
  if (patch.token !== undefined) next.token = patch.token ? String(patch.token).trim() : null;
  if (patch.bilan !== undefined) next.bilan = !!patch.bilan;
  state.strategies[key] = next;
  if (key === 'costume') pullCostume();
  return next;
}

function resetStrategy(key) {
  if (!strategies.BY_KEY[key]) return null;
  state.strategies[key] = strategies.defaultsFor(key);
  if (key === 'costume') pullCostume();
  return state.strategies[key];
}

function strategyChannels(key) {
  const c = state.strategies[key];
  if (c && Array.isArray(c.channels) && c.channels.length) return c.channels;
  return state.activeChannels;
}

// ---------------------------------------------------------------------------
// Lecture des mains
// ---------------------------------------------------------------------------
function handSuits(game) {
  if (!game) return [];
  return strategies.suitsOf(game.playerSuits);
}

function hasSuit(game, suit) {
  const want = normSuit(suit);
  if (!want) return false;
  return handSuits(game).includes(want);
}

function suitForNumber(n) {
  return strategies.suitForNumber(n);
}

function nextTarget(current) {
  for (let n = current + config.LEAD; n < current + 40; n++) {
    if (suitForNumber(n)) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Enregistrement des jeux + détection du jeu LIVE
// ---------------------------------------------------------------------------
let onFinishedHook = null;
function setOnFinished(fn) { onFinishedHook = fn; }

function registerGames(games) {
  for (const g of games) {
    const prev = state.games.get(g.number);
    state.games.set(g.number, g);
    if (g.finished && (!prev || !prev.finished)) onFinished(g);
  }
  if (state.games.size > 600) {
    const keys = [...state.games.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, state.games.size - 600)) state.games.delete(k);
  }
  state.live = detectLive();
  return state.live;
}

function detectLive() {
  const all = [...state.games.values()].sort((a, b) => a.number - b.number);
  const dealing = all.filter((g) => !g.finished && g.dealing);
  if (dealing.length) return dealing[0];
  const pending = all.filter((g) => !g.finished);
  if (pending.length) return pending[0];
  return state.lastFinished;
}

function maxFinishedNumber() {
  let max = 0;
  for (const g of state.games.values()) if (g.finished && g.number > max) max = g.number;
  return max;
}

// compteur B : 0 si absent, +1 si présent, repart à 1 après avoir atteint B
function bumpCounters(round) {
  const b = state.B;
  for (const s of SUITS) {
    if (hasSuit(round, s)) {
      if (state.counters[s] >= b) state.counters[s] = 1;
      else state.counters[s] += 1;
      if (state.counters[s] > b) state.counters[s] = b;
    } else {
      state.counters[s] = 0;
    }
  }
}

function onFinished(round) {
  state.lastFinished = round;
  state.history.unshift(round);
  state.history = state.history.slice(0, 200);
  bumpCounters(round);
  if (onFinishedHook) { try { onFinishedHook(round); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Prédiction : toutes les stratégies actives sont évaluées
// ---------------------------------------------------------------------------
function evaluate() {
  initStrategies();
  syncCostume();
  const out = [];
  for (const def of strategies.LIST) {
    const cfg = state.strategies[def.key];
    if (!cfg || !cfg.enabled) continue;
    const source = def.source === 'live' ? state.live : state.lastFinished;
    if (!source) continue;
    let hit = null;
    try {
      hit = def.detect(source, cfg, { counters: state.counters, games: state.games });
    } catch (e) {
      state.lastError = `${def.key}: ${e.message}`;
      continue;
    }
    if (!hit) continue;
    if (state.predictions.some((p) => p.strategy === def.key && p.target === hit.target)) continue;
    // règle 1 : un jeu déclencheur n'est traité qu'une seule fois
    const trigKey = hit.trigger != null ? `${def.key}:${hit.trigger}` : null;
    if (trigKey && state.triggersDone[trigKey]) continue;
    if (hit.target <= maxFinishedNumber()) {
      // le tour cible est déjà joué (bot lancé en retard) → on marque le
      // déclencheur comme consommé et on attend le suivant, sans rejouer le passé
      if (trigKey) state.triggersDone[trigKey] = true;
      continue;
    }

    const pred = {
      id: `${def.key}-${hit.target}-${Date.now()}`,
      strategy: def.key,
      strategyName: def.name,
      kind: hit.kind,
      target: hit.target,
      suit: hit.suit ? (hit.kind === 'suit' ? normSuit(hit.suit) : hit.suit) : null,
      cardsLabel: hit.cardsLabel || null,
      wantPlayer: hit.wantPlayer != null ? hit.wantPlayer : null,
      wantBanker: hit.wantBanker != null ? hit.wantBanker : null,
      label: hit.label || hit.suit || '',
      reason: hit.reason || '',
      meta: hit.meta || null,
      hand: 'joueur',
      trigger: hit.trigger != null ? hit.trigger : null,
      from: source.number,
      step: 0,
      maxR: cfg.maxR,
      counter: hit.counter != null ? hit.counter : null,
      b: cfg.b || 0,
      format: hit.format || cfg.format,
      template: cfg.template || null,
      sentAt: Date.now(),
      status: 'en attente',
      badge: null,
      result: null,
      hitNumber: null,
      messages: [],
    };
    if (trigKey) state.triggersDone[trigKey] = true;
    state.predictions.unshift(pred);
    out.push(pred);
  }
  state.predictions = state.predictions.slice(0, 300);
  return out;
}

// ---------------------------------------------------------------------------
// Vérification (main du joueur)
// ---------------------------------------------------------------------------
function parityOf(game) {
  if (!game || game.playerValue == null) return null;
  return game.playerValue % 2 === 0 ? 'pair' : 'impair';
}

function matches(pred, game) {
  if (!game) return false;
  if (pred.kind === 'parity') {
    const par = parityOf(game);
    if (!par) return false;
    return par === pred.suit;
  }
  if (pred.kind === 'cards') {
    if (pred.wantPlayer != null && game.playerCards !== pred.wantPlayer) return false;
    if (pred.wantBanker != null && game.bankerCards !== pred.wantBanker) return false;
    return true;
  }
  return hasSuit(game, pred.suit);
}

function resultText(pred, game) {
  if (!game) return null;
  if (pred.kind === 'parity') return `joueur ${game.playerValue ?? '—'} (${parityOf(game) || '—'})`;
  if (pred.kind === 'cards') return `joueur ${game.playerCards}/banquier ${game.bankerCards}`;
  return handSuits(game).join(' ');
}

function verify() {
  const closed = [];
  const maxDone = maxFinishedNumber();
  for (const p of state.predictions) {
    if (p.status !== 'en attente') continue;
    let guard = 0;
    while (p.status === 'en attente' && guard++ <= p.maxR + 2) {
      const num = p.target + p.step;
      const g = state.games.get(num);
      if (!g || !g.finished) {
        // le tour manque dans le flux mais des tours plus récents sont déjà
        // terminés → on ne reste pas bloqué, on passe au rattrapage suivant
        if (num < maxDone && (!g || !g.finished)) {
          if (p.step >= p.maxR) {
            p.status = 'perdu';
            p.badge = '❌';
            p.hitNumber = num;
            closed.push(p);
            break;
          }
          p.step += 1;
          continue;
        }
        break; // le tour est encore en cours : on attend
      }
      if (matches(p, g)) {
        p.status = 'gagné';
        p.badge = BADGES[p.step] || `${p.step}`;
        p.result = resultText(p, g);
        p.hitNumber = num;
        p.game = g;
        closed.push(p);
        break;
      }
      if (p.step >= p.maxR) {
        p.status = 'perdu';
        p.badge = '❌';
        p.result = resultText(p, g);
        p.hitNumber = num;
        p.game = g;
        closed.push(p);
        break;
      }
      p.step += 1;
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Rendu des messages
// ---------------------------------------------------------------------------
function predictionText(p) {
  const g = p.game || null;
  return fmt.renderMessage(p.format || state.format, {
    gameNumber: p.target,
    suit: p.suit,
    cardsLabel: p.cardsLabel,
    strategy: p.strategyName || p.strategy,
    maxR: p.maxR != null ? p.maxR : state.maxR,
    status: p.status,
    rattrapage: p.step,
    playerCards: g ? g.player : null,
  }, p.template || null);
}

function predictionMessage(p) {
  return predictionText(p).text;
}

function liveText() {
  const g = state.live;
  if (!g) return '⚠️ Aucun jeu live détecté pour le moment.';
  return (
    `🔴 *JEU LIVE*\n\n` +
    `🔢 Tour : *#N${g.number}*\n` +
    `✋ Main vérifiée : *joueur*\n` +
    `🃏 Costumes joueur : *${handSuits(g).join(' ') || '—'}*\n` +
    `🂠 Cartes : joueur ${(g.player || []).join(' ') || '—'} (${g.playerCards ?? 0}) / banquier ${(g.banker || []).join(' ') || '—'} (${g.bankerCards ?? 0})\n` +
    `🔟 Valeurs : joueur ${g.playerValue ?? '—'} / banquier ${g.bankerValue ?? '—'}\n` +
    `⏳ Phase : ${g.phase || '—'}\n` +
    `📌 État : ${g.finished ? 'terminé' : g.dealing ? 'distribution en cours' : 'en attente des cartes'}\n` +
    `🔢 Compteurs B (${state.B}) : ${SUITS.map((s) => `${s}${state.counters[s]}`).join(' ')}\n` +
    `🧠 Stratégies actives : ${strategies.LIST.filter((s) => state.strategies[s.key] && state.strategies[s.key].enabled).map((s) => s.name).join(', ') || 'aucune'}\n` +
    `✔️ Dernier tour terminé : ${state.lastFinished ? '#N' + state.lastFinished.number : '—'}`
  );
}

function recentGames(limit = 30) {
  return [...state.games.values()].sort((a, b) => b.number - a.number).slice(0, limit);
}

// état courant de la stratégie Pair / Impair (mémoire du moteur, règle 11)
function parityRuntime() {
  const cfg = state.strategies.parite || strategies.defaultsFor('parite');
  const { start, varN, dec } = strategies.normParity(cfg);
  const current = maxFinishedNumber() || (state.live ? state.live.number : 0);
  const last = current >= start ? strategies.lastTriggerAtOrBefore(current, start, varN) : null;
  const next = current >= start ? strategies.nextTriggerAfter(current, start, varN) : start;
  const pending = state.predictions.find((p) => p.strategy === 'parite' && p.status === 'en attente') || null;
  const done = state.predictions.filter((p) => p.strategy === 'parite');
  return {
    enabled: !!cfg.enabled,
    startGame: start,
    varStep: varN,
    varLeft: last != null ? strategies.varCounterAt(strategies.triggerIndexOf(last, start, varN), varN) : varN,
    decalage: dec,
    maxR: cfg.maxR,
    format: cfg.format,
    currentGame: current || null,
    lastTrigger: last,
    nextTrigger: next,
    sequence: strategies.triggerSequence(start, varN, 12, current || null),
    prediction: pending
      ? { target: pending.target, parity: pending.suit, trigger: pending.trigger, step: pending.step, maxR: pending.maxR }
      : null,
    lastClosed: done.find((p) => p.status !== 'en attente') || null,
  };
}

// ---------------------------------------------------------------------------
// Bilan envoyé sur Telegram quand le jeu reprend
// ---------------------------------------------------------------------------
function bilanText(key) {
  const s = stats(key);
  return (
    '📊 STATISTIQUE 📈\n\n\n' +
    `🟢 GAIN : ${s.win}\n` +
    `🔴 PERTE : ${s.loss}\n\n\n` +
    `✅ Taux de réussite : ${s.rate} %`
  );
}

// catégories lisibles d'un tour (vue « bot » du panel)
function gameCategories(g) {
  if (!g) return [];
  const out = [];
  out.push({ label: 'Tour', value: '#N' + g.number, tone: 'info' });
  out.push({
    label: 'Résultat',
    value: g.winner || (g.finished ? '—' : 'en cours'),
    tone: g.winner === 'Joueur' ? 'win' : g.winner === 'Banquier' ? 'loss' : 'wait',
  });
  out.push({ label: 'Costumes joueur', value: handSuits(g).join(' ') || '—', tone: 'suit' });
  out.push({ label: 'Points', value: `J ${g.playerValue ?? '—'} / B ${g.bankerValue ?? '—'}`, tone: 'info' });
  out.push({ label: 'Parité joueur', value: parityOf(g) || '—', tone: 'info' });
  out.push({ label: 'Cartes', value: `${g.playerCards ?? 0}/${g.bankerCards ?? 0}`, tone: 'info' });
  out.push({
    label: 'Phase',
    value: g.finished ? 'terminé' : g.dealing ? 'distribution' : 'attente',
    tone: g.finished ? 'done' : 'live',
  });
  return out;
}

// jeux vus par une stratégie (live + tours récents + prédiction liée)
function strategyGames(key, limit = 12) {
  const rows = recentGames(limit).map((g) => ({
    number: g.number,
    finished: !!g.finished,
    dealing: !!g.dealing,
    winner: g.winner || null,
    player: g.player || [],
    banker: g.banker || [],
    playerSuits: handSuits(g),
    playerValue: g.playerValue ?? null,
    bankerValue: g.bankerValue ?? null,
    playerCards: g.playerCards ?? null,
    bankerCards: g.bankerCards ?? null,
    parity: parityOf(g),
    phase: g.phase || null,
    categories: gameCategories(g),
    prediction: (() => {
      const p = state.predictions.find((x) => x.strategy === key && x.target === g.number);
      return p ? { label: p.label, status: p.status, badge: p.badge, step: p.step, maxR: p.maxR } : null;
    })(),
  }));
  const live = state.live
    ? { number: state.live.number, categories: gameCategories(state.live), phase: state.live.phase || null,
        playerSuits: handSuits(state.live), player: state.live.player || [], banker: state.live.banker || [],
        playerValue: state.live.playerValue ?? null, bankerValue: state.live.bankerValue ?? null,
        finished: !!state.live.finished, dealing: !!state.live.dealing }
    : null;
  return { live, games: rows, bilan: bilanText(key) };
}

function stats(key) {
  const list = key ? state.predictions.filter((p) => p.strategy === key) : state.predictions;
  const done = list.filter((p) => p.status !== 'en attente');
  const win = done.filter((p) => p.status === 'gagné').length;
  return {
    total: list.length,
    win,
    loss: done.length - win,
    pending: list.length - done.length,
    rate: done.length ? Math.round((win / done.length) * 100) : 0,
  };
}

module.exports = {
  state,
  SUITS,
  evaluate,
  verify,
  registerGames,
  setOnFinished,
  suitForNumber,
  nextTarget,
  handSuits,
  hasSuit,
  predictionText,
  predictionMessage,
  liveText,
  recentGames,
  stats,
  BADGES,
  parityOf,
  parityRuntime,
  initStrategies,
  strategyConfig,
  setStrategyConfig,
  resetStrategy,
  strategyChannels,
  strategyGames,
  gameCategories,
  bilanText,
  parseChannels,
  syncCostume,
  pullCostume,
};
