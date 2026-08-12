// config.js — configuration surchargeable par variables d'environnement
'use strict';

module.exports = {
  // Les secrets ne sont jamais embarqués dans l'archive.
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  ADMIN_ID: Number(process.env.ADMIN_ID || 0),
  PORT: Number(process.env.PORT || 10000),

  // Base PostgreSQL Render optionnelle.
  DATABASE_URL: process.env.DATABASE_URL || '',

  // Analyseur IA Pollinations.ai.
  POLLINATIONS_API_KEY: process.env.POLLINATIONS_API_KEY || '',
  POLLINATIONS_BASE_URL: process.env.POLLINATIONS_BASE_URL || 'https://gen.pollinations.ai/v1',
  POLLINATIONS_MODEL: process.env.POLLINATIONS_MODEL || 'openai',

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