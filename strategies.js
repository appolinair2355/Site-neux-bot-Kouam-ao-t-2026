// strategies.js — catalogue des stratégies de prédiction (main du JOUEUR uniquement)
//
// Chaque stratégie expose :
//   key         identifiant technique (clé en base de données)
//   name        nom affiché
//   about       explication de la règle
//   defaults    configuration par défaut (format, rattrapages, lead, …)
//   detect(g)   analyse un tour terminé et renvoie une prédiction ou null
//
// Deux natures de prédiction :
//   kind: 'suit'  → on vérifie qu'un costume apparaît dans la main du JOUEUR
//   kind: 'cards' → on vérifie le nombre de cartes (ex: joueur 3 / banquier 3)
'use strict';

const config = require('./config');

const SUITS = ['♦️', '❤️', '♣️', '♠️'];

// table des inverses (Stratégie Dominant)
const INVERSE = { '❤️': '♣️', '♣️': '❤️', '♦️': '♠️', '♠️': '♦️' };

// normalisation d'un costume : '❤' '♥' '♥️' → '❤️'
function normSuit(s) {
  if (!s) return null;
  const raw = String(s).replace(/\uFE0F/g, '').trim();
  if (raw === '♥' || raw === '❤') return '❤️';
  if (raw === '♦') return '♦️';
  if (raw === '♣') return '♣️';
  if (raw === '♠') return '♠️';
  return null;
}

const suitsOf = (list) => (list || []).map(normSuit).filter(Boolean);

// ---------------------------------------------------------------------------
// 1) Costume par numéro (stratégie historique)
// ---------------------------------------------------------------------------
function suitForNumber(n) {
  return normSuit(config.SUIT_BY_LAST_DIGIT[n % 10]) || null;
}

const costume = {
  key: 'costume',
  name: 'Costume par numéro',
  about:
    "Le costume est imposé par le dernier chiffre du numéro de tour " +
    "(2→♦️, 5→❤️, 6→♣️, 9→♠️). Le compteur B bloque la prédiction quand " +
    "le costume est déjà en pleine série. Vérification sur la main du joueur.",
  defaults: { enabled: true, format: config.DEFAULT_FORMAT, maxR: config.DEFAULT_MAX_R, b: config.DEFAULT_B, lead: config.LEAD, template: null, channels: [] },
  usesB: true,
  // pour cette stratégie on analyse le tour LIVE (prédiction 2 tours à l'avance)
  source: 'live',
  detect(game, cfg, ctx) {
    if (!game) return null;
    const target = game.number + (cfg.lead || config.LEAD);
    const suit = suitForNumber(target);
    if (!suit) return null;
    const counters = (ctx && ctx.counters) || {};
    if ((counters[suit] || 0) >= (cfg.b || config.DEFAULT_B)) return null; // série en cours
    return {
      kind: 'suit',
      target,
      suit,
      label: suit,
      counter: counters[suit] || 0,
      reason: `costume imposé par le numéro ${target}`,
    };
  },
};

// ---------------------------------------------------------------------------
// 2) Dominant Baccarat — filtre 3/3, mélange des 6 cartes, on joue l'INVERSE
// ---------------------------------------------------------------------------
function dominantOf(sixSuits) {
  const count = { '♦️': 0, '❤️': 0, '♣️': 0, '♠️': 0 };
  for (const s of sixSuits) if (count[s] != null) count[s] += 1;
  const values = Object.values(count).sort((a, b) => b - a);
  const max = values[0];
  // dominant fort : au moins 2 fois ET pas d'égalité avec une autre couleur
  if (max < 2) return { count, dominant: null, reason: '1-1-1-1 : aucun signal' };
  if (values[1] === max) return { count, dominant: null, reason: `${values.join('-')} : égalité instable` };
  const dominant = Object.keys(count).find((k) => count[k] === max) || null;
  return { count, dominant, reason: `configuration ${values.join('-')} valide` };
}

const dominant = {
  key: 'dominant',
  name: 'Dominant Baccarat',
  about:
    "Filtre obligatoire : joueur 3 cartes ET banquier 3 cartes. On mélange les " +
    "6 cartes, on compte les couleurs. S'il y a un dominant fort (une couleur " +
    "au moins 2 fois, sans égalité), on joue TOUJOURS son inverse " +
    "(♥️↔♣️, ♦️↔♠️) sur le tour +2. Vérification sur la main du joueur.",
  defaults: { enabled: true, format: 1, maxR: 2, b: 0, lead: 2, template: null, channels: [] },
  usesB: false,
  source: 'finished',
  detect(game, cfg) {
    if (!game || !game.finished) return null;
    if (game.playerCards !== 3 || game.bankerCards !== 3) return null; // filtre obligatoire
    const six = [...suitsOf(game.playerSuits), ...suitsOf(game.bankerSuits)];
    if (six.length !== 6) return null;
    const { count, dominant: dom, reason } = dominantOf(six);
    if (!dom) return null;
    const suit = INVERSE[dom];
    if (!suit) return null;
    return {
      kind: 'suit',
      target: game.number + (cfg.lead || 2),
      suit,
      label: suit,
      reason: `dominant ${dom} (${reason}) → inverse ${suit}`,
      meta: { dominant: dom, count },
    };
  },
};

