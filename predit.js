// predit.js — panneau « Prédit » : prédictions automatiques haute fiabilité
//
//  • SEULES les stratégies CRÉÉES PAR L'IA (règles découvertes par l'analyseur)
//    qui atteignent AU MOINS le seuil configuré (85% par défaut, réglable de
//    50% à 100% via minRate) entrent dans ce panneau. Les stratégies
//    existantes du bot ne sont JAMAIS utilisées ici.
//  • PRIORITÉ AUX DÉCLENCHEURS À 100% : tant qu'au moins une règle certifiée
//    à 100% est disponible (quota non atteint) ou a une prédiction en cours,
//    les règles en dessous de 100% sont mises en attente et ne prédisent
//    pas. Elles ne reprennent que lorsque plus aucune règle à 100% n'est
//    disponible.
//  • Le message envoyé dans le canal utilise le FORMAT DE PRÉDICTION CONFIGURÉ
//    (les 88 formats). Le motif de la prédiction n'apparaît jamais dans le
//    message : il est gardé dans l'historique de la stratégie.
//  • Chaque stratégie certifiée ne prédit qu'un nombre configuré de fois
//    (ex. 2). Ensuite elle est mise en pause et le panneau attend une NOUVELLE
//    stratégie certifiée pour continuer à prédire.
//  • Dès qu'une stratégie certifiée perd, elle est retirée automatiquement.
'use strict';

const miner = require('./pattern-miner');
const strategies = require('./strategies');
const store = require('./store');
const fmt = require('./formats');
const { state } = require('./predictor');

const SUITS = ['♦️', '❤️', '♣️', '♠️'];

const panel = {
  enabled: true,
  channels: [],        // canaux Telegram du panneau
  minSample: 6,        // observations minimum pour certifier une règle
  minRate: 85,          // taux de réussite minimum accepté (réglable 50-100 ; 100 = parfait, prioritaire)
  maxR: 1,             // rattrapages autorisés sur une prédiction du panneau
  format: 1,           // format de prédiction utilisé pour les messages
  perStrategy: 2,      // nombre de prédictions autorisées par stratégie créée
  requireCombo: false, // n'envoyer QUE les prédictions confirmées par 2 règles
  certified: [],       // règles IA actuellement au-dessus du seuil
  retired: [],         // règles retirées (perdues ou quota atteint)
  predictions: [],     // prédictions du panneau (les 200 dernières)
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
  if (patch.minRate !== undefined) {
    const v = parseInt(patch.minRate, 10);
    panel.minRate = Math.max(50, Math.min(100, Number.isFinite(v) ? v : 85));
  }
  if (patch.minSample !== undefined) panel.minSample = Math.max(3, Math.min(60, parseInt(patch.minSample, 10) || 6));
  if (patch.maxR !== undefined) panel.maxR = Math.max(0, Math.min(5, parseInt(patch.maxR, 10) || 0));
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.perStrategy !== undefined) panel.perStrategy = Math.max(1, Math.min(50, parseInt(patch.perStrategy, 10) || 1));
  persist();
  return config();
}

function config() {
  return {
    enabled: panel.enabled,
    channels: panel.channels,
    minSample: panel.minSample,
    minRate: panel.minRate,
    maxR: panel.maxR,
    format: panel.format,
    perStrategy: panel.perStrategy,
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
// Certification : SEULES les stratégies créées par l'IA à 100% entrent ici
// ---------------------------------------------------------------------------
function certifyDiscoveries() {
  const found = miner.mine(state.history || [], { lead: 2 });
  const list = (found.discoveries || []).filter(
    (d) => d.rule && Number(d.rate) >= panel.minRate && Number(d.support || 0) >= panel.minSample,
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
      motif: (d.proposal && d.proposal.logic) || d.finding,
      trigger: (d.proposal && d.proposal.trigger) || '',
      rule: d.rule,
      rate: d.rate,
      sample: d.support,
      used: 0,
      win: 0,
      loss: 0,
      certifiedAt: new Date().toISOString(),
    });
  }
  return panel.certified;
}

function retire(entry, reason) {
  panel.certified = panel.certified.filter((c) => c.id !== entry.id);
  panel.retired = [{ ...entry, reason, retiredAt: new Date().toISOString() }, ...panel.retired].slice(0, 30);
}

