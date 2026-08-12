// db.js — persistance PostgreSQL (Render) : jeux passés par date, prédictions, réglages
// Le lien de la base se règle via DATABASE_URL, /setdb dans Telegram, ou le panel web.
// Les tables sont créées automatiquement au premier démarrage.
let Pool = null;
try { Pool = require('pg').Pool; } catch (_) { /* pg installé au déploiement */ }
const config = require('./config');
const store = require('./store');

let pool = null;
let ready = false;
let lastError = null;
let url = store.read().databaseUrl || config.DATABASE_URL || '';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS games (
  number        BIGINT PRIMARY KEY,
  played_on     DATE        NOT NULL,
  played_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  winner        TEXT,                     -- Joueur / Banquier / Égalité
  player_cards  TEXT[]      DEFAULT '{}', -- ex: {"A♠️","7❤️"}
  banker_cards  TEXT[]      DEFAULT '{}',
  player_suits  TEXT[]      DEFAULT '{}', -- costumes de la main joueur
  banker_suits  TEXT[]      DEFAULT '{}',
  player_value  INT,                      -- valeur baccara 0..9
  banker_value  INT,
  player_parity TEXT,                     -- pair / impair
  banker_parity TEXT,
  player_count  INT,                      -- nombre de cartes
  banker_count  INT,
  phase         TEXT,
  raw           JSONB
);
CREATE INDEX IF NOT EXISTS games_played_on_idx ON games (played_on);

CREATE TABLE IF NOT EXISTS predictions (
  id           BIGSERIAL PRIMARY KEY,
  played_on    DATE        NOT NULL DEFAULT current_date,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  target       BIGINT      NOT NULL,
  suit         TEXT        NOT NULL,
  hand         TEXT        NOT NULL,
  b_value      INT,
  b_counter    INT,
  max_r        INT,
  status       TEXT,                       -- attente / gagne / perdu
  rattrapage   INT,
  hit_number   BIGINT,
  closed_at    TIMESTAMPTZ,
  UNIQUE (target, suit, hand)
);

