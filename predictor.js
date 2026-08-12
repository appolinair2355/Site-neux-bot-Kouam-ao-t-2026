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
  sendErrors: {},          // clé de stratégie -> dernière erreur d'envoi Telegram
  gates: {},               // clé de stratégie -> filtre d'envoi « double perte »
  startedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// Configuration des stratégies
// ---------------------------------------------------------------------------
function initStrategies() {
  for (const s of strategies.LIST) {
    const def = strategies.defaultsFor(s.key);
    const cur = state.strategies[s.key];
    if (!cur) { state.strategies[s.key] = def; continue; }
    // une configuration enregistrée avant l'ajout d'un réglage (mode silencieux,
    // fenêtre de pertes…) est complétée sans écraser les choix de l'utilisateur
    for (const [k, v] of Object.entries(def)) if (cur[k] === undefined) cur[k] = v;
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
// Accepte les identifiants numériques (-1001234567890) ET les noms publics
// (@mon_canal) : Telegram gère les deux comme chat_id.
function parseChannels(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n) && n !== 0 && !out.includes(n)) out.push(n);
    } else {
      const name = t.startsWith('@') ? t : `@${t.replace(/^https?:\/\/t\.me\//i, '')}`;
      if (name.length > 2 && !out.includes(name)) out.push(name);
    }
  }
  return out;
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
  // stratégie « Carte absente » : nombre de jeux consécutifs sans le costume
  if (patch.streak !== undefined) next.streak = Math.max(2, Math.min(10, parseInt(patch.streak, 10) || 3));
  // stratégie « Prédiction dans l'ombre » : jeux d'absence minimum + périmètre
  if (patch.absence !== undefined) next.absence = Math.max(1, Math.min(30, parseInt(patch.absence, 10) || 4));
  if (patch.scope !== undefined) next.scope = patch.scope === 'joueur' ? 'joueur' : 'tous';
  // mode silencieux (commun à toutes les stratégies)
  if (patch.silent !== undefined) next.silent = !!patch.silent;
  if (patch.lossWindow !== undefined) next.lossWindow = Math.max(1, Math.min(20, parseInt(patch.lossWindow, 10) || 3));
  if (patch.resetOnWin !== undefined) next.resetOnWin = !!patch.resetOnWin;
  if (patch.template !== undefined) next.template = patch.template ? String(patch.template) : null;
  if (patch.channels !== undefined || patch.channelId !== undefined) {
    const before = JSON.stringify(next.channels || []);
    next.channels = parseChannels(patch.channels !== undefined ? patch.channels : patch.channelId);
    // le canal a changé → les informations affichées sont recalculées
    if (JSON.stringify(next.channels) !== before) next.channelInfos = [];
  }
  if (patch.channelInfos !== undefined) next.channelInfos = patch.channelInfos || [];
  // un seul token API pour toute l'application (réglages) : plus de token par stratégie
  delete next.token;
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
// Filtre d'envoi « double perte » (mode silencieux)
// ---------------------------------------------------------------------------
// Tant que le mode silencieux est actif, la stratégie travaille dans l'ombre :
// elle calcule et vérifie ses prédictions SANS rien envoyer dans le canal.
//   1) une 1ʳᵉ perte ouvre une fenêtre de vérification ;
//   2) la fenêtre autorise au MAXIMUM `lossWindow` prédictions terminées ;
//   3) si une 2ᵉ perte tombe dans cette fenêtre → l'envoi est ACTIVÉ
//      (perte+perte = 1 prédiction dans la fenêtre, perte/gagné/perte = 2…) ;
//   4) si la fenêtre est dépassée sans 2ᵉ perte → tout repart à zéro ;
//   5) une fois l'envoi activé, une prédiction gagnée referme l'envoi
//      (réglage `resetOnWin`, activé par défaut) et on repart à zéro.
function gate(key) {
  if (!state.gates[key]) state.gates[key] = { armed: false, losses: 0, window: 0, since: null };
  return state.gates[key];
}

function resetGate(key) {
  state.gates[key] = { armed: false, losses: 0, window: 0, since: null };
  return state.gates[key];
}

function windowSize(cfg) {
  return Math.max(1, Math.min(20, parseInt(cfg && cfg.lossWindow, 10) || 3));
}