// stratégies encore au-dessus du seuil ET qui n'ont pas épuisé leur quota,
// triées par fiabilité décroissante : les 100% arrivent toujours en tête.
function activeCertified() {
  return panel.certified
    .filter((c) => c.rate >= panel.minRate && (c.used || 0) < panel.perStrategy)
    .sort((a, b) => b.rate - a.rate);
}

// un déclencheur à 100% est-il disponible pour prédire (quota restant), ou
// a-t-il déjà une prédiction en cours ? Tant que la réponse est oui, les
// déclencheurs en dessous de 100% ne sont PAS prioritaires : ils patientent.
function hasPerfectPriority(active) {
  if (active.some((c) => c.rate >= 100)) return true;
  return panel.predictions.some(
    (p) => p.status === 'en attente' && p.sources.some((s) => s.rate >= 100),
  );
}

// ---------------------------------------------------------------------------
// Prédictions du panneau
// ---------------------------------------------------------------------------
function lastFinishedNumber(games) {
  return games.length ? games[games.length - 1].n : 0;
}

function motifOf(entry, game, target) {
  return [
    entry.trigger ? `Déclencheur : ${entry.trigger}` : null,
    `Vu au jeu #N${game.n} → prédiction sur #N${target}`,
    entry.motif || entry.finding || '',
    `Fiabilité mesurée : ${entry.rate}% sur ${entry.sample} observation(s)`,
  ].filter(Boolean).join(' · ');
}

function makePredictions(games) {
  const last = lastFinishedNumber(games);
  if (!last) return [];
  const created = [];
  const active = activeCertified();
  // priorité au(x) déclencheur(s) à 100% : tant que l'un d'eux est
  // disponible ou a déjà une prédiction en cours, les règles < 100% sont
  // écartées de ce tour (elles ne sont pas supprimées, juste mises en attente).
  const perfectPriority = hasPerfectPriority(active);
  for (const entry of active) {
    if (!entry.rule) continue;
    if (perfectPriority && entry.rate < 100) continue;
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
        // le motif reste dans l'historique de la stratégie, jamais dans le message
        motif: motifOf(entry, g, target),
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
      entry.used = (entry.used || 0) + 1;
      created.push(pred);
      if ((entry.used || 0) >= panel.perStrategy) entry.quotaAt = new Date().toISOString();
      break;
    }
  }
  panel.predictions = panel.predictions.slice(0, 200);
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
      twin.motif = [twin.motif, pred.motif].filter(Boolean).join('\n');
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
      if (pred.status === 'gagné') {
        entry.win += 1;
      } else {
        entry.loss += 1;
        entry.rate = 0;
        retire(entry, `Prédiction perdue sur le jeu #N${pred.target} : la règle passe sous le seuil de ${panel.minRate}%.`);
        continue;
      }
      // quota atteint : la stratégie sort du service, on attend une nouvelle
      if ((entry.used || 0) >= panel.perStrategy && !panel.predictions.some(
        (p) => p.status === 'en attente' && p.sources.some((s) => s.id === entry.id),
      )) {
        retire(entry, `Quota atteint : ${entry.used} prédiction(s) envoyée(s). Le panneau attend une nouvelle stratégie à ${panel.minRate}% ou plus.`);
      }
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Messages Telegram — format configuré, AUCUN motif visible
// ---------------------------------------------------------------------------
function predictionText(pred) {
  return fmt.renderMessage(panel.format, {
    gameNumber: pred.target,
    suit: pred.suit,
    strategy: 'Prédit',
    maxR: pred.maxR,
    status: pred.status,
    rattrapage: pred.step,
  });
}

async function send(pred) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return false; }
  if (!panel.channels.length) { panel.lastError = 'Aucun canal configuré pour le panneau Prédit'; return false; }
  const out = predictionText(pred);
  let ok = false;
  for (const id of panel.channels) {
    try {
      const m = await bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {});
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
  const out = predictionText(pred);
  for (const m of pred.messages) {
    try {
      await bot.editMessageText(out.text, {
        chat_id: m.chatId, message_id: m.messageId,
        ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}),
      });
    } catch (_) {}
  }
}

// Les stratégies existantes du bot ne sont plus reprises dans « Prédit ».
async function mirror() { return false; }

// ---------------------------------------------------------------------------
// Historique séparé par stratégie + bilan par stratégie
// ---------------------------------------------------------------------------
function predRow(p) {
  return {
    target: p.target, suit: p.suit, status: p.status, step: p.step, maxR: p.maxR,
    combo: p.combo, sources: p.sources.map((s) => s.name), motif: p.motif || '',
    createdAt: p.createdAt, published: p.messages.length > 0,
  };
}

