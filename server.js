// server.js — tableau de bord web (Render) + API JSON. AUCUN mot de passe requis.
const path = require('path');
const express = require('express');
const config = require('./config');
const api = require('./api');
const db = require('./db');
const fmt = require('./formats');
const strategies = require('./strategies');
const ai = require('./ai-analyzer');
const miner = require('./pattern-miner');
const aiAuto = require('./ai-auto');
const cumulative = require('./cumulative');
const advisor = require('./strategy-advisor');
const predit = require('./predit');
const dayCompare = require('./day-compare');
const {
  state, stats, predictionMessage, recentGames, SUITS,
  setStrategyConfig, resetStrategy, initStrategies, parityRuntime,
  strategyGames, bilanText, gameCategories, gateView, shadowRuntime,
  predictionsPanel, strategyChannels, unlockGate, sweepAutoUnlock,
} = require('./predictor');
const { startLoop, startBot, botStatus, activate, deactivate, persist, sendBilan, dropSender, announceConfig, announceMainBot, resolveChat, testSend, saveConfigsToDb, applyDbConfigs, setMainChannel } = require('./bot');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.send('ok'));

app.get('/api/state', (req, res) => {
  res.json({
    b: state.B,
    maxR: state.maxR,
    hand: 'joueur',
    format: state.format,
    formatCount: fmt.FORMAT_COUNT,
    formats: fmt.formatList(1, fmt.FORMAT_COUNT).text,
    template: state.template || null,
    counters: state.counters,
    suits: SUITS,
    live: state.live,
    liveCategories: gameCategories(state.live),
    board: strategyGames('costume', 8),
    lastFinished: state.lastFinished,
    error: state.lastError,
    bot: botStatus(),
    db: db.status(),
    apiUrl: api.endpoints()[0],
    champId: config.CHAMP_ID,
    ai: {
      configured: ai.keyLooksValid(),
      model: config.POLLINATIONS.MODEL,
      auto: aiAuto.status(),
      lastAnalysis: state.aiAnalyses[0] || null,
      results: state.aiAnalyses.slice(0, 6),
      savedStrategies: state.aiStrategies,
    },
    channels: state.channels.map((c) => ({ ...c, active: state.activeChannels.includes(c.id) })),
    strategies: strategies.LIST.map((d) => ({
      key: d.key, name: d.name, about: d.about, usesB: !!d.usesB,
      config: state.strategies[d.key] || {}, stats: stats(d.key),
    })),
    predit: predit.status(),
    predictions: state.predictions.slice(0, 50).map((p) => ({
      strategy: p.strategy, strategyName: p.strategyName, label: p.label,
      target: p.target, suit: p.suit, hand: p.hand, step: p.step, maxR: p.maxR,
      status: p.status, badge: p.badge, reason: p.reason, text: predictionMessage(p),
    })),
    parity: parityRuntime(),
    panel: predictionsPanel(40),
    stats: stats(),
    uptime: Date.now() - state.startedAt,
  });
});

app.get('/api/games', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 30);
  res.json({ live: state.live, games: recentGames(limit) });
});

// jeux stockés en base par date (ex: /api/history?date=2/04/2026)
app.get('/api/history', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  const rows = await db.gamesByDate(req.query.date, Math.min(1000, parseInt(req.query.limit, 10) || 300));
  const summary = await db.dailySummary(req.query.date);
  res.json({ summary, games: rows });
});

// --- bot --------------------------------------------------------------------
app.get('/api/bot', (req, res) => res.json(botStatus()));

app.post('/api/bot/token', async (req, res) => {
  const token = (req.body.token || '').trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) return res.status(400).json({ error: 'Token Telegram invalide' });
  const r = await startBot(token);
  // signale dans les canaux actifs que le token API est configuré
  const notice = r.ok ? await announceMainBot() : null;
  res.status(r.ok ? 200 : 400).json({ ...r, notice, bot: botStatus() });
});

