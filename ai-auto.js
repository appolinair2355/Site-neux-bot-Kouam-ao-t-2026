// ai-auto.js — analyseur automatique en temps réel
//  • Le moteur local tourne en continu sur les jeux terminés.
//  • Chaque constat est publié dans « Résultats ».
//  • Chaque stratégie trouvée est enregistrée dans « Stratégies IA créées ».
//  • Pollinations.ai enrichit l'analyse à intervalle plus large (clé en dur).
'use strict';

const config = require('./config');
const ai = require('./ai-analyzer');
const strategies = require('./strategies');
const { state } = require('./predictor');

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
function saveProposal(proposal, origin = 'auto-local') {
  if (!proposal || !proposal.name) return null;
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
    compatibleExisting: strategies.BY_KEY[proposal.compatibleExisting] ? proposal.compatibleExisting : null,
    origin,
    createdAt: new Date().toISOString(),
    active: false,
  };
  state.aiStrategies = [item, ...(state.aiStrategies || [])].slice(0, 40);
  auto.createdCount += 1;
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
  return true;
}

function runLocal() {
  const games = [...(state.history || [])].slice(0, ai.MAX_GAMES);
  const result = ai.localAnalysis(games);
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
    const result = await ai.analyze({ games, objective: 'Analyse automatique en temps réel du flux en cours.' });
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
  };
  const tickRemote = () => { runRemote().then((r) => { if (r && onChange) onChange(); }); };
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
  };
}

module.exports = { start, stop, status, runLocal, runRemote, saveProposal, auto };