// mise à jour du filtre à chaque prédiction terminée
function noteClosed(pred) {
  const cfg = state.strategies[pred.strategy];
  if (!cfg) return;
  const g = gate(pred.strategy);
  const win = pred.status === 'gagné';
  const max = windowSize(cfg);

  if (g.armed) {
    if (win && cfg.resetOnWin !== false) resetGate(pred.strategy);
    else if (!win) { g.losses = 2; g.window = 0; }
    return;
  }
  if (g.losses === 0) {
    if (!win) { g.losses = 1; g.window = 0; g.since = pred.target; }
    return;
  }
  // fenêtre ouverte après la 1ʳᵉ perte
  g.window += 1;
  if (!win) { g.losses = 2; g.armed = true; g.window = 0; return; }
  if (g.window >= max) resetGate(pred.strategy);
}

// une prédiction de cette stratégie peut-elle partir dans le canal ?
function canSend(key) {
  const cfg = state.strategies[key];
  if (!cfg) return true;
  if (!cfg.silent) return true;
  return !!gate(key).armed;
}

// état lisible du filtre (panel web / Telegram)
function gateView(key) {
  const cfg = state.strategies[key] || {};
  const g = gate(key);
  const max = windowSize(cfg);
  return {
    silent: !!cfg.silent,
    lossWindow: max,
    resetOnWin: cfg.resetOnWin !== false,
    armed: !!g.armed,
    losses: g.losses,
    used: g.window,
    left: g.losses === 1 ? Math.max(0, max - g.window) : null,
    sending: canSend(key),
    label: !cfg.silent
      ? 'Envoi direct (mode silencieux désactivé)'
      : g.armed
        ? "Envoi ACTIF : deux pertes confirmées"
        : g.losses === 1
          ? `Fenêtre ouverte : ${g.window}/${max} prédiction(s) — on attend une 2ᵉ perte`
          : "Silence : on attend une première perte",
  };
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
  // CORRECTIF : l'API renvoie les jeux du plus RÉCENT au plus ancien. Il faut les
  // traiter dans l'ordre CROISSANT, sinon « lastFinished » devient le jeu le plus
  // ancien : toutes les cibles calculées semblent déjà jouées et AUCUNE
  // prédiction ne sort jamais.
  const ordered = [...games].sort((a, b) => a.number - b.number);
  for (const g of ordered) {
    const prev = state.games.get(g.number);
    state.games.set(g.number, g);
    if (g.finished && (!prev || !prev.finished)) onFinished(g);
  }
  if (state.games.size > 600) {
    const keys = [...state.games.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, state.games.size - 600)) state.games.delete(k);
  }
  // sécurité : le dernier tour terminé est TOUJOURS le plus grand numéro terminé
  const maxDone = maxFinishedNumber();
  if (maxDone && (!state.lastFinished || state.lastFinished.number !== maxDone)) {
    const g = state.games.get(maxDone);
    if (g) state.lastFinished = g;
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
  // CORRECTIF : state.predictions est trié du plus récent au plus ancien.
  // Le filtre « double perte » doit voir les résultats dans l'ordre CHRONOLOGIQUE,
  // sinon la fenêtre après une perte est comptée à l'envers.
  const queue = [...state.predictions].sort((a, b) => a.target - b.target);
  for (const p of queue) {
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
            noteClosed(p);
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
        noteClosed(p);
        closed.push(p);
        break;
      }
      if (p.step >= p.maxR) {
        p.status = 'perdu';
        p.badge = '❌';
        p.result = resultText(p, g);
        p.hitNumber = num;
        p.game = g;
        noteClosed(p);
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
function gameView(g, key) {
  return {
    number: g.number,
    finished: !!g.finished,
    dealing: !!g.dealing,
    winner: g.winner || null,
    player: g.player || [],
    banker: g.banker || [],
    playerSuits: handSuits(g),
    bankerSuits: strategies.suitsOf(g.bankerSuits),
    playerValue: g.playerValue ?? null,
    bankerValue: g.bankerValue ?? null,
    playerCards: g.playerCards ?? null,
    bankerCards: g.bankerCards ?? null,
    tie: g.playerValue != null && g.bankerValue != null && g.playerValue === g.bankerValue,
    sum: g.playerValue != null && g.bankerValue != null ? g.playerValue + g.bankerValue : null,
    parity: parityOf(g),
    phase: g.phase || null,
    phaseLabel: g.finished ? 'terminé' : g.dealing ? 'distribution en cours' : 'à venir',
    categories: gameCategories(g),
    prediction: (() => {
      const p = state.predictions.find((x) => x.strategy === key && x.target === g.number);
      return p ? { label: p.label, status: p.status, badge: p.badge, step: p.step, maxR: p.maxR } : null;
    })(),
  };
}

// compteur par costume (panneau « Compteur » du tableau de bord)
function counterView() {
  const b = state.B || 1;
  return SUITS.map((s) => ({
    suit: s,
    count: state.counters[s] || 0,
    b,
    ratio: Math.min(100, Math.round(((state.counters[s] || 0) / b) * 100)),
  }));
}

function strategyGames(key, limit = 12) {
  const rows = recentGames(limit).map((g) => gameView(g, key));
  const live = state.live ? gameView(state.live, key) : null;
  // parties à venir : tours connus, non terminés, après le tour live
  const upcoming = [...state.games.values()]
    .filter((g) => !g.finished && (!live || g.number > live.number))
    .sort((a, b) => a.number - b.number)
    .slice(0, 4)
    .map((g) => gameView(g, key));
  return { live, upcoming, games: rows, counters: counterView(), stats: stats(key), bilan: bilanText(key), gate: gateView(key) };
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


// état courant de la stratégie « Prédiction dans l'ombre » (costumes surveillés)
function shadowRuntime() {
  const cfg = state.strategies.ombre || strategies.defaultsFor('ombre');
  const need = Math.max(1, parseInt(cfg.absence, 10) || 4);
  const scope = cfg.scope === 'joueur' ? 'joueur' : 'tous';
  const last = maxFinishedNumber();
  const suits = SUITS.map((suit) => {
    let gap = 0;
    for (let n = last; n >= 1; n--) {
      const g = state.games.get(n);
      if (!g || !g.finished) break;
      const list = scope === 'joueur'
        ? strategies.suitsOf(g.playerSuits)
        : [...strategies.suitsOf(g.playerSuits), ...strategies.suitsOf(g.bankerSuits)];
      if (list.includes(suit)) break;
      gap += 1;
    }
    return { suit, absence: gap, watched: gap >= need };
  });
  return {
    enabled: !!cfg.enabled,
    absence: need,
    lead: cfg.lead,
    scope,
    lastGame: last || null,
    suits,
    gate: gateView('ombre'),
    prediction: state.predictions.find((p) => p.strategy === 'ombre' && p.status === 'en attente') || null,
  };
}

// ---------------------------------------------------------------------------
// Panneau « Prédictions » du site : chaque prédiction est listée séparément,
// avec son mode (silencieuse = calculée dans l'ombre, publiée = envoyée dans le
// canal Telegram). Les prédictions silencieuses restent donc VISIBLES sur le
// site même si elles ne partent pas dans le canal.
// ---------------------------------------------------------------------------
function predictionRow(p) {
  return {
    id: p.id,
    strategy: p.strategy,
    strategyName: p.strategyName || p.strategy,
    target: p.target,
    trigger: p.trigger != null ? p.trigger : null,
    label: p.label || p.suit || '',
    suit: p.suit || null,
    kind: p.kind,
    status: p.status,
    badge: p.badge,
    step: p.step,
    maxR: p.maxR,
    reason: p.reason || '',
    format: p.format,
    silent: !!p.silent,
    published: !p.silent && (p.messages || []).length > 0,
    channels: (p.messages || []).map((m) => m.chatId),
    gate: p.gate || null,
    createdAt: p.sentAt || null,
    text: predictionMessage(p),
  };
}

function predictionsPanel(limit = 60) {
  const all = state.predictions.map(predictionRow);
  const byStrategy = {};
  for (const def of strategies.LIST) {
    const rows = all.filter((r) => r.strategy === def.key);
    byStrategy[def.key] = {
      key: def.key,
      name: def.name,
      silentMode: !!(state.strategies[def.key] && state.strategies[def.key].silent),
      gate: gateView(def.key),
      stats: stats(def.key),
      silent: rows.filter((r) => r.silent).slice(0, limit),
      published: rows.filter((r) => !r.silent).slice(0, limit),
    };
  }
  return {
    total: all.length,
    silentCount: all.filter((r) => r.silent).length,
    publishedCount: all.filter((r) => !r.silent).length,
    pending: all.filter((r) => r.status === 'en attente'),
    silent: all.filter((r) => r.silent).slice(0, limit),
    published: all.filter((r) => !r.silent).slice(0, limit),
    all: all.slice(0, limit),
    byStrategy,
    stats: stats(),
  };
}

module.exports = {
  state,
  SUITS,
  predictionRow,
  predictionsPanel,
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
  gameView,
  counterView,
  bilanText,
  parseChannels,
  canSend,
  gateView,
  resetGate,
  noteClosed,
  shadowRuntime,
  syncCostume,
  pullCostume,
};