app.post('/api/bot/restart', async (req, res) => {
  const r = await startBot();
  res.json({ ...r, bot: botStatus() });
});

app.post('/api/bot/admin', (req, res) => {
  const id = parseInt(req.body.adminId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID administrateur invalide' });
  state.adminId = id;
  persist();
  res.json({ ok: true, bot: botStatus() });
});

// --- base de données --------------------------------------------------------
app.post('/api/db', async (req, res) => {
  const s = await db.connect(req.body.url || '');
  res.status(s.ready ? 200 : 400).json(s);
});

// --- canaux / réglages ------------------------------------------------------
app.post('/api/channels/activate', (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID de canal invalide' });
  activate(id);
  res.json({ ok: true });
});

// canal principal (page Configuration) : vérifié, enregistré et confirmé
app.post('/api/channels/main', async (req, res) => {
  const r = await setMainChannel(req.body && req.body.channelId);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/channels/deactivate', (req, res) => {
  deactivate(parseInt(req.body.id, 10));
  res.json({ ok: true });
});

app.post('/api/setb', (req, res) => {
  state.B = Math.max(1, parseInt(req.body.b, 10) || 1);
  for (const s of SUITS) if (state.counters[s] > state.B) state.counters[s] = 0;
  persist();
  res.json({ ok: true, b: state.B });
});

app.post('/api/setmaxr', (req, res) => {
  state.maxR = Math.max(0, Math.min(9, parseInt(req.body.maxR, 10) || 0));
  persist();
  res.json({ ok: true, maxR: state.maxR });
});

app.post('/api/setformat', (req, res) => {
  state.format = fmt.clampFormat(req.body.format);
  state.template = null;
  persist();
  res.json({ ok: true, format: state.format, preview: fmt.formatPreview(state.format, { maxR: state.maxR }) });
});

// aperçu d'un style (⌛ / ✅ / ❌)
app.get('/api/formats', (req, res) => {
  res.json({ count: fmt.FORMAT_COUNT, formats: fmt.formatCatalog() });
});

app.post('/api/template', (req, res) => {
  const t = String(req.body.template || '').trim();
  state.template = t || null;
  persist();
  res.json({ ok: true, template: state.template, preview: fmt.renderMessage(state.format, { gameNumber: 1234, suit: '♦️', maxR: state.maxR }, state.template).text });
});

// La main analysée est toujours celle du joueur (banquier = archive seulement)
app.post('/api/sethand', (req, res) => res.json({ ok: true, hand: 'joueur' }));

// --- vérification des données enregistrées ---------------------------------
app.get('/api/db/overview', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  res.json({ overview: await db.overview(), dates: await db.availableDates(20) });
});

app.get('/api/db/games', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  res.json({ games: await db.lastGames(Math.min(100, parseInt(req.query.limit, 10) || 20)) });
});

app.get('/api/db/game/:number', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  const g = await db.gameByNumber(req.params.number);
  if (!g) return res.status(404).json({ error: 'Jeu introuvable' });
  res.json(g);
});

app.get('/api/db/predictions', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  res.json({
    summary: await db.predictionSummary(req.query.date),
    predictions: await db.predictionsByDate(req.query.date, Math.min(500, parseInt(req.query.limit, 10) || 100)),
  });
});

app.post('/api/db/query', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  const r = await db.readOnlyQuery(req.body.sql, 100);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});


// contenu complet de la base de données (panneau « Base de données »)
app.get('/api/db/dump', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée', status: db.status() });
  res.json(await db.dump(Math.min(100, parseInt(req.query.limit, 10) || 25)));
});