CREATE TABLE IF NOT EXISTS strategies (
  key        TEXT PRIMARY KEY,
  name       TEXT,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  config     JSONB   NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE predictions ADD COLUMN IF NOT EXISTS strategy TEXT DEFAULT 'costume';
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS label    TEXT;
ALTER TABLE predictions DROP CONSTRAINT IF EXISTS predictions_target_suit_hand_key;
CREATE UNIQUE INDEX IF NOT EXISTS predictions_uniq_idx ON predictions (strategy, target, suit);
`;

function status() {
  return { configured: !!url, ready, error: lastError, url: mask(url) };
}

function mask(u) {
  if (!u) return null;
  return u.replace(/\/\/([^:]+):[^@]*@/, '//$1:••••@');
}

async function connect(newUrl) {
  if (newUrl !== undefined) {
    url = (newUrl || '').trim();
    store.patch({ databaseUrl: url });
  }
  ready = false;
  lastError = null;
  if (pool) { try { await pool.end(); } catch (_) {} pool = null; }
  if (!url) { lastError = 'Aucun lien de base de données configuré'; return status(); }
  if (!Pool) { lastError = "Module 'pg' absent — lance npm install"; return status(); }
  try {
    pool = new Pool({
      connectionString: url,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
      max: 4,
    });
    await pool.query(SCHEMA);
    ready = true;
  } catch (e) {
    lastError = e.message;
    pool = null;
  }
  return status();
}

async function q(sql, params = []) {
  if (!ready || !pool) return null;
  try {
    return await pool.query(sql, params);
  } catch (e) {
    lastError = e.message;
    return null;
  }
}

// ---- jeux ------------------------------------------------------------------
async function saveGame(g) {
  return q(
    `INSERT INTO games (number, played_on, winner, player_cards, banker_cards,
        player_suits, banker_suits, player_value, banker_value,
        player_parity, banker_parity, player_count, banker_count, phase, raw)
     VALUES ($1, current_date, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (number) DO UPDATE SET
       winner=EXCLUDED.winner, player_cards=EXCLUDED.player_cards,
       banker_cards=EXCLUDED.banker_cards, player_suits=EXCLUDED.player_suits,
       banker_suits=EXCLUDED.banker_suits, player_value=EXCLUDED.player_value,
       banker_value=EXCLUDED.banker_value, player_parity=EXCLUDED.player_parity,
       banker_parity=EXCLUDED.banker_parity, player_count=EXCLUDED.player_count,
       banker_count=EXCLUDED.banker_count, phase=EXCLUDED.phase, raw=EXCLUDED.raw`,
    [
      g.number, g.winner, g.player, g.banker, g.playerSuits, g.bankerSuits,
      g.playerValue, g.bankerValue, g.playerParity, g.bankerParity,
      g.playerCards, g.bankerCards, g.phase, JSON.stringify(g),
    ]
  );
}

// jeux d'une date (format accepté : 2026-04-02 ou 2/04/2026)
async function gamesByDate(dateStr, limit = 500) {
  const d = normalizeDate(dateStr);
  if (!d) return [];
  const r = await q(
    `SELECT * FROM games WHERE played_on = $1 ORDER BY number DESC LIMIT $2`,
    [d, limit]
  );
  return r ? r.rows : [];
}

async function dailySummary(dateStr) {
  const d = normalizeDate(dateStr);
  if (!d) return null;
  const r = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE winner='Joueur')::int    AS joueur,
            count(*) FILTER (WHERE winner='Banquier')::int  AS banquier,
            count(*) FILTER (WHERE winner='Égalité')::int   AS egalite,
            count(*) FILTER (WHERE player_parity='pair')::int   AS joueur_pair,
            count(*) FILTER (WHERE player_parity='impair')::int AS joueur_impair,
            count(*) FILTER (WHERE banker_parity='pair')::int   AS banquier_pair,
            count(*) FILTER (WHERE banker_parity='impair')::int AS banquier_impair
     FROM games WHERE played_on = $1`,
    [d]
  );
  return r ? { date: d, ...r.rows[0] } : null;
}

