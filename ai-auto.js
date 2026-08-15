// ai-auto.js — analyseur automatique en temps réel
//  • Le moteur local tourne en continu sur les jeux terminés.
//  • Chaque constat est publié dans « Résultats ».
//  • Chaque stratégie trouvée est enregistrée dans « Stratégies IA créées ».
//  • Pollinations.ai enrichit l'analyse à intervalle plus large (clé d'environnement).
'use strict';

const config = require('./config');
const ai = require('./ai-analyzer');
const strategies = require('./strategies');
const db = require('./db');
const { state } = require('./predictor');
const cumulative = require('./cumulative');
const advisor = require('./strategy-advisor');

const auto = {
  enabled: config.AI_AUTO_ENABLED !== false,
  running: false,
  lastLocalAt: null,
  lastRemoteAt: null,
  lastError: null,
  lastGame: null,
  createdCount: 0,
};

function signature(result) {
  return [result.source, ...(result.findings || [])].join('|');
}

function slug(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Enregistre une stratégie trouvée par l'analyseur (sans jamais l'activer seule)
// Seuil minimum de réussite : une stratégie n'est enregistrée dans
// « Stratégies IA » que si l'analyse lui mesure au moins 75% de réussite.
const MIN_STRATEGY_RATE = 75;

function proposalRate(proposal) {
  const r = Number(proposal && proposal.rate);
  return Number.isFinite(r) ? r : null;
}

function saveProposal(proposal, origin = 'auto-local') {
  if (!proposal || !proposal.name) return null;
  const rate = proposalRate(proposal);
  if (rate == null || rate < MIN_STRATEGY_RATE) return null;
  const name = String(proposal.name).slice(0, 100);
  if ((state.aiStrategies || []).some((s) => slug(s.name) === slug(name))) return null;
  const item = {
    id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    logic: String(proposal.logic || '').slice(0, 1000),
    trigger: String(proposal.trigger || '').slice(0, 400),
    target: String(proposal.target || '').slice(0, 400),
    evidence: String(proposal.evidence || '').slice(0, 1000),
    risks: String(proposal.risks || '').slice(0, 1000),
    minimumSample: proposal.minimumSample || null,
    rate,
    support: Number(proposal.support) || null,
    compatibleExisting: strategies.BY_KEY[proposal.compatibleExisting] ? proposal.compatibleExisting : null,
    origin,
    createdAt: new Date().toISOString(),
    active: false,
  };
  state.aiStrategies = [item, ...(state.aiStrategies || [])].slice(0, 40);
  auto.createdCount += 1;
  // Enregistrement durable en base : sans ça, la stratégie ne survivait qu'en
  // mémoire/data.json et disparaissait au redémarrage du serveur (Render).
  if (db.ready) db.saveAiStrategy(item).catch(() => {});
  return item;
}

function pushResult(result) {
  const previous = state.aiAnalyses[0];
  if (previous && signature(previous) === signature(result) && previous.source === result.source) {
    // même constat qu'au tour précédent : on met simplement l'horodatage à jour
    previous.generatedAt = result.generatedAt;
    previous.sample = result.sample;
    return false;
  }
  state.aiAnalyses = [result, ...state.aiAnalyses].slice(0, 12);
  if (db.ready) {
    db.saveAiAnalysis(result).catch((error) => { auto.lastError = error.message; });
  }
  return true;
}

// journées déjà jouées (base de données) : sert à repérer « le jeu d'hier
// revient aujourd'hui » ou « la partie du 20/08/2026 se rejoue ».
let pastDays = [];
let pastDaysAt = 0;

async function refreshPastDays(force = false) {
  if (!db.ready) { pastDays = []; return pastDays; }
  if (!force && Date.now() - pastDaysAt < 5 * 60 * 1000) return pastDays;
  try {
    const dates = await db.availableDates(8);
    const today = new Date().toISOString().slice(0, 10);
    const out = [];
    for (const row of dates) {
      const date = String(row.played_on).slice(0, 10);
      if (date === today) continue;
      out.push({ date, games: await db.gamesByDate(date, 400) });
      if (out.length >= 6) break;
    }
    pastDays = out;
    pastDaysAt = Date.now();
  } catch (e) { auto.lastError = e.message; }
  return pastDays;
}

function runLocal() {
  const games = [...(state.history || [])].slice(0, ai.MAX_GAMES);
  const result = ai.localAnalysis(games, { pastDays });
  auto.lastLocalAt = Date.now();
  auto.lastGame = state.lastFinished ? state.lastFinished.number : null;
  const isNew = pushResult(result);
  const created = [];
  for (const proposal of result.strategies || []) {
    const saved = saveProposal(proposal, 'auto-local');
    if (saved) created.push(saved);
  }
  return { result, isNew, created };
}

async function runRemote() {
  if (!ai.keyLooksValid()) return null;
  const games = [...(state.history || [])].slice(0, 60);
  if (games.length < 6) return null;
  try {
    await refreshPastDays();
    const result = await ai.analyze({
      games,
      pastDays,
      objective: "Analyse automatique en temps réel : cherche aussi des régularités nouvelles (carte précise suivie d'un costume, décalages a+1/a+2/a+3, répétition d'une journée déjà jouée) et propose les remplacements de costume utiles aux stratégies existantes.",
    });
    auto.lastRemoteAt = Date.now();
    auto.lastError = null;
    pushResult(result);
    for (const proposal of result.strategies || []) saveProposal(proposal, 'auto-pollinations');
    return result;
  } catch (error) {
    auto.lastError = error.message;
    auto.lastRemoteAt = Date.now();
    return null;
  }
}

let localTimer = null;
let remoteTimer = null;

function start(onChange) {
  if (auto.running || !auto.enabled) return auto;
  auto.running = true;
  const tickLocal = () => {
    try { const r = runLocal(); if (r.isNew && onChange) onChange(); }
    catch (e) { auto.lastError = e.message; }
    // analyse cumulative par paliers de 4 jeux (1→4, 1→8, 1→12 … 1→1440)
    cumulative.tick().then((r) => {
      // avis cumulé sur les stratégies existantes (panneau « Avis IA »)
      advisor.run({ remote: false }).catch(() => {});
      if (r && r.created && r.created.length && onChange) onChange();
    }).catch((e) => { auto.lastError = e.message; });
  };
  const tickRemote = () => {
    refreshPastDays().then(() => runRemote()).then((r) => { if (r && onChange) onChange(); });
  };
  tickLocal();
  localTimer = setInterval(tickLocal, config.AI_LOCAL_INTERVAL_MS);
  remoteTimer = setInterval(tickRemote, config.AI_REMOTE_INTERVAL_MS);
  setTimeout(tickRemote, 20000);
  return auto;
}

function stop() {
  auto.running = false;
  if (localTimer) clearInterval(localTimer);
  if (remoteTimer) clearInterval(remoteTimer);
  localTimer = remoteTimer = null;
  return auto;
}

function status() {
  return {
    ...auto,
    keyConfigured: ai.keyLooksValid(),
    model: config.POLLINATIONS.MODEL,
    localIntervalMs: config.AI_LOCAL_INTERVAL_MS,
    remoteIntervalMs: config.AI_REMOTE_INTERVAL_MS,
    results: state.aiAnalyses.slice(0, 6),
    strategies: state.aiStrategies || [],
    cumulative: cumulative.status(),
  };
}

module.exports = { MIN_STRATEGY_RATE, start, stop, status, cumulative, runLocal, runRemote, saveProposal, refreshPastDays, getPastDays: () => pastDays, auto };