// --- stratégies -------------------------------------------------------------
function strategyPayload(key) {
  const d = strategies.BY_KEY[key];
  if (!d) return null;
  const cfg = state.strategies[key] || {};
  return {
    key: d.key,
    name: d.name,
    about: d.about,
    usesB: !!d.usesB,
    config: { ...cfg, token: undefined },
    channels: cfg.publishedChannels || cfg.channels || [],
    publishedChannels: cfg.publishedChannels || cfg.channels || [],
    shadowChannels: cfg.shadowChannels || [],
    channelInfos: cfg.publishedChannelInfos || cfg.channelInfos || [],
    shadowChannelInfos: cfg.shadowChannelInfos || [],
    sentCount: cfg.sentCount || 0,
    lastSentAt: cfg.lastSentAt || null,
    bot: botStatus(),
    bilan: cfg.bilan !== false,
    bilanPreview: bilanText(d.key),
    sendError: state.sendErrors ? state.sendErrors[d.key] || null : null,
    gate: gateView(d.key),
    shadow: d.key === 'ombre' ? shadowRuntime() : null,
    live: strategyGames(d.key, 12),
    stats: stats(d.key),
    preview: {
      pending: fmt.formatPreview(cfg.format, { maxR: cfg.maxR }),
      win: fmt.formatPreview(cfg.format, { maxR: cfg.maxR, status: 'gagné', rattrapage: 1 }),
      loss: fmt.formatPreview(cfg.format, { maxR: cfg.maxR, status: 'perdu', rattrapage: cfg.maxR }),
      distribution: cfg.formatDistribution ? fmt.formatPreview(cfg.formatDistribution, { maxR: cfg.maxR }) : null,
    },
    predictions: state.predictions.filter((p) => p.strategy === key).slice(0, 25).map((p) => ({
      target: p.target, label: p.label, status: p.status, badge: p.badge,
      step: p.step, maxR: p.maxR, reason: p.reason, text: predictionMessage(p),
      silent: !!p.silent,
    })),
  };
}

// jeux en live vus par une stratégie (catégories lisibles)
app.get('/api/strategies/:key/games', (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 12);
  res.json({ ...strategyGames(req.params.key, limit), stats: stats(req.params.key) });
});

// envoi manuel du bilan (test)
app.post('/api/strategies/:key/bilan', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  await sendBilan(req.params.key);
  res.json({ ok: true, text: bilanText(req.params.key) });
});

// bilan séparé par stratégie
app.get('/api/bilans', (req, res) => {
  res.json({
    bilans: strategies.LIST.map((d) => ({
      key: d.key, name: d.name, stats: stats(d.key), text: bilanText(d.key),
    })),
  });
});

// panneau des prédictions : silencieuses et publiées, séparées
app.get('/api/predictions', (req, res) => {
  res.json(predictionsPanel(Math.min(200, parseInt(req.query.limit, 10) || 60)));
});

// état de la stratégie « Prédiction dans l'ombre »
app.get('/api/ombre', (req, res) => res.json(shadowRuntime()));

// ---- configurations enregistrées en base ----------------------------------
app.get('/api/configs', async (req, res) => {
  if (!db.ready) return res.json({ ready: false, strategies: {}, settings: {} });
  const rows = await db.loadStrategies();
  res.json({
    ready: true,
    strategies: rows,
    settings: {
      B: await db.getSetting('B'),
      maxR: await db.getSetting('maxR'),
      format: await db.getSetting('format'),
      template: await db.getSetting('template'),
    },
  });
});

// enregistrer TOUTES les configurations en cours
app.post('/api/configs/save', async (req, res) => {
  const r = await saveConfigsToDb();
  res.status(r.ok ? 200 : 400).json(r);
});

// relire les configurations depuis la base (et compléter si elle est vide)
app.post('/api/configs/load', async (req, res) => {
  const r = await applyDbConfigs();
  res.status(r.ok ? 200 : 400).json(r);
});

app.get('/api/strategies', (req, res) => {
  initStrategies();
  res.json({ strategies: strategies.LIST.map((d) => strategyPayload(d.key)) });
});

app.get('/api/strategies/:key', (req, res) => {
  const payload = strategyPayload(req.params.key);
  if (!payload) return res.status(404).json({ error: 'Stratégie inconnue' });
  res.json(payload);
});

