// config.js — configuration du bot Baccara
'use strict';

// ---------------------------------------------------------------------------
// API IA Pollinations — ÉCRITE EN DUR DANS LE CODE (aucune variable Render)
// ---------------------------------------------------------------------------
const POLLINATIONS = {
  BASE_URL: 'https://gen.pollinations.ai',
  CHAT_URL: 'https://gen.pollinations.ai/v1/chat/completions',
  MODELS_URL: 'https://gen.pollinations.ai/v1/models',
  IMAGE_URL: (prompt, model = 'flux') =>
    `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${model}`,
  VIDEO_URL: (prompt, model = 'veo', duration = 4) =>
    `https://gen.pollinations.ai/video/${encodeURIComponent(prompt)}?model=${model}&duration=${duration}`,
  AUDIO_URL: (text, voice = 'nova') =>
    `https://gen.pollinations.ai/audio/${encodeURIComponent(text)}?voice=${voice}`,
  // 🔑 Clé API en dur. Remplace la valeur ci-dessous par ta clé Pollinations.
  // Elle peut aussi être changée à chaud depuis la page « Analyseur IA ».
  API_KEY: 'POLLINATIONS_KEY_A_REMPLACER',
  MODEL: 'openai',
};

module.exports = {
  // Les secrets Telegram ne sont jamais embarqués dans l'archive.
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  ADMIN_ID: Number(process.env.ADMIN_ID || 0),
  PORT: Number(process.env.PORT || 10000),

  // Base PostgreSQL Render optionnelle.
  DATABASE_URL: process.env.DATABASE_URL || '',

  // Analyseur IA Pollinations.ai (en dur).
  POLLINATIONS,
  POLLINATIONS_API_KEY: POLLINATIONS.API_KEY,
  POLLINATIONS_BASE_URL: `${POLLINATIONS.BASE_URL}/v1`,
  POLLINATIONS_MODEL: POLLINATIONS.MODEL,

  // Analyse automatique en temps réel.
  AI_AUTO_ENABLED: true,
  AI_LOCAL_INTERVAL_MS: 15000,   // analyse locale (moteur interne)
  AI_REMOTE_INTERVAL_MS: 180000, // enrichissement Pollinations.ai

  // API 1xbet Baccara (LiveFeed/GetChampZip).
  CHAMP_ID: 2050671,
  API_HOSTS: [
    'https://1xbet.cd/service-api',
    'https://1xbet.com/service-api',
    'https://1xbet-africa.com/service-api',
    'https://1xbet.ng/service-api',
  ],
  PROXIES: [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ],
  POLL_INTERVAL_MS: 1500,

  // Règles de prédiction.
  SUIT_BY_LAST_DIGIT: { 2: '♦️', 5: '❤️', 6: '♣️', 9: '♠️' },
  LEAD: 2,
  DEFAULT_HAND: 'joueur',
  DEFAULT_B: Number(process.env.B || 3),
  DEFAULT_MAX_R: Number(process.env.MAX_R || 2),
  DEFAULT_FORMAT: Number(process.env.TG_FORMAT || 1),
};