// ---------------------------------------------------------------------------
// 3) Match nul — égalité de points : somme > 5 → distribution (+1), sinon 3/3 (+2)
// ---------------------------------------------------------------------------
const matchnul = {
  key: 'matchnul',
  name: 'Match nul (points égaux)',
  about:
    "Quand les points du joueur sont égaux à ceux du banquier (match nul), on " +
    "additionne les deux points. Somme > 5 → on prédit une DISTRIBUTION au tour " +
    "+1 (joueur 2 cartes et banquier 2 cartes). Sinon → on prédit 3 cartes " +
    "joueur et 3 cartes banquier au tour +2.",
  defaults: { enabled: true, format: 78, formatDistribution: 79, maxR: 2, b: 0, lead: 1, template: null, channels: [] },
  usesB: false,
  source: 'finished',
  detect(game, cfg) {
    if (!game || !game.finished) return null;
    const pv = game.playerValue;
    const bv = game.bankerValue;
    if (pv == null || bv == null) return null;
    if (pv !== bv) return null;                       // uniquement les matchs nuls
    const sum = pv + bv;
    if (sum > 5) {
      return {
        kind: 'cards',
        target: game.number + 1,
        wantPlayer: 2,
        wantBanker: 2,
        cardsLabel: '2/2',
        suit: 'deux',
        label: 'distribution 2/2',
        format: cfg.formatDistribution || 79,
        reason: `match nul ${pv}=${bv}, somme ${sum} > 5 → distribution au +1`,
      };
    }
    return {
      kind: 'cards',
      target: game.number + 2,
      wantPlayer: 3,
      wantBanker: 3,
      cardsLabel: '3/3',
      suit: 'trois',
      label: '3 cartes / 3 cartes',
      reason: `match nul ${pv}=${bv}, somme ${sum} ≤ 5 → 3/3 au +2`,
    };
  },
};


// ---------------------------------------------------------------------------
// 4) Pair / Impair (VAR) — séquence de déclencheurs Jeu de départ + VAR
// ---------------------------------------------------------------------------
// Séquence : trigger(0) = jeu de départ, puis chaque pas vaut +10, sauf tous
// les VAR pas où le pas vaut +9 (décalage de -1 imposé par la remise à zéro
// du compteur VAR).  Exemple start=1, VAR=2 :
//   1 → 11 → 20 → 30 → 39 → 49 → 58 → 68 → 77 → 87 → 96 → 106 …
//   (écarts 10, 9, 10, 9, 10, 9 …)
// Formule fermée : trigger(n) = start + 10n - floor(n / VAR)   (VAR ≥ 1)
function normParity(cfg = {}) {
  const start = Math.max(1, parseInt(cfg.startGame, 10) || 1);
  const varN = Math.max(0, parseInt(cfg.varStep, 10) || 0);
  const dec = Math.max(1, parseInt(cfg.decalage, 10) || 1);
  return { start, varN, dec };
}

function triggerAt(n, start, varN) {
  if (n < 0) return null;
  return start + 10 * n - (varN >= 1 ? Math.floor(n / varN) : 0);
}

// index du déclencheur si `number` appartient à la séquence, sinon -1
function triggerIndexOf(number, start, varN) {
  if (number < start) return -1;
  const cycle = varN >= 1 ? 10 * varN - 1 : 10 * 1; // avance par cycle complet
  let n = varN >= 1 ? Math.max(0, Math.floor(((number - start) / cycle) * varN) - varN - 2) : Math.max(0, Math.floor((number - start) / 10) - 1);
  let guard = 0;
  while (guard++ < 100000) {
    const v = triggerAt(n, start, varN);
    if (v === number) return n;
    if (v > number) return -1;
    n += 1;
  }
  return -1;
}