// modification (administrateur) — enregistrée en base de données
app.post('/api/strategies/:key', async (req, res) => {
  const cfg = setStrategyConfig(req.params.key, req.body || {});
  if (!cfg) return res.status(404).json({ error: 'Stratégie inconnue' });
  persist();
  if (db.ready) await db.saveStrategy(req.params.key, strategies.BY_KEY[req.params.key].name, cfg);
  // token API et/ou ID de canal configurés → on prévient le canal
  const touched = req.body && (
    req.body.channels !== undefined ||
    req.body.channelId !== undefined ||
    req.body.publishedChannels !== undefined ||
    req.body.shadowChannels !== undefined
  );
  const notice = touched
    ? await announceConfig(req.params.key, req.body.mode === 'shadow' ? 'shadow' : 'published')
    : null;
  await cumulative.purgeStaleFor(cumulative.strategySignature());
  cumulative.tick();
  res.json({ ok: true, saved: db.ready, notice, ...strategyPayload(req.params.key) });
});

// --- canal d'une stratégie : vérification + confirmation dans le canal ------
app.post('/api/strategies/:key/channel', async (req, res) => {
  const key = req.params.key;
  if (!strategies.BY_KEY[key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  const mode = req.body.mode === 'shadow' ? 'shadow' : 'published';
  const raw = String(req.body.channelId || '').trim();
  if (!raw) return res.status(400).json({ error: "Renseigne l'ID du canal (ex : -1001234567890 ou @moncanal)" });
  if (!botStatus().tokenSet) {
    return res.status(400).json({ error: "Configure d'abord le token API du bot dans les réglages." });
  }
  const check = await resolveChat(raw);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const isChannel = ['channel', 'supergroup', 'group'].includes(check.chat.type);
  if (isChannel && check.chat.canPost === false) {
    return res.status(400).json({
      error: `Le bot n'est pas administrateur de « ${check.chat.title} » avec le droit « Publier des messages ».`,
    });
  }
  const cfg = setStrategyConfig(key, mode === 'shadow'
    ? { shadowChannelId: String(check.chat.id) }
    : { publishedChannels: [String(check.chat.id)] });
  const notice = await announceConfig(key, mode);
  if (mode === 'shadow') cfg.shadowChannelInfos = notice.channels || [check.chat];
  else cfg.publishedChannelInfos = notice.channels || [check.chat];
  persist();
  if (db.ready) await db.saveStrategy(key, strategies.BY_KEY[key].name, cfg);
  res.json({ ok: true, mode, channel: check.chat, notice, ...strategyPayload(key) });
});

// retirer le canal d'une stratégie
app.delete('/api/strategies/:key/channel', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  const mode = req.body && req.body.mode === 'shadow' ? 'shadow' : 'published';
  const cfg = mode === 'shadow'
    ? setStrategyConfig(req.params.key, { shadowChannels: [], shadowChannelInfos: [] })
    : setStrategyConfig(req.params.key, { publishedChannels: [], publishedChannelInfos: [], channels: [], channelInfos: [] });
  persist();
  if (db.ready) await db.saveStrategy(req.params.key, strategies.BY_KEY[req.params.key].name, cfg);
  res.json({ ok: true, mode, ...strategyPayload(req.params.key) });
});

// test d'envoi réel dans le canal configuré
app.post('/api/strategies/:key/test', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  const r = await testSend(req.params.key, req.body && req.body.mode === 'shadow' ? 'shadow' : 'published');
  persist();
  if (!r.ok) return res.status(400).json({ error: r.error || (r.failed || []).map((f) => `${f.id} : ${f.error}`).join(' / ') });
  res.json(r);
});

// --- analyse IA guidée ------------------------------------------------------
app.get('/api/ai/status', (req, res) => {
  res.json({
    configured: ai.keyLooksValid(),
    model: config.POLLINATIONS.MODEL,
    baseUrl: config.POLLINATIONS.BASE_URL,
    auto: aiAuto.status(),
    lastAnalysis: state.aiAnalyses[0] || null,
    results: state.aiAnalyses.slice(0, 6),
    savedStrategies: state.aiStrategies,
  });
});

