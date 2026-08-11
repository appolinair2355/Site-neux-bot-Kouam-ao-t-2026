// server.js — tableau de bord web (Render) + API JSON. AUCUN mot de passe requis.
const path = require('path');
const express = require('express');
const config = require('./config');
const api = require('./api');
const db = require('./db');
const fmt = require('./formats');
const strategies = require('./strategies');
const {
  state, stats, predictionMessage, recentGames, SUITS,
  setStrategyConfig, resetStrategy, initStrategies, parityRuntime,
  strategyGames, bilanText, gameCategories, gateView, shadowRuntime,
} = require('./predictor');
const { startLoop, startBot, botStatus, activate, deactivate, persist, sendBilan, dropSender, announceConfig, announceMainBot, resolveChat, testSend, saveConfigsToDb, applyDbConfigs } = require('./bot');

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
    channels: state.channels.map((c) => ({ ...c, active: state.activeChannels.includes(c.id) })),
    strategies: strategies.LIST.map((d) => ({
      key: d.key, name: d.name, about: d.about, usesB: !!d.usesB,
      config: state.strategies[d.key] || {}, stats: stats(d.key),
    })),
    predictions: state.predictions.slice(0, 50).map((p) => ({
      strategy: p.strategy, strategyName: p.strategyName, label: p.label,
      target: p.target, suit: p.suit, hand: p.hand, step: p.step, maxR: p.maxR,
      status: p.status, badge: p.badge, reason: p.reason, text: predictionMessage(p),
    })),
    parity: parityRuntime(),
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
    channels: cfg.channels || [],
    channelInfos: cfg.channelInfos || [],
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
  const touched = req.body && (req.body.channels !== undefined || req.body.channelId !== undefined);
  const notice = touched ? await announceConfig(req.params.key) : null;
  res.json({ ok: true, saved: db.ready, notice, ...strategyPayload(req.params.key) });
});

// --- canal d'une stratégie : vérification + confirmation dans le canal ------
app.post('/api/strategies/:key/channel', async (req, res) => {
  const key = req.params.key;
  if (!strategies.BY_KEY[key]) return res.status(404).json({ error: 'Stratégie inconnue' });
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
  const cfg = setStrategyConfig(key, { channelId: String(check.chat.id) });
  const notice = await announceConfig(key);
  cfg.channelInfos = notice.channels || [check.chat];
  persist();
  if (db.ready) await db.saveStrategy(key, strategies.BY_KEY[key].name, cfg);
  res.json({ ok: true, channel: check.chat, notice, ...strategyPayload(key) });
});

// retirer le canal d'une stratégie
app.delete('/api/strategies/:key/channel', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  const cfg = setStrategyConfig(req.params.key, { channels: [], channelInfos: [] });
  persist();
  if (db.ready) await db.saveStrategy(req.params.key, strategies.BY_KEY[req.params.key].name, cfg);
  res.json({ ok: true, ...strategyPayload(req.params.key) });
});

// test d'envoi réel dans le canal configuré
app.post('/api/strategies/:key/test', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  const r = await testSend(req.params.key);
  persist();
  if (!r.ok) return res.status(400).json({ error: r.error || (r.failed || []).map((f) => `${f.id} : ${f.error}`).join(' / ') });
  res.json(r);
});

app.post('/api/strategies/:key/reset', async (req, res) => {
  const cfg = resetStrategy(req.params.key);
  if (!cfg) return res.status(404).json({ error: 'Stratégie inconnue' });
  persist();
  if (db.ready) await db.saveStrategy(req.params.key, strategies.BY_KEY[req.params.key].name, cfg);
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

app.listen(config.PORT, '0.0.0.0', () => {
  console.log('Tableau de bord sur le port ' + config.PORT);
  startLoop();
});