function normalizeDate(s) {
  if (!s) return new Date().toISOString().slice(0, 10);
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // 2/04/2026
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// ---- prédictions -----------------------------------------------------------
async function savePrediction(p, bValue) {
  return q(
    `INSERT INTO predictions (target, suit, hand, b_value, b_counter, max_r, status, strategy, label)
     VALUES ($1,$2,$3,$4,$5,$6,'attente',$7,$8)
     ON CONFLICT (strategy, target, suit) DO NOTHING`,
    [p.target, p.suit || p.cardsLabel || '-', p.hand, bValue, p.counter, p.maxR, p.strategy || 'costume', p.label || null]
  );
}

async function closePrediction(p) {
  return q(
    `UPDATE predictions SET status=$1, rattrapage=$2, hit_number=$3, closed_at=now()
     WHERE strategy=$4 AND target=$5 AND suit=$6`,
    [p.status === 'gagné' ? 'gagne' : 'perdu', p.step, p.hitNumber, p.strategy || 'costume', p.target, p.suit || p.cardsLabel || '-']
  );
}

// ---- stratégies (configurations persistantes) -------------------------------
async function saveStrategy(key, name, cfg) {
  return q(
    `INSERT INTO strategies (key, name, enabled, config, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, enabled=EXCLUDED.enabled,
       config=EXCLUDED.config, updated_at=now()`,
    [key, name || key, !!cfg.enabled, JSON.stringify(cfg)]
  );
}

async function loadStrategies() {
  const r = await q(`SELECT key, name, enabled, config FROM strategies`);
  if (!r) return {};
  const out = {};
  for (const row of r.rows) {
    const cfg = typeof row.config === 'string' ? JSON.parse(row.config || '{}') : row.config || {};
    out[row.key] = { ...cfg, enabled: row.enabled };
  }
  return out;
}

async function deleteStrategy(key) {
  return q(`DELETE FROM strategies WHERE key = $1`, [key]);
}

// bilan des prédictions par stratégie
async function strategyStats(key) {
  const r = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='gagne')::int   AS gagne,
            count(*) FILTER (WHERE status='perdu')::int   AS perdu,
            count(*) FILTER (WHERE status='attente')::int AS attente
       FROM predictions WHERE strategy = $1`, [key]);
  if (!r) return null;
  const row = r.rows[0];
  const done = row.gagne + row.perdu;
  return { ...row, taux: done ? Math.round((row.gagne / done) * 100) : 0 };
}

// dernières prédictions d'une stratégie
async function strategyPredictions(key, limit = 20) {
  const r = await q(
    `SELECT target, suit, label, max_r, status, rattrapage, hit_number, created_at
       FROM predictions WHERE strategy = $1 ORDER BY id DESC LIMIT $2`, [key, limit]);
  return r ? r.rows : [];
}

// suppression administrateur des prédictions d'une stratégie
async function clearPredictions(key) {
  return key
    ? q(`DELETE FROM predictions WHERE strategy = $1`, [key])
    : q(`DELETE FROM predictions`);
}

// ---- réglages --------------------------------------------------------------
async function setSetting(key, value) {
  return q(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [key, String(value)]
  );
}

async function getSetting(key) {
  const r = await q(`SELECT value FROM settings WHERE key=$1`, [key]);
  return r && r.rows[0] ? r.rows[0].value : null;
}


// ---- configuration de l'application (token, canaux, admin, réglages) -------
// Tout est enregistré en base : après un redémarrage, le bot repart avec le
// token, l'ID administrateur, les canaux et les réglages déjà configurés.
async function saveAppConfig(cfg = {}) {
  return setSetting('app_config', JSON.stringify(cfg));
}

async function loadAppConfig() {
  const raw = await getSetting('app_config');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ---- panneau base de données : tout ce qui est stocké ----------------------
async function allSettings() {
  const r = await q(`SELECT key, value FROM settings ORDER BY key`);
  if (!r) return [];
  return r.rows.map((row) => ({
    key: row.key,
    // le token n'est jamais renvoyé en clair au navigateur
    value: /token/i.test(row.key) ? '••••••' : maskConfig(row.key, row.value),
  }));
}

function maskConfig(key, value) {
  if (key !== 'app_config') return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed.botToken) parsed.botToken = parsed.botToken.slice(0, 8) + '••••••';
    return JSON.stringify(parsed);
  } catch (_) { return value; }
}

async function tableCounts() {
  const r = await q(
    `SELECT (SELECT count(*)::int FROM games)       AS games,
            (SELECT count(*)::int FROM predictions) AS predictions,
            (SELECT count(*)::int FROM settings)    AS settings,
            (SELECT count(*)::int FROM strategies)  AS strategies`);
  return r ? r.rows[0] : null;
}

// contenu complet et lisible de la base (panneau « Base de données »)
async function dump(limit = 25) {
  return {
    status: status(),
    counts: await tableCounts(),
    overview: await overview(),
    dates: await availableDates(15),
    games: await lastGames(limit),
    predictions: await lastPredictions(limit),
    strategies: await strategyRows(),
    settings: await allSettings(),
  };
}

async function lastPredictions(limit = 25) {
  const r = await q(
    `SELECT id, strategy, target, suit, label, hand, max_r, status, rattrapage,
            hit_number, played_on, created_at
       FROM predictions ORDER BY id DESC LIMIT $1`, [limit]);
  return r ? r.rows : [];
}

async function strategyRows() {
  const r = await q(`SELECT key, name, enabled, config, updated_at FROM strategies ORDER BY key`);
  if (!r) return [];
  return r.rows.map((row) => ({
    key: row.key,
    name: row.name,
    enabled: row.enabled,
    updated_at: row.updated_at,
    config: typeof row.config === 'string' ? JSON.parse(row.config || '{}') : row.config || {},
  }));
}

// ---- lecture / vérification des données ------------------------------------
// dernier jeux enregistrés (toutes dates)
async function lastGames(limit = 10) {
  const r = await q(
    `SELECT number, played_on, winner, player_cards, player_suits, player_value,
            player_parity, player_count, banker_cards, banker_value, phase
       FROM games ORDER BY number DESC LIMIT $1`, [limit]);
  return r ? r.rows : [];
}

// un jeu précis
async function gameByNumber(n) {
  const r = await q(`SELECT * FROM games WHERE number = $1`, [Number(n)]);
  return r && r.rows[0] ? r.rows[0] : null;
}

// prédictions d'une date
async function predictionsByDate(dateStr, limit = 200) {
  const d = normalizeDate(dateStr);
  if (!d) return [];
  const r = await q(
    `SELECT target, suit, hand, max_r, status, rattrapage, hit_number, created_at
       FROM predictions WHERE played_on = $1 ORDER BY target DESC LIMIT $2`, [d, limit]);
  return r ? r.rows : [];
}

// bilan des prédictions d'une date
async function predictionSummary(dateStr) {
  const d = normalizeDate(dateStr);
  if (!d) return null;
  const r = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='gagne')::int   AS gagne,
            count(*) FILTER (WHERE status='perdu')::int   AS perdu,
            count(*) FILTER (WHERE status='attente')::int AS attente,
            coalesce(round(avg(rattrapage) FILTER (WHERE status='gagne')::numeric, 2), 0) AS r_moyen
       FROM predictions WHERE played_on = $1`, [d]);
  if (!r) return null;
  const row = r.rows[0];
  const done = row.gagne + row.perdu;
  return { date: d, ...row, taux: done ? Math.round((row.gagne / done) * 100) : 0 };
}