app.post('/api/ai/analyze', async (req, res) => {
  try {
    const date = req.body && req.body.date ? String(req.body.date).trim() : null;
    const limit = Math.min(ai.MAX_GAMES, Math.max(6, parseInt(req.body && req.body.limit, 10) || 60));
    let games = [];
    if (date && db.ready) games = await db.gamesByDate(date, limit);
    if (!games.length) games = [...state.history].slice(0, limit);
    if (db.ready) await aiAuto.refreshPastDays();
    const result = await ai.analyze({
      games,
      pastDays: aiAuto.getPastDays(),
      date,
      objective: req.body && req.body.objective ? String(req.body.objective).slice(0, 1200) : '',
    });
    state.aiAnalyses = [result, ...state.aiAnalyses].slice(0, 8);
    persist();
    res.json({ ok: true, result });
  } catch (error) {
    const status = error.code === 'AI_NOT_CONFIGURED' ? 503 : error.code === 'NOT_ENOUGH_DATA' ? 422 : 502;
    res.status(status).json({ error: error.message, code: error.code || 'AI_ERROR' });
  }
});

// découverte de NOUVELLES régularités (au-delà des stratégies existantes)
app.get('/api/ai/patterns', async (req, res) => {
  const limit = Math.min(300, parseInt(req.query.limit, 10) || 150);
  let games = [...state.history].slice(0, limit);
  let pastDays = [];
  if (db.ready) {
    if (!games.length) games = await db.gamesByDate(null, limit);
    await aiAuto.refreshPastDays(true);
    pastDays = aiAuto.getPastDays();
  }
  const result = miner.mine(games, { lead: 2, pastDays, todayGames: games });
  res.json({ ...result, generatedAt: new Date().toISOString(), pastDaysCount: pastDays.length });
});

// comparaison des statistiques des jours antérieurs et d'aujourd'hui
app.get('/api/ai/compare-days', async (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 300);
  let games = [...state.history].slice(0, limit);
  let pastDays = [];
  if (db.ready) {
    if (!games.length) games = await db.gamesByDate(null, limit);
    await aiAuto.refreshPastDays(true);
    pastDays = aiAuto.getPastDays();
  }
  res.json(dayCompare.compare(games, pastDays));
});

// création automatique des stratégies issues de la comparaison des journées
app.post('/api/ai/compare-days/save', async (req, res) => {
  const limit = 300;
  let games = [...state.history].slice(0, limit);
  let pastDays = [];
  if (db.ready) {
    if (!games.length) games = await db.gamesByDate(null, limit);
    await aiAuto.refreshPastDays(true);
    pastDays = aiAuto.getPastDays();
  }
  const result = dayCompare.compare(games, pastDays);
  const created = [];
  for (const proposal of result.proposals) {
    const saved = aiAuto.saveProposal(proposal, 'auto-comparaison');
    if (saved) created.push(saved.name);
  }
  res.json({ ok: true, created, total: result.proposals.length });
});

app.post('/api/ai/strategies', async (req, res) => {
  const proposal = req.body && req.body.proposal;
  if (!proposal || typeof proposal !== 'object') return res.status(400).json({ error: 'Proposition de stratégie manquante' });
  const rate = Number(proposal.rate);
  if (!Number.isFinite(rate) || rate < 75) {
    return res.status(400).json({ error: "Réussite insuffisante : seules les stratégies mesurées à 75% ou plus sont enregistrées." });
  }
  const item = {
    id: `ai-${Date.now()}`,
    name: String(proposal.name || 'Stratégie IA').slice(0, 100),
    logic: String(proposal.logic || '').slice(0, 1000),
    evidence: String(proposal.evidence || '').slice(0, 1000),
    risks: String(proposal.risks || '').slice(0, 1000),
    rate,
    support: Number(proposal.support) || null,
    compatibleExisting: strategies.BY_KEY[proposal.compatibleExisting] ? proposal.compatibleExisting : null,
    createdAt: new Date().toISOString(),
    active: false,
  };
  state.aiStrategies = [item, ...state.aiStrategies].slice(0, 30);
  persist();
  if (db.ready) await db.saveAiStrategy(item);
  res.json({ ok: true, strategy: item });
});