function bilanOf(list) {
  const done = list.filter((p) => p.status !== 'en attente');
  const win = done.filter((p) => p.status === 'gagné').length;
  const loss = done.length - win;
  return { total: list.length, win, loss, pending: list.length - done.length, rate: done.length ? Math.round((win / done.length) * 100) : 0 };
}

function bilanText(entry, list) {
  const b = bilanOf(list);
  return (
    '📊 STATISTIQUE 📈\n\n' +
    `🧠 Stratégie IA : ${entry.name}\n\n` +
    `🟢 GAIN : ${b.win}\n` +
    `🔴 PERTE : ${b.loss}\n\n` +
    `✅ Taux de réussite : ${b.rate} %`
  );
}

function strategiesView() {
  const all = [...panel.certified, ...panel.retired];
  const seen = new Set();
  const out = [];
  for (const entry of all) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const list = panel.predictions.filter((p) => p.sources.some((s) => s.id === entry.id));
    out.push({
      id: entry.id,
      name: entry.name,
      motif: entry.motif || entry.finding || '',
      finding: entry.finding || '',
      rate: entry.rate,
      sample: entry.sample,
      used: entry.used || 0,
      quota: panel.perStrategy,
      active: panel.certified.some((c) => c.id === entry.id) && entry.rate >= panel.minRate,
      waiting: (entry.used || 0) >= panel.perStrategy,
      reason: entry.reason || null,
      certifiedAt: entry.certifiedAt,
      bilan: bilanOf(list),
      bilanText: bilanText(entry, list),
      predictions: list.slice(0, 20).map(predRow), // 20 dernières de CETTE stratégie
    });
  }
  return out;
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
    if (games.length >= 12) certifyDiscoveries();
    const closed = verify(games);
    for (const pred of closed) await update(pred);
    const created = mergeCombos(makePredictions(games));
    // prédictions encore valables mais jamais publiées (canal absent, erreur
    // Telegram, bot redémarré) : on retente l'envoi à chaque tour.
    const last = lastFinishedNumber(games);
    const unsent = panel.predictions.filter(
      (p) => p.status === 'en attente' && !p.messages.length && p.target > last && !created.includes(p),
    );
    for (const pred of [...created, ...unsent]) {
      if (panel.requireCombo && !pred.combo) continue;
      if (pred.messages.length && !pred.resend) continue;
      pred.resend = false;
      // combo confirmé sur une prédiction DÉJÀ envoyée : on modifie le
      // message existant, on n'en envoie jamais un second (ça créait un
      // doublon visible dans le canal).
      if (pred.messages.length) { await update(pred); continue; }
      await send(pred);
    }
    if (!panel.certified.length) {
      panel.lastError = panel.channels.length
        ? `Aucune stratégie IA au-dessus de ${panel.minRate}% pour l'instant : rien à envoyer.`
        : 'Aucun canal configuré pour le panneau Prédit';
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
  const preview = fmt.formatPreview(panel.format, { maxR: panel.maxR });
  const sent = [];
  const errors = [];
  for (const id of panel.channels) {
    try {
      await bot.sendMessage(id, `🎯 PRÉDIT — message de test\n\nFormat ${panel.format} :\n\n${preview}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

function status() {
  const active = activeCertified();
  const perfectPriority = hasPerfectPriority(active);
  return {
    ...config(),
    running: panel.enabled,
    formatPreview: fmt.formatPreview(panel.format, { maxR: panel.maxR }),
    certified: panel.certified.map((c) => ({
      id: c.id, type: c.type, name: c.name, finding: c.finding, motif: c.motif || '',
      rate: c.rate, sample: c.sample, used: c.used || 0, quota: panel.perStrategy,
      win: c.win, loss: c.loss, certifiedAt: c.certifiedAt,
      // en attente = règle valide (>= minRate) mais mise en pause ce tour
      // car une règle à 100% est prioritaire
      waitingForPerfect: perfectPriority && c.rate < 100 && (c.used || 0) < panel.perStrategy,
    })),
    retired: panel.retired.slice(0, 10),
    autoDouble: active.length >= 2,
    activeCount: active.length,
    perfectPriorityActive: perfectPriority,
    strategies: strategiesView(),
    globalBilan: bilanOf(panel.predictions),
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
  };
}

module.exports = { panel, status, config, configure, restore, setSender, tick, mirror, test, parseChannels };