// dernier déclencheur <= number (null si la séquence n'a pas encore commencé)
function lastTriggerAtOrBefore(number, start, varN) {
  if (number < start) return null;
  const cycle = varN >= 1 ? 10 * varN - 1 : 10;
  let n = varN >= 1 ? Math.max(0, Math.floor(((number - start) / cycle) * varN) - varN - 2) : Math.max(0, Math.floor((number - start) / 10) - 1);
  let last = start;
  let guard = 0;
  while (guard++ < 100000) {
    const v = triggerAt(n, start, varN);
    if (v > number) break;
    last = v;
    n += 1;
  }
  return last;
}

function nextTriggerAfter(number, start, varN) {
  const last = lastTriggerAtOrBefore(number, start, varN);
  if (last == null) return start;
  const idx = triggerIndexOf(last, start, varN);
  return triggerAt(idx + 1, start, varN);
}

// séquence lisible (utilisée par /parite et le panel web)
function triggerSequence(start, varN, count = 12, from = null) {
  const out = [];
  let n = from == null ? 0 : Math.max(0, triggerIndexOf(lastTriggerAtOrBefore(from, start, varN), start, varN));
  for (let i = 0; i < count; i++) out.push(triggerAt(n + i, start, varN));
  return out;
}

// VAR restant affiché : VAR, VAR-1, … 0 puis nouveau cycle
function varCounterAt(index, varN) {
  if (varN < 1) return 0;
  return varN - (index % varN);
}

const parite = {
  key: 'parite',
  name: 'Pair / Impair (VAR)',
  about:
    "Jeu de départ + VAR + Décalage + Rattrapage. Le bot calcule la séquence " +
    "des jeux déclencheurs (ex. départ 1 / VAR 2 → 1, 11, 20, 30, 39, 49, 58 …). " +
    "Sur chaque déclencheur il lit le POINT DU JOUEUR : point pair → prédiction " +
    "IMPAIR, point impair → prédiction PAIR. Le jeu cible est déclencheur + " +
    "décalage, et la vérification porte sur la parité du point du joueur du jeu " +
    "cible, puis sur les rattrapages configurés. Au redémarrage la séquence est " +
    "reconstruite mathématiquement : le bot attend simplement le prochain " +
    "déclencheur, sans rejouer le passé.",
  defaults: {
    enabled: true,
    format: 80,
    maxR: 3,
    b: 0,
    lead: 1,
    startGame: 1,
    varStep: 2,
    decalage: 1,
    template: null,
    channels: [],
  },
  usesB: false,
  source: 'finished',
  detect(game, cfg, ctx) {
    if (!game || !game.finished) return null;
    const { start, varN, dec } = normParity(cfg);
    if (game.number < start) return null;                 // pas encore démarré
    const trig = lastTriggerAtOrBefore(game.number, start, varN);
    if (trig == null) return null;
    const src = trig === game.number ? game : (ctx && ctx.games ? ctx.games.get(trig) : null);
    if (!src || !src.finished) return null;               // déclencheur manquant → on saute
    const pv = src.playerValue;
    if (pv == null) return null;
    const pair = pv % 2 === 0;
    const suit = pair ? 'impair' : 'pair';                // règle 7 : on inverse
    const idx = triggerIndexOf(trig, start, varN);
    return {
      kind: 'parity',
      target: trig + dec,
      suit,
      label: suit === 'pair' ? 'PAIR' : 'IMPAIR',
      trigger: trig,
      reason:
        `déclencheur #N${trig} • point joueur ${pv} (${pair ? 'pair' : 'impair'}) → ` +
        `prédiction ${suit.toUpperCase()} sur #N${trig + dec} (décalage ${dec})`,
      meta: {
        trigger: trig,
        index: idx,
        playerValue: pv,
        varLeft: varCounterAt(idx, varN),
        nextTrigger: nextTriggerAfter(trig, start, varN),
        start, varN, dec,
      },
    };
  },
};

const LIST = [costume, dominant, matchnul, parite];
const BY_KEY = Object.fromEntries(LIST.map((s) => [s.key, s]));

function defaultsFor(key) {
  const s = BY_KEY[key];
  if (!s) return null;
  // token / canal / bilan : réglables stratégie par stratégie
  return { token: null, bilan: true, ...JSON.parse(JSON.stringify(s.defaults)) };
}

function catalog() {
  return LIST.map((s) => ({ key: s.key, name: s.name, about: s.about, usesB: !!s.usesB, defaults: s.defaults }));
}

module.exports = {
  LIST, BY_KEY, SUITS, INVERSE, normSuit, suitsOf, suitForNumber, dominantOf, defaultsFor, catalog,
  normParity, triggerAt, triggerIndexOf, lastTriggerAtOrBefore, nextTriggerAfter, triggerSequence, varCounterAt,
};