app.post('/api/strategies/:key/reset', async (req, res) => {
  const cfg = resetStrategy(req.params.key);
  if (!cfg) return res.status(404).json({ error: 'Stratégie inconnue' });
  persist();
  if (db.ready) await db.saveStrategy(req.params.key, strategies.BY_KEY[req.params.key].name, cfg);
  await cumulative.purgeStaleFor(cumulative.strategySignature());
  cumulative.tick();
  res.json({ ok: true, ...strategyPayload(req.params.key) });
});

// suppression (administrateur) : configuration effacée en base + stratégie arrêtée
app.delete('/api/strategies/:key', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  if (db.ready) await db.deleteStrategy(req.params.key);
  resetStrategy(req.params.key);
  setStrategyConfig(req.params.key, { enabled: false });
  persist();
  res.json({ ok: true, ...strategyPayload(req.params.key) });
});

// suppression des prédictions d'une stratégie (administrateur)
app.delete('/api/strategies/:key/predictions', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  state.predictions = state.predictions.filter((p) => p.strategy !== req.params.key);
  if (db.ready) await db.clearPredictions(req.params.key);
  res.json({ ok: true });
});

app.get('/api/db/strategies', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  const out = {};
  for (const d of strategies.LIST) {
    out[d.key] = { stats: await db.strategyStats(d.key), predictions: await db.strategyPredictions(d.key, 15) };
  }
  res.json({ saved: await db.loadStrategies(), details: out });
});


// --- analyse cumulative par paliers de 4 jeux -------------------------------
app.get('/api/ai/cumulative', async (req, res) => {
  const date = req.query.date ? String(req.query.date) : null;
  if (date && date !== cumulative.runtime.date) {
    return res.json({ date, step: cumulative.STEP, maxGames: cumulative.MAX_GAMES, checkpoints: await cumulative.byDate(date) });
  }
  res.json(cumulative.status());
});

app.post('/api/ai/cumulative/run', async (req, res) => {
  const r = await cumulative.tick();
  res.json({ ok: true, ...r, status: cumulative.status() });
});

// efface les paliers qui ne correspondent plus à la stratégie actuelle
app.post('/api/ai/cumulative/purge', async (req, res) => {
  const sig = cumulative.strategySignature();
  const removed = await cumulative.purgeStaleFor(sig);
  const r = await cumulative.tick();
  res.json({ ok: true, removed, recalculated: r.created.length, status: cumulative.status() });
});