// état global des tables (vérification rapide de la base)
async function overview() {
  const r = await q(
    `SELECT (SELECT count(*)::int FROM games)            AS games,
            (SELECT count(*)::int FROM predictions)      AS predictions,
            (SELECT count(*)::int FROM settings)         AS settings,
            (SELECT max(number)   FROM games)            AS dernier_jeu,
            (SELECT min(played_on) FROM games)           AS depuis,
            (SELECT max(played_on) FROM games)           AS jusqua`);
  return r ? r.rows[0] : null;
}

// dates disponibles
async function availableDates(limit = 15) {
  const r = await q(
    `SELECT played_on, count(*)::int AS total FROM games
      GROUP BY played_on ORDER BY played_on DESC LIMIT $1`, [limit]);
  return r ? r.rows : [];
}

// requête SELECT libre (lecture seule) — pratique pour vérifier les données
async function readOnlyQuery(sql, limit = 50) {
  const clean = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!/^select\s/i.test(clean)) return { error: 'Seules les requêtes SELECT sont autorisées.' };
  if (/\b(insert|update|delete|drop|alter|truncate|grant|create)\b/i.test(clean))
    return { error: 'Requête refusée : lecture seule.' };
  const r = await q(`SELECT * FROM (${clean}) AS sub LIMIT ${Math.max(1, Math.min(200, limit))}`);
  if (!r) return { error: lastError || 'Requête échouée' };
  return { rows: r.rows, count: r.rowCount };
}

// helpers génériques (utilisés par l'analyse cumulative)
async function exec(sql, params = []) { return q(sql, params); }
async function rows(sql, params = []) { const r = await q(sql, params); return r ? r.rows : []; }

module.exports = {
  connect, status, saveGame, gamesByDate, dailySummary, exec, rows,
  savePrediction, closePrediction, setSetting, getSetting, normalizeDate,
  saveStrategy, loadStrategies, deleteStrategy, strategyStats, strategyPredictions, clearPredictions,
  lastGames, gameByNumber, predictionsByDate, predictionSummary,
  overview, availableDates, readOnlyQuery,
  saveAppConfig, loadAppConfig, dump, allSettings, lastPredictions, strategyRows, tableCounts,
  get ready() { return ready; },
};
