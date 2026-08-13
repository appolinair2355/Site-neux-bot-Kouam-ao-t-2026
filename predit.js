// predit.js — panneau « Prédit » : prédictions automatiques 100% sûres
//
//  • L'IA analyse les jeux en continu (pattern-miner + résultats réels des
//    stratégies existantes).
//  • Dès qu'une règle atteint 100% de réussite sur un échantillon suffisant,
//    elle est CERTIFIÉE et entre dans ce panneau.
//  • Chaque prédiction d'une règle certifiée est publiée dans le canal Telegram
//    du panneau « Prédit ».
//  • Si une deuxième règle atteint aussi 100% et que la première reste à 100%,
//    LES DEUX prédisent automatiquement ensemble. Quand elles visent le même
//    jeu avec le même costume, le message part en « double confirmation ».
//  • Dès qu'une règle certifiée perd (elle n'est plus à 100%), elle est retirée
//    automatiquement du panneau.
'use strict';

const miner = require('./pattern-miner');
const strategies = require('./strategies');
const store = require('./store');
const { state, stats } = require('./predictor');

const SUITS = ['♦️', '❤️', '♣️', '♠️'];

const panel = {
  enabled: true,
  channels: [],        // canaux Telegram du panneau
  minSample: 6,        // observations minimum pour certifier une règle à 100%
  maxR: 1,             // rattrapages autorisés sur une prédiction du panneau
  requireCombo: false, // n'envoyer QUE les prédictions confirmées par 2 règles
  certified: [],       // règles actuellement à 100%
  retired: [],         // règles retirées (elles ont perdu leur 100%)
  predictions: [],     // prédictions du panneau (les 120 dernières)
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
};

let sender = null;
function setSender(fn) { sender = fn; }

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function parseChannels(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
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

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.requireCombo !== undefined) panel.requireCombo = !!patch.requireCombo;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  if (patch.minSample !== undefined) panel.minSample = Math.max(3, Math.min(60, parseInt(patch.minSample, 10) || 6));
  if (patch.maxR !== undefined) panel.maxR = Math.max(0, Math.min(5, parseInt(patch.maxR, 10) || 0));
  persist();
  return config();
}

function config() {
  return {
    enabled: panel.enabled,
    channels: panel.channels,
    minSample: panel.minSample,
    maxR: panel.maxR,
    requireCombo: panel.requireCombo,
  };
}

function persist() {
  try { store.patch({ predit: config() }); } catch (_) {}
}

function restore() {
  try {
    const saved = (store.read() || {}).predit;
    if (saved) configure({ ...saved });
  } catch (_) {}
  return config();
}

// ---------------------------------------------------------------------------
// Lecture des jeux
// ---------------------------------------------------------------------------
function orderedGames() {
  return miner.normalize(state.history || []);
}

function suitsOf(game) {
  return strategies.suitsOf(game && game.playerSuits ? game.playerSuits : []);
}

function cardTokens(game, hand) {
  const cards = hand === 'banquier' ? (game.bankerCards || []) : (game.playerCards || []);
  const out = new Set();
  for (const card of cards) {
    const text = String(card || '');
    const suit = SUITS.find((s) => text.includes(s.charAt(0)));
    if (!suit) continue;
    const rank = text.replace(suit, '').replace(/\uFE0F/g, '').trim() || '?';
    out.add(`${rank}${suit}`);
  }
  return out;
}

// la règle est-elle déclenchée par ce jeu ?
function triggered(rule, game) {
  if (!rule || !game) return false;
  if (rule.kind === 'carte') return cardTokens(game, rule.hand).has(rule.token);
  if (rule.kind === 'point') return game.playerValue != null && Number(game.playerValue) === Number(rule.value);
  if (rule.kind === 'chaine') return suitsOf(game).includes(rule.token);
  return false;
}

// ---------------------------------------------------------------------------
// Certification : une règle n'entre ici QUE si elle est à 100%
// ---------------------------------------------------------------------------
function certifyDiscoveries(games) {
  const found = miner.mine(state.history || [], { lead: 2 });
  const list = (found.discoveries || []).filter(
    (d) => d.rule && Number(d.rate) >= 100 && Number(d.support || 0) >= panel.minSample,
  );
  for (const d of list) {
    const id = `ia:${d.rule.kind}:${d.rule.hand}:${d.rule.token}:${d.rule.k}:${d.rule.suit}`;
    if (panel.retired.some((r) => r.id === id)) continue;
    const existing = panel.certified.find((c) => c.id === id);
    if (existing) {
      existing.rate = d.rate;
      existing.sample = d.support;
      continue;
    }
    panel.certified.push({
      id,
      type: 'ia',
      name: (d.proposal && d.proposal.name) || d.finding,
      finding: d.finding,
      rule: d.rule,
      rate: d.rate,
      sample: d.support,
      win: 0,
      loss: 0,
      certifiedAt: new Date().toISOString(),
    });
  }
  return panel.certified;
}

