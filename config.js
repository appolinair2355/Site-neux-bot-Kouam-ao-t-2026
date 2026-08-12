// config.js — configuration du bot (surchargeable par variables d'environnement)
module.exports = {
  API_ID: 29177661,
  API_HASH: 'a8639172fa8d35dbfd8ea46286d349ab',
  BOT_TOKEN: process.env.BOT_TOKEN || '7644537698:AAFjBt4dBfCB5YH4hxaPXV1bIXlNyIAQwjc',
  ADMIN_ID: Number(process.env.ADMIN_ID || 1190237801),

  PORT: process.env.PORT || 10000,

  // ---- Base de données PostgreSQL Render (optionnelle) ---------------------
  // Colle ici (ou dans la variable d'env DATABASE_URL) l'External Database URL
  // fournie par Render. Les tables sont créées automatiquement au démarrage.
  // Base PostgreSQL Render par défaut (déjà dans le code : aucune configuration
  // n'est nécessaire au déploiement ; DATABASE_URL peut la remplacer).
  DATABASE_URL:
    process.env.DATABASE_URL ||
    'postgresql://base_de_donnees_hgxo_user:Y121g3HpUQE9YpORWPeudA1MrHPLjeXO@dpg-d9qtu967bikc73ejg52g-a.oregon-postgres.render.com/base_de_donnees_hgxo',

  // ---- API 1xbet Baccara (LiveFeed/GetChampZip, champ 2050671) ------------
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

  // ---- Règles de prédiction ---------------------------------------------
  SUIT_BY_LAST_DIGIT: { 2: '♦️', 5: '❤️', 6: '♣️', 9: '♠️' },
  LEAD: 2,                  // prédiction lancée 2 tours avant la cible

  // Main vérifiée : TOUJOURS le joueur. La main du banquier est seulement
  // enregistrée en base de données, elle n'entre jamais dans les prédictions.
  DEFAULT_HAND: 'joueur',

  // Compteur B : nombre max d'apparitions consécutives comptées ( /setb )
  DEFAULT_B: Number(process.env.B || 3),

  // Rattrapages : nombre de tours vérifiés après le numéro prédit ( /setmaxr )
  DEFAULT_MAX_R: Number(process.env.MAX_R || 2),

  // Style du message de prédiction ( /setformat 1..77 )
  DEFAULT_FORMAT: Number(process.env.TG_FORMAT || 1),
};