// --- déblocage des prédictions (auto après 10 min, ou manuel) ---------------
app.post('/api/strategies/:key/unlock', (req, res) => {
  const key = req.params.key;
  if (key === 'all' || key === 'tout') {
    const keys = strategies.LIST.map((d) => d.key);
    keys.forEach((k) => unlockGate(k, true));
    return res.json({ ok: true, unlocked: keys });
  }
  if (!strategies.BY_KEY[key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  unlockGate(key, true);
  res.json({ ok: true, unlocked: [key], gate: gateView(key) });
});

app.get('/api/gates', (req, res) => {
  sweepAutoUnlock();
  res.json({
    gates: strategies.LIST.map((d) => ({ key: d.key, name: d.name, ...gateView(d.key) })),
  });
});

// --- avis IA cumulé sur les stratégies existantes ---------------------------
app.get('/api/ai/strategy-advice', async (req, res) => {
  const st = advisor.status();
  if (!st.lastRunAt) return res.json(await advisor.run({ remote: false }));
  res.json(st);
});

app.post('/api/ai/strategy-advice/run', async (req, res) => {
  const remote = !!(req.body && req.body.remote);
  res.json(await advisor.run({ remote }));
});

// --- analyseur automatique en temps réel ------------------------------------
app.get('/api/ai/auto', (req, res) => res.json(aiAuto.status()));

app.post('/api/ai/auto/run', (req, res) => {
  const r = aiAuto.runLocal();
  persist();
  res.json({ ok: true, result: r.result, created: r.created, auto: aiAuto.status() });
});

app.post('/api/ai/auto/toggle', (req, res) => {
  const on = req.body && req.body.enabled !== false;
  aiAuto.auto.enabled = on;
  if (on) aiAuto.start(persist); else aiAuto.stop();
  res.json({ ok: true, auto: aiAuto.status() });
});

app.post('/api/ai/key', (req, res) => {
  ai.setApiKey(req.body && req.body.key);
  res.json({ ok: true, configured: ai.keyLooksValid() });
});

app.get('/api/ai/models', async (req, res) => {
  try { res.json({ models: await ai.listModels() }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.delete('/api/ai/strategies/:id', async (req, res) => {
  state.aiStrategies = (state.aiStrategies || []).filter((s) => s.id !== req.params.id);
  persist();
  if (db.ready) await db.deleteAiStrategy(req.params.id);
  res.json({ ok: true, savedStrategies: state.aiStrategies });
});


// --- panneau « Prédit » (prédictions certifiées 100%) -----------------------
app.get('/api/predit', (req, res) => res.json(predit.status()));

app.post('/api/predit/config', (req, res) => {
  predit.configure(req.body || {});
  res.json(predit.status());
});

app.post('/api/predit/channel', async (req, res) => {
  const ids = predit.parseChannels(req.body && req.body.channelId);
  if (!ids.length) return res.status(400).json({ error: 'ID de canal invalide' });
  const check = await resolveChat(ids[0]);
  if (!check.ok) return res.status(400).json({ error: check.error });
  predit.configure({ channels: ids });
  const notice = await predit.test();
  res.json({ ok: true, channel: check.chat, notice, predit: predit.status() });
});

app.delete('/api/predit/channel', (req, res) => {
  predit.configure({ channels: [] });
  res.json(predit.status());
});

app.post('/api/predit/test', async (req, res) => {
  const r = await predit.test();
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/predit/scan', async (req, res) => {
  await predit.tick();
  res.json(predit.status());
});

// --- diagnostic complet des envois de prédictions ---------------------------
app.get('/api/diagnostics/channels', async (req, res) => {
  const bot = botStatus();
  const out = [];
  for (const def of strategies.LIST) {
    const cfg = state.strategies[def.key] || {};
    const entry = { key: def.key, name: def.name, enabled: !!cfg.enabled, silent: !!cfg.silent, published: [], shadow: [], sendError: state.sendErrors[def.key] || null, sentCount: cfg.sentCount || 0, lastSentAt: cfg.lastSentAt || null };
    for (const mode of ['published', 'shadow']) {
      const ids = strategyChannels(def.key, mode);
      for (const id of ids) {
        const check = bot.tokenSet ? await resolveChat(id) : { ok: false, error: 'Aucun token Telegram configuré' };
        entry[mode].push(check.ok
          ? { id, title: check.chat.title, type: check.chat.type, canPost: check.chat.canPost, ok: check.chat.canPost !== false }
          : { id, ok: false, error: check.error });
      }
    }
    entry.ready = !!bot.tokenSet && (entry.published.some((c) => c.ok) || entry.shadow.some((c) => c.ok));
    out.push(entry);
  }
  res.json({ bot, strategies: out });
});

app.listen(config.PORT, '0.0.0.0', () => {
  console.log('Tableau de bord sur le port ' + config.PORT);
  startLoop();
  aiAuto.start(persist);
  console.log('🤖 Analyseur IA temps réel démarré (clé en dur : ' + (ai.keyLooksValid() ? 'oui' : 'à remplacer dans config.js') + ')');
});