// stratégies existantes qui affichent 100% de réussite réelle
function certifyStrategies() {
  for (const def of strategies.LIST) {
    const st = stats(def.key);
    const done = st.win + st.loss;
    const id = `strat:${def.key}`;
    const existing = panel.certified.find((c) => c.id === id);
    const perfect = done >= panel.minSample && st.loss === 0 && st.rate >= 100;
    if (perfect && !existing && !panel.retired.some((r) => r.id === id)) {
      panel.certified.push({
        id,
        type: 'strategie',
        key: def.key,
        name: def.name,
        finding: `Stratégie « ${def.name} » : ${st.win} gains, 0 perte (100%).`,
        rule: null,
        rate: 100,
        sample: done,
        win: st.win,
        loss: 0,
        certifiedAt: new Date().toISOString(),
      });
    } else if (existing) {
      existing.rate = st.rate;
      existing.sample = done;
      existing.win = st.win;
      existing.loss = st.loss;
      if (st.loss > 0) retire(existing, `La stratégie n'est plus à 100% (${st.rate}%).`);
    }
  }
  return panel.certified;
}

function retire(entry, reason) {
  panel.certified = panel.certified.filter((c) => c.id !== entry.id);
  panel.retired = [{ ...entry, reason, retiredAt: new Date().toISOString() }, ...panel.retired].slice(0, 30);
}

function activeCertified() {
  return panel.certified.filter((c) => c.rate >= 100);
}

// ---------------------------------------------------------------------------
// Prédictions du panneau
// ---------------------------------------------------------------------------
function lastFinishedNumber(games) {
  return games.length ? games[games.length - 1].n : 0;
}

function makePredictions(games) {
  const last = lastFinishedNumber(games);
  if (!last) return [];
  const created = [];
  for (const entry of activeCertified()) {
    if (!entry.rule) continue; // les stratégies existantes passent par mirror()
    for (let i = games.length - 1; i >= 0 && i >= games.length - 6; i -= 1) {
      const g = games[i];
      if (!triggered(entry.rule, g)) continue;
      const target = g.n + entry.rule.k;
      if (target <= last) continue; // le jeu cible est déjà joué
      if (panel.predictions.some((p) => p.source === entry.id && p.target === target)) continue;
      const pred = {
        id: `predit-${entry.id}-${target}`,
        source: entry.id,
        sources: [{ id: entry.id, name: entry.name, rate: entry.rate, sample: entry.sample }],
        sourceName: entry.name,
        trigger: g.n,
        target,
        suit: entry.rule.suit,
        step: 0,
        maxR: panel.maxR,
        status: 'en attente',
        combo: false,
        messages: [],
        createdAt: new Date().toISOString(),
      };
      panel.predictions.unshift(pred);
      created.push(pred);
      break;
    }
  }
  panel.predictions = panel.predictions.slice(0, 120);
  return created;
}

// Deux règles certifiées qui visent le même jeu avec le même costume :
// elles prédisent ensemble (double confirmation).
function mergeCombos(created) {
  const out = [];
  for (const pred of created) {
    const twin = panel.predictions.find(
      (p) => p !== pred && p.target === pred.target && p.suit === pred.suit && p.status === 'en attente',
    );
    if (twin) {
      twin.combo = true;
      twin.sources = [...twin.sources, ...pred.sources];
      panel.predictions = panel.predictions.filter((p) => p !== pred);
      if (!out.includes(twin)) out.push(twin);
      twin.resend = true;
    } else {
      out.push(pred);
    }
  }
  return out;
}

function gameByNumber(games, n) {
  return games.find((g) => g.n === n) || null;
}

function verify(games) {
  const last = lastFinishedNumber(games);
  const closed = [];
  for (const pred of panel.predictions) {
    if (pred.status !== 'en attente') continue;
    let checked = pred.target + pred.step;
    while (checked <= last) {
      const g = gameByNumber(games, checked);
      if (!g) { checked += 1; continue; }
      if (suitsOf(g).includes(pred.suit)) {
        pred.status = 'gagné';
        pred.closedAt = new Date().toISOString();
        closed.push(pred);
        break;
      }
      if (pred.step >= pred.maxR) {
        pred.status = 'perdu';
        pred.closedAt = new Date().toISOString();
        closed.push(pred);
        break;
      }
      pred.step += 1;
      checked += 1;
    }
  }
  // une règle certifiée qui perd sort immédiatement du panneau
  for (const pred of closed) {
    for (const src of pred.sources) {
      const entry = panel.certified.find((c) => c.id === src.id);
      if (!entry) continue;
      if (pred.status === 'gagné') { entry.win += 1; continue; }
      entry.loss += 1;
      entry.rate = 0;
      retire(entry, `Prédiction perdue sur le jeu #N${pred.target} : la règle n'est plus sûre à 100%.`);
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Messages Telegram
// ---------------------------------------------------------------------------
function predictionText(pred) {
  const head = pred.combo ? '🔥 PRÉDIT — DOUBLE CONFIRMATION 100%' : '🎯 PRÉDIT — SIGNAL 100%';
  const sources = pred.sources
    .map((s, i) => `${i + 1}. ${s.name} — ${s.rate}% (${s.sample} observations)`)
    .join('\n');
  const statut = pred.status === 'gagné' ? '✅ GAGNÉ' : pred.status === 'perdu' ? '❌ PERDU' : '⌛ En attente';
  return [
    head,
    '',
    `🎮 Jeu : #N${pred.target}`,
    `🃏 Costume : ${pred.suit}`,
    `♻️ Rattrapages : ${pred.maxR}`,
    pred.combo ? '🤝 Deux stratégies à 100% prédisent ensemble' : '🧠 Stratégie certifiée à 100%',
    '',
    sources,
    '',
    `Statut : ${statut}${pred.step ? ` (rattrapage ${pred.step})` : ''}`,
  ].join('\n');
}

async function send(pred) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return false; }
  if (!panel.channels.length) { panel.lastError = 'Aucun canal configuré pour le panneau Prédit'; return false; }
  const text = predictionText(pred);
  let ok = false;
  for (const id of panel.channels) {
    try {
      const m = await bot.sendMessage(id, text);
      pred.messages.push({ chatId: id, messageId: m.message_id });
      panel.sentCount += 1;
      panel.lastSentAt = Date.now();
      panel.lastError = null;
      ok = true;
    } catch (e) {
      panel.lastError = `${id} : ${e.message}`;
    }
  }
  return ok;
}

async function update(pred) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot || !pred.messages.length) return;
  const text = predictionText(pred);
  for (const m of pred.messages) {
    try { await bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId }); }
    catch (_) {}
  }
}

// prédiction d'une stratégie existante certifiée : elle est reprise ici
async function mirror(pred) {
  if (!panel.enabled) return false;
  const entry = activeCertified().find((c) => c.type === 'strategie' && c.key === pred.strategy);
  if (!entry) return false;
  if (panel.predictions.some((p) => p.source === entry.id && p.target === pred.target)) return false;
  const item = {
    id: `predit-${entry.id}-${pred.target}`,
    source: entry.id,
    sources: [{ id: entry.id, name: entry.name, rate: entry.rate, sample: entry.sample }],
    sourceName: entry.name,
    trigger: pred.trigger != null ? pred.trigger : null,
    target: pred.target,
    suit: pred.suit,
    step: 0,
    maxR: panel.maxR,
    status: 'en attente',
    combo: false,
    messages: [],
    createdAt: new Date().toISOString(),
  };
  panel.predictions.unshift(item);
  const merged = mergeCombos([item]);
  for (const p of merged) {
    if (panel.requireCombo && !p.combo) continue;
    await send(p);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Boucle
// ---------------------------------------------------------------------------
let busy = false;
async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    const games = orderedGames();
    certifyStrategies();
    if (games.length >= 12) certifyDiscoveries(games);
    const closed = verify(games);
    for (const pred of closed) await update(pred);
    const created = mergeCombos(makePredictions(games));
    for (const pred of created) {
      if (panel.requireCombo && !pred.combo) continue;
      if (pred.messages.length && !pred.resend) continue;
      pred.resend = false;
      await send(pred);
    }
    panel.lastScanAt = Date.now();
  } catch (e) {
    panel.lastError = e.message;
  } finally {
    busy = false;
  }
  return panel;
}

async function test() {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  if (!panel.channels.length) return { ok: false, error: 'Aucun canal configuré' };
  const sent = [];
  const errors = [];
  for (const id of panel.channels) {
    try {
      await bot.sendMessage(id, '🎯 PRÉDIT — message de test\n\nCe canal recevra les prédictions certifiées à 100%.');
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

function status() {
  const active = activeCertified();
  return {
    ...config(),
    running: panel.enabled,
    certified: panel.certified.map((c) => ({
      id: c.id, type: c.type, name: c.name, finding: c.finding, rate: c.rate,
      sample: c.sample, win: c.win, loss: c.loss, certifiedAt: c.certifiedAt,
    })),
    retired: panel.retired.slice(0, 10),
    autoDouble: active.length >= 2,
    activeCount: active.length,
    predictions: panel.predictions.slice(0, 40).map((p) => ({
      target: p.target, suit: p.suit, status: p.status, step: p.step, maxR: p.maxR,
      combo: p.combo, sources: p.sources.map((s) => s.name), createdAt: p.createdAt,
      published: p.messages.length > 0,
    })),
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
  };
}

module.exports = { panel, status, config, configure, restore, setSender, tick, mirror, test, parseChannels };
