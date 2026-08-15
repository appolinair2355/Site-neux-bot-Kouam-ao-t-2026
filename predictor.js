// predictor.js — moteur multi-stratégies (main du JOUEUR uniquement)
//
//  • Chaque stratégie possède sa propre configuration (activation, format,
//    rattrapages, compteur B, canaux) enregistrée en base de données.
//  • La vérification se fait TOUJOURS sur la main du joueur :
//      – kind 'suit'  → le costume prédit apparaît-il dans les cartes du joueur ?
//      – kind 'cards' → le joueur a-t-il le nombre de cartes prédit (et le
//        banquier aussi, pour la distribution) ?
//  • La main du banquier n'est utilisée que pour les filtres/statistiques et
//    l'archivage en base de données.
const config = require('./config');
const fmt = require('./formats');
const strategies = require('./strategies');

const BADGES = ['0⃣', '1⃣', '2⃣', '3⃣', '4⃣', '5⃣', '6⃣', '7⃣', '8⃣', '9⃣'];
const SUITS = strategies.SUITS;
const normSuit = strategies.normSuit;

const state = {
  // réglages globaux (compat : ils pilotent la stratégie « costume »)
  B: config.DEFAULT_B,
  maxR: config.DEFAULT_MAX_R,
  hand: 'joueur',
  format: config.DEFAULT_FORMAT,
  template: null,
  channels: [],
  activeChannels: [],
  strategies: {},          // key -> config
  history: [],
  games: new Map(),
  counters: { '♦️': 0, '❤️': 0, '♣️': 0, '♠️': 0 },
  predictions: [],
  aiAnalyses: [],
  aiStrategies: [],
  triggersDone: {},        // "clé:déclencheur" -> true (règle 1 : un seul traitement)
  live: null,
  lastFinished: null,
  lastError: null,
  sendErrors: {},          // clé de stratégie -> dernière erreur d'envoi Telegram
  gates: {},               // clé de stratégie -> filtre d'envoi « double perte »
  autoGates: {},           // clé de stratégie -> déclencheur automatique (perte/rattrapage + N)
  silenceGates: {},        // clé de stratégie -> mode d'activation silencieux (déclencheur + jeu +N)
  freshFinished: [],       // tours terminés depuis la dernière évaluation
  startedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// Configuration des stratégies
// ---------------------------------------------------------------------------
function initStrategies() {
  for (const s of strategies.LIST) {
    const def = strategies.defaultsFor(s.key);
    const cur = state.strategies[s.key];
    if (!cur) { state.strategies[s.key] = def; continue; }
    // une configuration enregistrée avant l'ajout d'un réglage (mode silencieux,
    // fenêtre de pertes…) est complétée sans écraser les choix de l'utilisateur
    for (const [k, v] of Object.entries(def)) if (cur[k] === undefined) cur[k] = v;
    // Migration douce : l'ancien champ `channels` devient le canal public.
    if (!Array.isArray(cur.publishedChannels)) cur.publishedChannels = Array.isArray(cur.channels) ? cur.channels : [];
    if (!Array.isArray(cur.shadowChannels)) cur.shadowChannels = [];
  }
  syncCostume();
  return state.strategies;
}

// la stratégie « costume » reste pilotée par les réglages globaux (compat /setb…)
function syncCostume() {
  const c = state.strategies.costume;
  if (!c) return;
  c.b = state.B;
  c.maxR = state.maxR;
  c.format = state.format;
  c.template = state.template;
}

function pullCostume() {
  const c = state.strategies.costume;
  if (!c) return;
  state.B = c.b;
  state.maxR = c.maxR;
  state.format = c.format;
  state.template = c.template || null;
}

function strategyConfig(key) {
  return state.strategies[key] || null;
}

// "-1001234, -1005678" ou [ -100... ] -> [ -1001234, -1005678 ]
// Accepte les identifiants numériques (-1001234567890) ET les noms publics
// (@mon_canal) : Telegram gère les deux comme chat_id.
function parseChannels(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;]+/);
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

function setStrategyConfig(key, patch = {}) {
  const def = strategies.BY_KEY[key];
  if (!def) return null;
  const cur = state.strategies[key] || strategies.defaultsFor(key);
  const next = { ...cur };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.format !== undefined) next.format = fmt.clampFormat(patch.format);
  if (patch.formatDistribution !== undefined) next.formatDistribution = fmt.clampFormat(patch.formatDistribution);
  if (patch.maxR !== undefined) next.maxR = Math.max(0, Math.min(9, parseInt(patch.maxR, 10) || 0));
  if (patch.b !== undefined) next.b = Math.max(0, parseInt(patch.b, 10) || 0);
  if (patch.lead !== undefined) next.lead = Math.max(1, Math.min(9, parseInt(patch.lead, 10) || 1));
  // paramètres de la stratégie Pair / Impair (VAR)
  if (patch.startGame !== undefined) next.startGame = Math.max(1, parseInt(patch.startGame, 10) || 1);
  if (patch.varStep !== undefined) next.varStep = Math.max(0, Math.min(99, parseInt(patch.varStep, 10) || 0));
  if (patch.decalage !== undefined) next.decalage = Math.max(1, Math.min(99, parseInt(patch.decalage, 10) || 1));
  // stratégie « Carte absente » : nombre de jeux consécutifs sans le costume
  if (patch.streak !== undefined) next.streak = Math.max(2, Math.min(10, parseInt(patch.streak, 10) || 3));
  // stratégie « Prédiction dans l'ombre » : jeux d'absence minimum + périmètre
  if (patch.absence !== undefined) next.absence = Math.max(1, Math.min(30, parseInt(patch.absence, 10) || 4));
  if (patch.scope !== undefined) next.scope = patch.scope === 'joueur' ? 'joueur' : 'tous';
  // mode silencieux (commun à toutes les stratégies)
  if (patch.silent !== undefined) next.silent = !!patch.silent;
  if (patch.lossWindow !== undefined) next.lossWindow = Math.max(1, Math.min(20, parseInt(patch.lossWindow, 10) || 3));
  if (patch.resetOnWin !== undefined) next.resetOnWin = !!patch.resetOnWin;
  if (patch.lossTrigger !== undefined) next.lossTrigger = Math.max(1, Math.min(5, parseInt(patch.lossTrigger, 10) || 2));
  if (patch.lossInterval !== undefined) next.lossInterval = Math.max(0, Math.min(20, parseInt(patch.lossInterval, 10) || 0));
  if (patch.sendOnlyNext !== undefined) next.sendOnlyNext = !!patch.sendOnlyNext;
  // déclencheur automatique (perte / rattrapage + nombre de prédictions)
  if (patch.autoEnabled !== undefined) next.autoEnabled = !!patch.autoEnabled;
  if (patch.autoTrigger !== undefined) next.autoTrigger = patch.autoTrigger === 'rattrapage' ? 'rattrapage' : 'perte';
  if (patch.autoRattrapage !== undefined) next.autoRattrapage = Math.max(1, Math.min(9, parseInt(patch.autoRattrapage, 10) || 1));
  if (patch.autoSkip !== undefined) next.autoSkip = Math.max(0, Math.min(20, parseInt(patch.autoSkip, 10) || 0));
  if (patch.autoSend !== undefined) next.autoSend = Math.max(1, Math.min(10, parseInt(patch.autoSend, 10) || 1));
  // --- mode d'activation silencieux --------------------------------------
  if (patch.silenceMode !== undefined) next.silenceMode = !!patch.silenceMode;
  if (patch.silenceTrigger !== undefined) next.silenceTrigger = patch.silenceTrigger === 'rattrapage' ? 'rattrapage' : 'perte';
  if (patch.silenceLossCount !== undefined) next.silenceLossCount = Math.max(1, Math.min(5, parseInt(patch.silenceLossCount, 10) || 1));
  if (patch.silenceRatLevel !== undefined) next.silenceRatLevel = Math.max(1, Math.min(9, parseInt(patch.silenceRatLevel, 10) || 2));
  if (patch.silenceRatCount !== undefined) next.silenceRatCount = Math.max(1, Math.min(5, parseInt(patch.silenceRatCount, 10) || 1));
  if (patch.silenceOffset !== undefined) next.silenceOffset = Math.max(0, Math.min(99, parseInt(patch.silenceOffset, 10) || 0));
  if (patch.silenceInterval !== undefined) next.silenceInterval = Math.max(0, Math.min(20, parseInt(patch.silenceInterval, 10) || 0));
  if (patch.silenceCount !== undefined) next.silenceCount = Math.max(1, Math.min(50, parseInt(patch.silenceCount, 10) || 1));
  if (patch.silenceChannels !== undefined || patch.silenceChannelId !== undefined) {
    const value = patch.silenceChannels !== undefined ? patch.silenceChannels : patch.silenceChannelId;
    next.silenceChannels = parseChannels(value);
    if (JSON.stringify(next.silenceChannels) !== JSON.stringify(cur.silenceChannels || [])) next.silenceChannelInfos = [];
  }
  if (patch.silenceChannelInfos !== undefined) next.silenceChannelInfos = patch.silenceChannelInfos || [];
  if (patch.autoUnlockMin !== undefined) next.autoUnlockMin = Math.max(0, Math.min(240, parseInt(patch.autoUnlockMin, 10) || 0));
  if (patch.template !== undefined) next.template = patch.template ? String(patch.template) : null;
  if (patch.channels !== undefined || patch.channelId !== undefined || patch.publishedChannels !== undefined) {
    const value = patch.publishedChannels !== undefined
      ? patch.publishedChannels
      : patch.channels !== undefined ? patch.channels : patch.channelId;
    next.publishedChannels = parseChannels(value);
    next.channels = next.publishedChannels;
    if (JSON.stringify(next.publishedChannels) !== JSON.stringify(cur.publishedChannels || cur.channels || [])) {
      next.channelInfos = [];
      next.publishedChannelInfos = [];
    }
  }
  if (patch.shadowChannels !== undefined || patch.shadowChannelId !== undefined) {
    const value = patch.shadowChannels !== undefined ? patch.shadowChannels : patch.shadowChannelId;
    next.shadowChannels = parseChannels(value);
    if (JSON.stringify(next.shadowChannels) !== JSON.stringify(cur.shadowChannels || [])) {
      next.shadowChannelInfos = [];
    }
  }
  if (patch.channelInfos !== undefined) next.channelInfos = patch.channelInfos || [];
  if (patch.publishedChannelInfos !== undefined) next.publishedChannelInfos = patch.publishedChannelInfos || [];
  if (patch.shadowChannelInfos !== undefined) next.shadowChannelInfos = patch.shadowChannelInfos || [];
  // un seul token API pour toute l'application (réglages) : plus de token par stratégie
  delete next.token;
  if (patch.bilan !== undefined) next.bilan = !!patch.bilan;
  state.strategies[key] = next;
  // un changement de réglage du déclencheur automatique repart d'un état propre
  if (patch.autoEnabled !== undefined || patch.autoTrigger !== undefined
      || patch.autoRattrapage !== undefined || patch.autoSkip !== undefined
      || patch.autoSend !== undefined) resetAutoGate(key);
  // un changement de réglage du mode silencieux repart aussi d'un état propre
  if (patch.silenceMode !== undefined || patch.silenceTrigger !== undefined
      || patch.silenceLossCount !== undefined || patch.silenceRatLevel !== undefined
      || patch.silenceRatCount !== undefined || patch.silenceOffset !== undefined
      || patch.silenceCount !== undefined || patch.silenceInterval !== undefined) resetSilenceGate(key);
  // l'intervalle max est partagé par les deux modes : on repart d'un état propre
  if (patch.lossInterval !== undefined || patch.lossTrigger !== undefined
      || patch.lossWindow !== undefined) { resetGate(key); resetSilenceGate(key); }
  if (key === 'costume') pullCostume();
  return next;
}

function resetStrategy(key) {
  if (!strategies.BY_KEY[key]) return null;
  state.strategies[key] = strategies.defaultsFor(key);
  if (key === 'costume') pullCostume();
  return state.strategies[key];
}

function strategyChannels(key, mode = 'published') {
  const c = state.strategies[key];
  if (!c) return mode === 'published' ? state.activeChannels : [];
  if (mode === 'silence') {
    const own = Array.isArray(c.silenceChannels) ? c.silenceChannels : [];
    if (own.length) return own;
    return Array.isArray(c.shadowChannels) ? c.shadowChannels : [];
  }
  if (mode === 'shadow') return Array.isArray(c.shadowChannels) ? c.shadowChannels : [];
  const configured = Array.isArray(c.publishedChannels)
    ? c.publishedChannels
    : Array.isArray(c.channels) && c.channels.length ? c.channels : state.activeChannels;
  const shadow = new Set(Array.isArray(c.shadowChannels) ? c.shadowChannels : []);
  // Un canal ne reçoit jamais les deux catégories pour une même stratégie.
  return configured.filter((id) => !shadow.has(id));
}


// ---------------------------------------------------------------------------
// Filtre d'envoi « double perte » (mode silencieux)
// ---------------------------------------------------------------------------
// Tant que le mode silencieux est actif, la stratégie travaille dans l'ombre :
// elle calcule et vérifie ses prédictions SANS rien envoyer dans le canal.
//   1) une 1ʳᵉ perte ouvre une fenêtre de vérification ;
//   2) la fenêtre autorise au MAXIMUM `lossWindow` prédictions terminées ;
//   3) si une 2ᵉ perte tombe dans cette fenêtre → l'envoi est ACTIVÉ
//      (perte+perte = 1 prédiction dans la fenêtre, perte/gagné/perte = 2…) ;
//   4) si la fenêtre est dépassée sans 2ᵉ perte → tout repart à zéro ;
//   5) une fois l'envoi activé, une prédiction gagnée referme l'envoi
//      (réglage `resetOnWin`, activé par défaut) et on repart à zéro.
// Déblocage automatique : une stratégie bloquée (mode silencieux, en attente de
// pertes) est AUTOMATIQUEMENT débloquée au bout de `autoUnlockMin` minutes
// (10 min par défaut). Le blocage ne peut donc jamais durer indéfiniment.
const AUTO_UNLOCK_DEFAULT_MIN = 10;

function autoUnlockMs(cfg) {
  const min = cfg && cfg.autoUnlockMin !== undefined
    ? parseInt(cfg.autoUnlockMin, 10)
    : AUTO_UNLOCK_DEFAULT_MIN;
  if (!Number.isFinite(min) || min <= 0) return 0; // 0 = déblocage auto désactivé
  return Math.min(240, min) * 60 * 1000;
}

function emptyGate() {
  return {
    armed: false, losses: 0, window: 0, since: null,
    counting: false, need: 0, seen: 0,
    blockedSince: Date.now(), autoUnlockedAt: null,
  };
}

function gate(key) {
  if (!state.gates[key]) state.gates[key] = emptyGate();
  const g = state.gates[key];
  if (g.blockedSince == null) g.blockedSince = Date.now();
  if (g.counting === undefined) { g.counting = false; g.need = 0; g.seen = 0; }
  return g;
}

function resetGate(key) {
  state.gates[key] = emptyGate();
  return state.gates[key];
}

// déblocage manuel (bouton du panneau / commande Telegram)
function unlockGate(key, manual = true) {
  const g = gate(key);
  g.armed = true;
  g.losses = Math.max(g.losses, 1);
  g.window = 0;
  g.blockedSince = null;
  g.autoUnlockedAt = Date.now();
  g.autoUnlockReason = manual ? 'déblocage manuel' : 'déblocage automatique (10 min)';
  const cfg = state.strategies[key];
  if (cfg && cfg.autoEnabled) { const a = autoGate(key); a.armed = true; a.counting = false; a.reason = 'déblocage manuel'; }
  return g;
}

// applique le déblocage automatique si le délai est écoulé
function applyAutoUnlock(key) {
  const cfg = state.strategies[key];
  if (!cfg || !cfg.silent) return false;
  const g = gate(key);
  if (g.armed) return false;
  const delay = autoUnlockMs(cfg);
  if (!delay) return false;
  if (g.blockedSince == null) { g.blockedSince = Date.now(); return false; }
  if (Date.now() - g.blockedSince < delay) return false;
  unlockGate(key, false);
  return true;
}

// balayage périodique de toutes les stratégies (appelé par la boucle du bot)
function sweepAutoUnlock() {
  const freed = [];
  for (const key of Object.keys(state.strategies || {})) {
    if (applyAutoUnlock(key)) freed.push(key);
  }
  return freed;
}

function windowSize(cfg) {
  return Math.max(1, Math.min(20, parseInt(cfg && cfg.lossWindow, 10) || 3));
}

// intervalle MAXIMUM (écart, en nombre de prédictions terminées) autorisé entre
// la perte de référence et la perte suivante pour que celle-ci CONFIRME.
// Intervalle configuré 0-4 (max = 4) :
//   • écart < 4  → perte confirmée (N = écart) ;
//   • écart >= 4 → perte trop loin : elle devient la NOUVELLE référence.
// 0 = aucune limite (toute perte suivante confirme).
function lossIntervalMax(cfg) {
  return Math.max(0, Math.min(20, parseInt(cfg && cfg.lossInterval, 10) || 0));
}

// (compat) ancien nom conservé pour les appels externes
function lossIntervalMin(cfg) { return lossIntervalMax(cfg); }

// phase 2 : cette perte devient la référence, la fenêtre d'écart repart de 0
function startWindow(key, target) {
  const g = gate(key);
  g.armed = false;
  g.counting = false;
  g.seen = 0;
  g.need = 0;
  g.losses = 1;
  g.window = 0;
  g.since = target;
  if (g.blockedSince == null) g.blockedSince = Date.now();
  g.autoUnlockReason = null;
  return g;
}

// mise à jour du filtre à chaque prédiction terminée
function noteClosed(pred) {
  const cfg = state.strategies[pred.strategy];
  if (!cfg) return;
  noteClosedAuto(pred);
  noteClosedSilence(pred);
  const g = gate(pred.strategy);
  const win = pred.status === 'gagné';
  const max = windowSize(cfg);

  // nombre de pertes nécessaires avant d'ouvrir l'envoi (1 = envoi dès la 1ʳᵉ perte)
  const need = Math.max(1, Math.min(5, parseInt(cfg.lossTrigger, 10) || 2));
  const maxGap = lossIntervalMax(cfg);

  // --- envoi déjà ouvert (prédiction publiée) -----------------------------
  if (g.armed) {
    if (win) { if (cfg.resetOnWin !== false) resetGate(pred.strategy); return; }
    // perte : elle devient la nouvelle référence → retour phase 2
    startWindow(pred.strategy, pred.target);
    return;
  }

  // --- phase 3 : décompte silencieux vers la position N -------------------
  if (g.counting) {
    g.seen += 1;
    if (!win) {
      // interruption : la perte devient la nouvelle référence → phase 2
      startWindow(pred.strategy, pred.target);
      return;
    }
    if (g.seen >= Math.max(1, g.need) - 1) {
      g.counting = false;
      g.armed = true;
      g.blockedSince = null;
    }
    return;
  }

  // --- phase 1 : aucune référence, on attend la 1ʳᵉ perte ----------------
  if (g.losses === 0) {
    if (!win) {
      startWindow(pred.strategy, pred.target);
      // avec lossTrigger = 1 la première perte suffit : on ouvre l'envoi
      if (need <= 1) { g.armed = true; g.blockedSince = null; }
    }
    return;
  }

  // --- phase 2 : fenêtre ouverte, on mesure l'écart ----------------------
  g.window += 1;
  if (!win) {
    if (maxGap && g.window >= maxGap) {
      // trop loin : cette perte devient la nouvelle référence
      startWindow(pred.strategy, pred.target);
      return;
    }
    g.losses += 1;
    if (g.losses >= need) {
      // perte confirmée : N = écart mesuré → phase 3 (décompte silencieux)
      const N = Math.max(1, g.window);
      g.window = 0;
      if (N <= 1) {
        // N = 1 → la prochaine prédiction part directement en public
        g.armed = true; g.counting = false; g.need = 1; g.seen = 0; g.blockedSince = null;
      } else {
        g.counting = true; g.need = N; g.seen = 0;
      }
    }
    return;
  }
  // sans intervalle max configuré, on garde la limite « lossWindow »
  if (!maxGap && g.window >= max) resetGate(pred.strategy);
}


// ---------------------------------------------------------------------------
// Déclencheur automatique : « perte + N prédictions » ou « rattrapage X + N »
// ---------------------------------------------------------------------------
// Fonctionnement (commun à TOUTES les stratégies, indépendant du mode silencieux) :
//   1) le bot attend l'ÉVÉNEMENT déclencheur configuré :
//        • autoTrigger = 'perte'      → une prédiction perdue (❌)
//        • autoTrigger = 'rattrapage' → une prédiction terminée AU rattrapage
//          demandé ou au-delà (ex. rattrapage 2 → gagnée en 2 ou perdue après 2)
//   2) après ce déclencheur il COMPTE `autoSkip` prédictions terminées, qui
//      restent silencieuses (visibles sur le site / canal silencieux) ;
//   3) la prédiction SUIVANTE part automatiquement dans le canal public ;
//      `autoSend` permet d'en envoyer plusieurs d'affilée (1 par défaut) ;
//   4) le compteur repart ensuite à zéro et attend un nouveau déclencheur.
// Exemples : « perte + 3 prédictions » → ❌ · P1 P2 P3 (silence) · P4 ENVOYÉE.
//            « rattrapage 2 + 3 prédictions » → ✅2 · P1 P2 P3 · P4 ENVOYÉE.
function autoCfg(cfg) {
  return {
    enabled: !!(cfg && cfg.autoEnabled),
    trigger: cfg && cfg.autoTrigger === 'rattrapage' ? 'rattrapage' : 'perte',
    level: Math.max(1, Math.min(9, parseInt(cfg && cfg.autoRattrapage, 10) || 2)),
    skip: Math.max(0, Math.min(20, parseInt(cfg && cfg.autoSkip, 10) || 0)),
    send: Math.max(1, Math.min(10, parseInt(cfg && cfg.autoSend, 10) || 1)),
  };
}

function autoGate(key) {
  if (!state.autoGates[key]) state.autoGates[key] = { armed: false, counting: false, seen: 0, sent: 0, triggeredAt: null, reason: null };
  return state.autoGates[key];
}

function resetAutoGate(key) {
  state.autoGates[key] = { armed: false, counting: false, seen: 0, sent: 0, triggeredAt: null, reason: null };
  return state.autoGates[key];
}

function isAutoTrigger(pred, a) {
  if (a.trigger === 'perte') return pred.status === 'perdu';
  return (pred.step || 0) >= a.level;    // rattrapage atteint (gagné ou perdu)
}

// mise à jour du déclencheur automatique à chaque prédiction terminée
function noteClosedAuto(pred) {
  const a = autoCfg(state.strategies[pred.strategy]);
  if (!a.enabled) return;
  const g = autoGate(pred.strategy);
  if (g.armed) return;                    // une prédiction est déjà autorisée
  if (isAutoTrigger(pred, a)) {
    g.counting = true;
    g.seen = 0;
    g.sent = 0;
    g.triggeredAt = pred.target;
    g.reason = a.trigger === 'perte'
      ? `perte sur #N${pred.target}`
      : `rattrapage ${pred.step} sur #N${pred.target}`;
    if (a.skip === 0) { g.armed = true; g.counting = false; }
    return;
  }
  if (!g.counting) return;
  g.seen += 1;
  if (g.seen >= a.skip) { g.armed = true; g.counting = false; }
}

// consommation : appelée après l'envoi public d'une prédiction
function noteSent(key) {
  const a = autoCfg(state.strategies[key]);
  if (!a.enabled) return;
  const g = autoGate(key);
  if (!g.armed) return;
  g.sent += 1;
  if (g.sent >= a.send) resetAutoGate(key);
}

// état lisible du déclencheur automatique
function autoView(key) {
  const cfg = state.strategies[key] || {};
  const a = autoCfg(cfg);
  const g = autoGate(key);
  const trigLabel = a.trigger === 'perte' ? 'une perte' : `un rattrapage ${a.level}`;
  return {
    enabled: a.enabled,
    trigger: a.trigger,
    rattrapage: a.level,
    skip: a.skip,
    send: a.send,
    counting: !!g.counting,
    seen: g.seen,
    armed: !!g.armed,
    sent: g.sent,
    triggeredAt: g.triggeredAt,
    label: !a.enabled
      ? 'Déclencheur automatique désactivé'
      : g.armed
        ? `Prochaine prédiction ENVOYÉE automatiquement (${g.sent}/${a.send} envoyée(s))`
        : g.counting
          ? `Déclencheur pris (${g.reason}) : ${g.seen}/${a.skip} prédiction(s) comptée(s)`
          : `En attente de ${trigLabel} (puis ${a.skip} prédiction(s) avant l'envoi)`,
  };
}

// ---------------------------------------------------------------------------
// Mode d'activation SILENCIEUX — 2ᵉ MODE
// ---------------------------------------------------------------------------
// Différence avec le 1ᵉʳ mode silencieux (filtre « double perte ») : ici il n'y
// a AUCUN décompte de position N. Le 2ᵉ mode ne compte ni la 1ʳᵉ ni la 2ᵉ
// prédiction : dès que la 2ᵉ perte tombe DANS l'intervalle configuré, la
// prédiction du JEU SUIVANT est envoyée directement.
//   1) on attend l'événement de référence (perte, ou rattrapage ≥ niveau) ;
//   2) on mesure l'écart (nombre de prédictions terminées) jusqu'à l'événement
//      suivant : écart ≥ intervalle max → trop loin, il devient la nouvelle
//      référence ; écart < intervalle max → CONFIRMÉ ;
//   3) confirmation → la prédiction suivante part immédiatement dans le canal
//      silencieux configuré (pas de décompte) ;
//   4) après `silenceCount` prédictions envoyées, la fenêtre repart à zéro.
function silenceCfg(cfg) {
  const inherited = Math.max(0, Math.min(20, parseInt(cfg && cfg.lossInterval, 10) || 0));
  const own = cfg && cfg.silenceInterval !== undefined && cfg.silenceInterval !== null
    ? Math.max(0, Math.min(20, parseInt(cfg.silenceInterval, 10) || 0))
    : null;
  return {
    enabled: !!(cfg && cfg.silenceMode),
    trigger: cfg && cfg.silenceTrigger === 'rattrapage' ? 'rattrapage' : 'perte',
    lossCount: Math.max(1, Math.min(5, parseInt(cfg && cfg.silenceLossCount, 10) || 1)),
    ratLevel: Math.max(1, Math.min(9, parseInt(cfg && cfg.silenceRatLevel, 10) || 2)),
    ratCount: Math.max(1, Math.min(5, parseInt(cfg && cfg.silenceRatCount, 10) || 1)),
    offset: Math.max(0, Math.min(99, parseInt(cfg && cfg.silenceOffset, 10) || 0)),
    interval: own === null ? inherited : own,
    count: Math.max(1, Math.min(50, parseInt(cfg && cfg.silenceCount, 10) || 1)),
  };
}

function emptySilenceGate() {
  return { hits: 0, armed: false, from: null, sent: 0, window: 0, since: null, triggeredAt: null, reason: null };
}

function silenceGate(key) {
  if (!state.silenceGates[key]) state.silenceGates[key] = emptySilenceGate();
  const g = state.silenceGates[key];
  if (g.window === undefined) { g.window = 0; g.since = null; }
  return g;
}

function resetSilenceGate(key) {
  state.silenceGates[key] = emptySilenceGate();
  return state.silenceGates[key];
}

// nouvelle référence pour le 2ᵉ mode
function openSilenceWindow(key, target, label) {
  state.silenceGates[key] = {
    hits: 1, armed: false, from: null, sent: 0,
    window: 0, since: target, triggeredAt: target,
    reason: label || `référence #N${target}`,
  };
  return state.silenceGates[key];
}

function isSilenceEvent(pred, s) {
  if (s.trigger === 'perte') return pred.status === 'perdu';
  return (pred.step || 0) >= s.ratLevel;
}

// mise à jour à chaque prédiction terminée
function noteClosedSilence(pred) {
  const cfg = state.strategies[pred.strategy];
  const s = silenceCfg(cfg);
  if (!s.enabled) return;
  const g = silenceGate(pred.strategy);
  const ev = isSilenceEvent(pred, s);
  const need = s.trigger === 'perte' ? s.lossCount : s.ratCount;
  const label = s.trigger === 'perte' ? 'perte' : `rattrapage ${s.ratLevel}`;

  // fenêtre d'envoi ouverte : un nouvel événement redevient la référence
  if (g.armed) {
    if (ev) openSilenceWindow(pred.strategy, pred.target, `nouvelle référence (${label} sur #N${pred.target})`);
    return;
  }

  // phase 1 : aucune référence
  if (!g.hits || g.since == null) {
    if (!ev) return;
    openSilenceWindow(pred.strategy, pred.target, `référence : ${label} sur #N${pred.target}`);
    if (need <= 1) armSilence(pred.strategy, pred.target, `${label} sur #N${pred.target}`);
    return;
  }

  // phase 2 : mesure de l'écart jusqu'à l'événement suivant
  g.window += 1;
  if (!ev) return;
  if (s.interval && g.window >= s.interval) {
    openSilenceWindow(pred.strategy, pred.target, `écart ${g.window} trop grand → nouvelle référence #N${pred.target}`);
    return;
  }
  g.hits += 1;
  if (g.hits < need) return;
  armSilence(pred.strategy, pred.target, `${need} ${label}(s) confirmée(s) sur #N${pred.target} (écart ${g.window})`);
}

// ouverture immédiate de l'envoi silencieux (jeu suivant, sans décompte)
function armSilence(key, target, reason) {
  const g = silenceGate(key);
  g.armed = true;
  g.hits = 0;
  g.window = 0;
  g.sent = 0;
  g.triggeredAt = target;
  g.from = null;             // pas de décalage : la prédiction suivante part
  g.reason = reason;
  return g;
}

// cette prédiction doit-elle partir dans le canal silencieux ?
function silenceShouldSend(pred) {
  const cfg = state.strategies[pred.strategy];
  const s = silenceCfg(cfg);
  if (!s.enabled) return false;
  const g = silenceGate(pred.strategy);
  if (!g.armed) return false;
  if (g.sent >= s.count) { resetSilenceGate(pred.strategy); return false; }
  return true;
}

// consommation après un envoi silencieux
function noteSilenceSent(key) {
  const s = silenceCfg(state.strategies[key]);
  if (!s.enabled) return;
  const g = silenceGate(key);
  if (!g.armed) return;
  g.sent += 1;
  if (g.sent >= s.count) resetSilenceGate(key);
}

// état lisible du mode silencieux
function silenceView(key) {
  const cfg = state.strategies[key] || {};
  const s = silenceCfg(cfg);
  const g = silenceGate(key);
  const need = s.trigger === 'perte' ? s.lossCount : s.ratCount;
  const wait = s.trigger === 'perte'
    ? `${need} perte(s)`
    : `${need} fois un rattrapage ${s.ratLevel}`;
  return {
    enabled: s.enabled,
    trigger: s.trigger,
    lossCount: s.lossCount,
    ratLevel: s.ratLevel,
    ratCount: s.ratCount,
    offset: s.offset,
    interval: s.interval,
    count: s.count,
    armed: !!g.armed,
    hits: g.hits,
    window: g.window,
    since: g.since,
    from: g.from,
    sent: g.sent,
    triggeredAt: g.triggeredAt,
    reason: g.reason || null,
    channels: strategyChannels(key, 'silence'),
    label: !s.enabled
      ? "Mode d'activation silencieux désactivé"
      : g.armed
        ? `Envoi silencieux ACTIF (${g.reason || 'confirmé'}) — ${g.sent}/${s.count} prédiction(s) envoyée(s)`
        : g.since != null
          ? `Référence #N${g.since} — écart ${g.window}` +
            (s.interval ? ` (confirmation si écart < ${s.interval})` : '') +
            ` — ${g.hits}/${need} ${s.trigger === 'perte' ? 'perte(s)' : 'rattrapage(s)'}`
          : `En attente de ${wait} (puis envoi de la prédiction SUIVANTE, ${s.count} au total)`,
  };
}

// une prédiction de cette stratégie peut-elle partir dans le canal ?
function canSend(key) {
  const cfg = state.strategies[key];
  if (!cfg) return true;
  // le déclencheur automatique remplace le filtre « double perte » quand il est actif
  if (cfg.autoEnabled) return !!autoGate(key).armed;
  if (!cfg.silent) return true;
  applyAutoUnlock(key);
  return !!gate(key).armed;
}

// consommation après un envoi public déclenché par le filtre « double perte » :
// si `sendOnlyNext` est activé, une seule prédiction part puis le filtre repasse
// en silence (attente d'une nouvelle 1ʳᵉ perte) au lieu d'envoyer en continu.
function noteGateSent(key) {
  const cfg = state.strategies[key];
  if (!cfg || cfg.autoEnabled || !cfg.silent || !cfg.sendOnlyNext) return;
  const g = gate(key);
  if (!g.armed) return;
  resetGate(key);
}

// état lisible du filtre (panel web / Telegram)
function gateView(key) {
  const cfg = state.strategies[key] || {};
  applyAutoUnlock(key);
  const g = gate(key);
  const max = windowSize(cfg);
  const need = Math.max(1, Math.min(5, parseInt(cfg.lossTrigger, 10) || 2));
  const maxGap = lossIntervalMax(cfg);
  const delay = autoUnlockMs(cfg);
  const waitedMs = g.blockedSince ? Date.now() - g.blockedSince : 0;
  const phase = g.armed ? 3 : g.counting ? 3 : g.losses >= 1 ? 2 : 1;
  return {
    lossTrigger: need,
    lossInterval: maxGap,
    autoUnlockMin: delay ? Math.round(delay / 60000) : 0,
    autoUnlockInSec: delay && g.blockedSince && !g.armed ? Math.max(0, Math.round((delay - waitedMs) / 1000)) : null,
    autoUnlocked: !!g.autoUnlockedAt,
    autoUnlockReason: g.autoUnlockReason || null,
    silent: !!cfg.silent,
    auto: autoView(key),
    silence: silenceView(key),
    lossWindow: max,
    resetOnWin: cfg.resetOnWin !== false,
    sendOnlyNext: !!cfg.sendOnlyNext,
    armed: !!g.armed,
    losses: g.losses,
    used: g.window,
    phase,
    counting: !!g.counting,
    position: g.need || null,
    seen: g.seen || 0,
    since: g.since,
    left: g.losses === 1 && !maxGap ? Math.max(0, max - g.window) : null,
    sending: canSend(key),
    label: cfg.autoEnabled
      ? autoView(key).label
      : !cfg.silent
      ? 'Envoi direct (mode silencieux désactivé)'
      : g.armed
        ? (g.autoUnlockReason
            ? `Envoi ACTIF (${g.autoUnlockReason})`
            : `Phase 3 — prédiction ${g.need ? `n°${g.need} ` : ''}ENVOYÉE publiquement${cfg.sendOnlyNext ? ' — puis retour au silence' : ''}`)
        : g.counting
          ? `Phase 3 — décompte silencieux : ${g.seen}/${Math.max(1, g.need) - 1} avant la position N=${g.need}`
          : g.losses >= 1
            ? `Phase 2 — référence #N${g.since} · écart ${g.window}` +
              (maxGap ? ` (confirmation si écart < ${maxGap})` : ` (fenêtre ${g.window}/${max})`) +
              ` — ${g.losses}/${need} perte(s)`
            : delay
              ? `Phase 1 — on attend la 1ʳᵉ perte (déblocage auto dans ${Math.max(0, Math.round((delay - waitedMs) / 60000))} min)`
              : "Phase 1 — on attend la 1ʳᵉ perte",
  };
}

// ---------------------------------------------------------------------------
// Lecture des mains
// ---------------------------------------------------------------------------
function handSuits(game) {
  if (!game) return [];
  return strategies.suitsOf(game.playerSuits);
}

function hasSuit(game, suit) {
  const want = normSuit(suit);
  if (!want) return false;
  return handSuits(game).includes(want);
}

function suitForNumber(n) {
  return strategies.suitForNumber(n);
}

function nextTarget(current) {
  for (let n = current + config.LEAD; n < current + 40; n++) {
    if (suitForNumber(n)) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Enregistrement des jeux + détection du jeu LIVE
// ---------------------------------------------------------------------------
let onFinishedHook = null;
function setOnFinished(fn) { onFinishedHook = fn; }

// ---------------------------------------------------------------------------
// Nouveau sabot : la table repart au jeu n°1
// ---------------------------------------------------------------------------
// CORRECTIF : sans remise à zéro, `maxFinishedNumber()` gardait l'ancien numéro
// (ex. 1440) alors que les nouveaux jeux repartent à 1. Toutes les cibles
// calculées étaient donc considérées comme « déjà jouées » et PLUS AUCUNE
// prédiction ne sortait après l'envoi du bilan.
function resetShoe(reason = 'nouveau sabot') {
  state.games.clear();
  state.history = [];
  state.freshFinished = [];
  state.triggersDone = {};
  state.lastFinished = null;
  for (const s of SUITS) state.counters[s] = 0;
  // les prédictions encore en attente visaient l'ancien sabot : elles sont closes
  for (const p of state.predictions) {
    if (p.status === 'en attente') { p.status = 'annulé'; p.badge = '♻️'; }
  }
  state.shoeResetAt = Date.now();
  state.shoeResetReason = reason;
  return true;
}

function isNewShoe(incoming) {
  const maxDone = maxFinishedNumber();
  if (!maxDone || !incoming.length) return false;
  const numbers = incoming.map((g) => g.number).filter((n) => Number.isFinite(n));
  if (!numbers.length) return false;
  const minIn = Math.min(...numbers);
  const maxIn = Math.max(...numbers);
  // le flux redescend nettement sous le dernier tour connu → la table a rebouclé
  if (maxIn + 10 < maxDone) return true;
  if (minIn <= 1 && maxDone > 10 && !state.games.has(1)) return true;
  // même numéro de tour mais contenu différent (ou tour redevenu « en cours ») :
  // la table a redistribué depuis le début → nouveau sabot
  for (const g of incoming) {
    const prev = state.games.get(g.number);
    if (!prev || !prev.finished) continue;
    if (!g.finished) return true;
    if (signatureOf(g) !== signatureOf(prev)) return true;
  }
  return false;
}

function signatureOf(g) {
  return [
    (g.player || []).join(','), (g.banker || []).join(','),
    g.playerValue, g.bankerValue, g.winner || '',
  ].join('|');
}

function registerGames(games) {
  if (isNewShoe(games)) resetShoe();
  // CORRECTIF : l'API renvoie les jeux du plus RÉCENT au plus ancien. Il faut les
  // traiter dans l'ordre CROISSANT, sinon « lastFinished » devient le jeu le plus
  // ancien : toutes les cibles calculées semblent déjà jouées et AUCUNE
  // prédiction ne sort jamais.
  const ordered = [...games].sort((a, b) => a.number - b.number);
  for (const g of ordered) {
    const prev = state.games.get(g.number);
    state.games.set(g.number, g);
    if (g.finished && (!prev || !prev.finished)) onFinished(g);
  }
  if (state.games.size > 600) {
    const keys = [...state.games.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, state.games.size - 600)) state.games.delete(k);
  }
  // sécurité : le dernier tour terminé est TOUJOURS le plus grand numéro terminé
  const maxDone = maxFinishedNumber();
  if (maxDone && (!state.lastFinished || state.lastFinished.number !== maxDone)) {
    const g = state.games.get(maxDone);
    if (g) state.lastFinished = g;
  }
  state.live = detectLive();
  return state.live;
}

function detectLive() {
  const all = [...state.games.values()].sort((a, b) => a.number - b.number);
  const dealing = all.filter((g) => !g.finished && g.dealing);
  if (dealing.length) return dealing[0];
  const pending = all.filter((g) => !g.finished);
  if (pending.length) return pending[0];
  return state.lastFinished;
}

function maxFinishedNumber() {
  let max = 0;
  for (const g of state.games.values()) if (g.finished && g.number > max) max = g.number;
  return max;
}

// compteur B : 0 si absent, +1 si présent, repart à 1 après avoir atteint B
function bumpCounters(round) {
  const b = state.B;
  for (const s of SUITS) {
    if (hasSuit(round, s)) {
      if (state.counters[s] >= b) state.counters[s] = 1;
      else state.counters[s] += 1;
      if (state.counters[s] > b) state.counters[s] = b;
    } else {
      state.counters[s] = 0;
    }
  }
}

function onFinished(round) {
  state.lastFinished = round;
  state.history.unshift(round);
  state.history = state.history.slice(0, 200);
  bumpCounters(round);
  state.freshFinished.push(round);
  if (state.freshFinished.length > 20) state.freshFinished = state.freshFinished.slice(-20);
  if (onFinishedHook) { try { onFinishedHook(round); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Prédiction : toutes les stratégies actives sont évaluées
// ---------------------------------------------------------------------------
function evaluate() {
  initStrategies();
  syncCostume();
  const out = [];
  // CORRECTIF : plusieurs tours peuvent se terminer entre deux passages. On
  // évalue CHAQUE tour terminé (dans l'ordre) et plus seulement le dernier,
  // sinon un déclencheur (ex. retour de carte pour la stratégie Ombre) est perdu.
  const fresh = state.freshFinished.length
    ? [...state.freshFinished].sort((a, b) => a.number - b.number)
    : state.lastFinished ? [state.lastFinished] : [];
  state.freshFinished = [];
  const jobs = [];
  for (const def of strategies.LIST) {
    const cfg = state.strategies[def.key];
    if (!cfg || !cfg.enabled) continue;
    if (def.source === 'live') {
      if (state.live) jobs.push([def, cfg, state.live]);
    } else {
      for (const g of fresh) jobs.push([def, cfg, g]);
    }
  }
  for (const [def, cfg, source] of jobs) {
    let hit = null;
    try {
      hit = def.detect(source, cfg, { counters: state.counters, games: state.games });
    } catch (e) {
      state.lastError = `${def.key}: ${e.message}`;
      continue;
    }
    if (!hit) continue;
    if (state.predictions.some((p) => p.strategy === def.key && p.target === hit.target)) continue;
    // règle 1 : un jeu déclencheur n'est traité qu'une seule fois
    const trigKey = hit.trigger != null ? `${def.key}:${hit.trigger}` : null;
    if (trigKey && state.triggersDone[trigKey]) continue;
    if (hit.target <= maxFinishedNumber()) {
      // le tour cible est déjà joué (bot lancé en retard) → on marque le
      // déclencheur comme consommé et on attend le suivant, sans rejouer le passé
      if (trigKey) state.triggersDone[trigKey] = true;
      continue;
    }

    const pred = {
      id: `${def.key}-${hit.target}-${Date.now()}`,
      strategy: def.key,
      strategyName: def.name,
      kind: hit.kind,
      target: hit.target,
      suit: hit.suit ? (hit.kind === 'suit' ? normSuit(hit.suit) : hit.suit) : null,
      cardsLabel: hit.cardsLabel || null,
      wantPlayer: hit.wantPlayer != null ? hit.wantPlayer : null,
      wantBanker: hit.wantBanker != null ? hit.wantBanker : null,
      label: hit.label || hit.suit || '',
      reason: hit.reason || '',
      meta: hit.meta || null,
      hand: 'joueur',
      trigger: hit.trigger != null ? hit.trigger : null,
      from: source.number,
      step: 0,
      maxR: cfg.maxR,
      counter: hit.counter != null ? hit.counter : null,
      b: cfg.b || 0,
      format: hit.format || cfg.format,
      template: cfg.template || null,
      sentAt: Date.now(),
      status: 'en attente',
      badge: null,
      result: null,
      hitNumber: null,
      messages: [],
    };
    if (trigKey) state.triggersDone[trigKey] = true;
    state.predictions.unshift(pred);
    out.push(pred);
  }
  state.predictions = state.predictions.slice(0, 300);
  return out;
}

// ---------------------------------------------------------------------------
// Vérification (main du joueur)
// ---------------------------------------------------------------------------
function parityOf(game) {
  if (!game || game.playerValue == null) return null;
  return game.playerValue % 2 === 0 ? 'pair' : 'impair';
}

function matches(pred, game) {
  if (!game) return false;
  if (pred.kind === 'parity') {
    const par = parityOf(game);
    if (!par) return false;
    return par === pred.suit;
  }
  if (pred.kind === 'cards') {
    if (pred.wantPlayer != null && game.playerCards !== pred.wantPlayer) return false;
    if (pred.wantBanker != null && game.bankerCards !== pred.wantBanker) return false;
    return true;
  }
  return hasSuit(game, pred.suit);
}

function resultText(pred, game) {
  if (!game) return null;
  if (pred.kind === 'parity') return `joueur ${game.playerValue ?? '—'} (${parityOf(game) || '—'})`;
  if (pred.kind === 'cards') return `joueur ${game.playerCards}/banquier ${game.bankerCards}`;
  return handSuits(game).join(' ');
}

function verify() {
  const closed = [];
  const maxDone = maxFinishedNumber();
  // CORRECTIF : state.predictions est trié du plus récent au plus ancien.
  // Le filtre « double perte » doit voir les résultats dans l'ordre CHRONOLOGIQUE,
  // sinon la fenêtre après une perte est comptée à l'envers.
  const queue = [...state.predictions].sort((a, b) => a.target - b.target);
  for (const p of queue) {
    if (p.status !== 'en attente') continue;
    let guard = 0;
    while (p.status === 'en attente' && guard++ <= p.maxR + 2) {
      const num = p.target + p.step;
      const g = state.games.get(num);
      if (!g || !g.finished) {
        // le tour manque dans le flux mais des tours plus récents sont déjà
        // terminés → on ne reste pas bloqué, on passe au rattrapage suivant
        if (num < maxDone && (!g || !g.finished)) {
          if (p.step >= p.maxR) {
            p.status = 'perdu';
            p.badge = '❌';
            p.hitNumber = num;
            noteClosed(p);
            closed.push(p);
            break;
          }
          p.step += 1;
          continue;
        }
        break; // le tour est encore en cours : on attend
      }
      if (matches(p, g)) {
        p.status = 'gagné';
        p.badge = BADGES[p.step] || `${p.step}`;
        p.result = resultText(p, g);
        p.hitNumber = num;
        p.game = g;
        noteClosed(p);
        closed.push(p);
        break;
      }
      if (p.step >= p.maxR) {
        p.status = 'perdu';
        p.badge = '❌';
        p.result = resultText(p, g);
        p.hitNumber = num;
        p.game = g;
        noteClosed(p);
        closed.push(p);
        break;
      }
      p.step += 1;
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Rendu des messages
// ---------------------------------------------------------------------------
function predictionText(p) {
  const g = p.game || null;
  return fmt.renderMessage(p.format || state.format, {
    gameNumber: p.target,
    suit: p.suit,
    cardsLabel: p.cardsLabel,
    strategy: p.strategyName || p.strategy,
    maxR: p.maxR != null ? p.maxR : state.maxR,
    status: p.status,
    rattrapage: p.step,
    playerCards: g ? g.player : null,
  }, p.template || null);
}

function predictionMessage(p) {
  return predictionText(p).text;
}

function liveText() {
  const g = state.live;
  if (!g) return '⚠️ Aucun jeu live détecté pour le moment.';
  return (
    `🔴 *JEU LIVE*\n\n` +
    `🔢 Tour : *#N${g.number}*\n` +
    `✋ Main vérifiée : *joueur*\n` +
    `🃏 Costumes joueur : *${handSuits(g).join(' ') || '—'}*\n` +
    `🂠 Cartes : joueur ${(g.player || []).join(' ') || '—'} (${g.playerCards ?? 0}) / banquier ${(g.banker || []).join(' ') || '—'} (${g.bankerCards ?? 0})\n` +
    `🔟 Valeurs : joueur ${g.playerValue ?? '—'} / banquier ${g.bankerValue ?? '—'}\n` +
    `⏳ Phase : ${g.phase || '—'}\n` +
    `📌 État : ${g.finished ? 'terminé' : g.dealing ? 'distribution en cours' : 'en attente des cartes'}\n` +
    `🔢 Compteurs B (${state.B}) : ${SUITS.map((s) => `${s}${state.counters[s]}`).join(' ')}\n` +
    `🧠 Stratégies actives : ${strategies.LIST.filter((s) => state.strategies[s.key] && state.strategies[s.key].enabled).map((s) => s.name).join(', ') || 'aucune'}\n` +
    `✔️ Dernier tour terminé : ${state.lastFinished ? '#N' + state.lastFinished.number : '—'}`
  );
}

function recentGames(limit = 30) {
  return [...state.games.values()].sort((a, b) => b.number - a.number).slice(0, limit);
}

// état courant de la stratégie Pair / Impair (mémoire du moteur, règle 11)
function parityRuntime() {
  const cfg = state.strategies.parite || strategies.defaultsFor('parite');
  const { start, varN, dec } = strategies.normParity(cfg);
  const current = maxFinishedNumber() || (state.live ? state.live.number : 0);
  const last = current >= start ? strategies.lastTriggerAtOrBefore(current, start, varN) : null;
  const next = current >= start ? strategies.nextTriggerAfter(current, start, varN) : start;
  const pending = state.predictions.find((p) => p.strategy === 'parite' && p.status === 'en attente') || null;
  const done = state.predictions.filter((p) => p.strategy === 'parite');
  return {
    enabled: !!cfg.enabled,
    startGame: start,
    varStep: varN,
    varLeft: last != null ? strategies.varCounterAt(strategies.triggerIndexOf(last, start, varN), varN) : varN,
    decalage: dec,
    maxR: cfg.maxR,
    format: cfg.format,
    currentGame: current || null,
    lastTrigger: last,
    nextTrigger: next,
    sequence: strategies.triggerSequence(start, varN, 12, current || null),
    prediction: pending
      ? { target: pending.target, parity: pending.suit, trigger: pending.trigger, step: pending.step, maxR: pending.maxR }
      : null,
    lastClosed: done.find((p) => p.status !== 'en attente') || null,
  };
}

// ---------------------------------------------------------------------------
// Bilan envoyé sur Telegram quand le jeu reprend
// ---------------------------------------------------------------------------
function bilanText(key) {
  const s = stats(key);
  const def = key ? strategies.BY_KEY[key] : null;
  return (
    '📊 STATISTIQUE 📈\n\n' +
    (def ? `🧠 Stratégie : ${def.name}\n\n` : '') +
    `🟢 GAIN : ${s.win}\n` +
    `🔴 PERTE : ${s.loss}\n\n\n` +
    `✅ Taux de réussite : ${s.rate} %`
  );
}

// catégories lisibles d'un tour (vue « bot » du panel)
function gameCategories(g) {
  if (!g) return [];
  const out = [];
  out.push({ label: 'Tour', value: '#N' + g.number, tone: 'info' });
  out.push({
    label: 'Résultat',
    value: g.winner || (g.finished ? '—' : 'en cours'),
    tone: g.winner === 'Joueur' ? 'win' : g.winner === 'Banquier' ? 'loss' : 'wait',
  });
  out.push({ label: 'Costumes joueur', value: handSuits(g).join(' ') || '—', tone: 'suit' });
  out.push({ label: 'Points', value: `J ${g.playerValue ?? '—'} / B ${g.bankerValue ?? '—'}`, tone: 'info' });
  out.push({ label: 'Parité joueur', value: parityOf(g) || '—', tone: 'info' });
  out.push({ label: 'Cartes', value: `${g.playerCards ?? 0}/${g.bankerCards ?? 0}`, tone: 'info' });
  out.push({
    label: 'Phase',
    value: g.finished ? 'terminé' : g.dealing ? 'distribution' : 'attente',
    tone: g.finished ? 'done' : 'live',
  });
  return out;
}

// jeux vus par une stratégie (live + tours récents + prédiction liée)
function gameView(g, key) {
  return {
    number: g.number,
    finished: !!g.finished,
    dealing: !!g.dealing,
    winner: g.winner || null,
    player: g.player || [],
    banker: g.banker || [],
    playerSuits: handSuits(g),
    bankerSuits: strategies.suitsOf(g.bankerSuits),
    playerValue: g.playerValue ?? null,
    bankerValue: g.bankerValue ?? null,
    playerCards: g.playerCards ?? null,
    bankerCards: g.bankerCards ?? null,
    tie: g.playerValue != null && g.bankerValue != null && g.playerValue === g.bankerValue,
    sum: g.playerValue != null && g.bankerValue != null ? g.playerValue + g.bankerValue : null,
    parity: parityOf(g),
    phase: g.phase || null,
    phaseLabel: g.finished ? 'terminé' : g.dealing ? 'distribution en cours' : 'à venir',
    categories: gameCategories(g),
    prediction: (() => {
      const p = state.predictions.find((x) => x.strategy === key && x.target === g.number);
      return p ? { label: p.label, status: p.status, badge: p.badge, step: p.step, maxR: p.maxR } : null;
    })(),
  };
}

// compteur par costume (panneau « Compteur » du tableau de bord)
function counterView() {
  const b = state.B || 1;
  return SUITS.map((s) => ({
    suit: s,
    count: state.counters[s] || 0,
    b,
    ratio: Math.min(100, Math.round(((state.counters[s] || 0) / b) * 100)),
  }));
}

function strategyGames(key, limit = 12) {
  const rows = recentGames(limit).map((g) => gameView(g, key));
  const live = state.live ? gameView(state.live, key) : null;
  // parties à venir : tours connus, non terminés, après le tour live
  const upcoming = [...state.games.values()]
    .filter((g) => !g.finished && (!live || g.number > live.number))
    .sort((a, b) => a.number - b.number)
    .slice(0, 4)
    .map((g) => gameView(g, key));
  return { live, upcoming, games: rows, counters: counterView(), stats: stats(key), bilan: bilanText(key), gate: gateView(key) };
}

function stats(key) {
  const list = key ? state.predictions.filter((p) => p.strategy === key) : state.predictions;
  const done = list.filter((p) => p.status !== 'en attente' && p.status !== 'annulé');
  const win = done.filter((p) => p.status === 'gagné').length;
  return {
    total: list.length,
    win,
    loss: done.length - win,
    pending: list.length - done.length,
    rate: done.length ? Math.round((win / done.length) * 100) : 0,
  };
}


// état courant de la stratégie « Prédiction dans l'ombre » (costumes surveillés)
function shadowRuntime() {
  const cfg = state.strategies.ombre || strategies.defaultsFor('ombre');
  const need = Math.max(1, parseInt(cfg.absence, 10) || 4);
  const scope = cfg.scope === 'joueur' ? 'joueur' : 'tous';
  const last = maxFinishedNumber();
  const suits = SUITS.map((suit) => {
    let gap = 0;
    let holes = 0;
    for (let n = last; n >= 1; n--) {
      const g = state.games.get(n);
      if (!g || !g.finished) { if (++holes > 3) break; continue; }
      holes = 0;
      const list = scope === 'joueur'
        ? strategies.suitsOf(g.playerSuits)
        : [...strategies.suitsOf(g.playerSuits), ...strategies.suitsOf(g.bankerSuits)];
      if (list.includes(suit)) break;
      gap += 1;
    }
    return { suit, absence: gap, watched: gap >= need };
  });
  return {
    enabled: !!cfg.enabled,
    absence: need,
    lead: cfg.lead,
    scope,
    lastGame: last || null,
    suits,
    gate: gateView('ombre'),
    prediction: state.predictions.find((p) => p.strategy === 'ombre' && p.status === 'en attente') || null,
  };
}

// ---------------------------------------------------------------------------
// Panneau « Prédictions » du site : chaque prédiction est listée séparément,
// avec son mode (silencieuse = calculée dans l'ombre, publiée = envoyée dans le
// canal Telegram). Les prédictions silencieuses restent donc VISIBLES sur le
// site même si elles ne partent pas dans le canal.
// ---------------------------------------------------------------------------
function predictionRow(p) {
  return {
    id: p.id,
    strategy: p.strategy,
    strategyName: p.strategyName || p.strategy,
    target: p.target,
    trigger: p.trigger != null ? p.trigger : null,
    label: p.label || p.suit || '',
    suit: p.suit || null,
    kind: p.kind,
    status: p.status,
    badge: p.badge,
    step: p.step,
    maxR: p.maxR,
    reason: p.reason || '',
    format: p.format,
    silent: !!p.silent,
    published: !p.silent && (p.messages || []).length > 0,
    channels: (p.messages || []).map((m) => m.chatId),
    gate: p.gate || null,
    createdAt: p.sentAt || null,
    text: predictionMessage(p),
  };
}

function predictionsPanel(limit = 60) {
  const all = state.predictions.map(predictionRow);
  const byStrategy = {};
  for (const def of strategies.LIST) {
    const rows = all.filter((r) => r.strategy === def.key);
    byStrategy[def.key] = {
      key: def.key,
      name: def.name,
      silentMode: !!(state.strategies[def.key] && state.strategies[def.key].silent),
      gate: gateView(def.key),
      stats: stats(def.key),
      silent: rows.filter((r) => r.silent).slice(0, limit),
      published: rows.filter((r) => !r.silent).slice(0, limit),
    };
  }
  return {
    total: all.length,
    silentCount: all.filter((r) => r.silent).length,
    publishedCount: all.filter((r) => !r.silent).length,
    pending: all.filter((r) => r.status === 'en attente'),
    silent: all.filter((r) => r.silent).slice(0, limit),
    published: all.filter((r) => !r.silent).slice(0, limit),
    all: all.slice(0, limit),
    byStrategy,
    stats: stats(),
  };
}

module.exports = {
  state,
  SUITS,
  predictionRow,
  predictionsPanel,
  evaluate,
  verify,
  registerGames,
  setOnFinished,
  suitForNumber,
  nextTarget,
  handSuits,
  hasSuit,
  predictionText,
  predictionMessage,
  liveText,
  recentGames,
  stats,
  BADGES,
  parityOf,
  parityRuntime,
  initStrategies,
  strategyConfig,
  setStrategyConfig,
  resetStrategy,
  strategyChannels,
  strategyGames,
  gameCategories,
  gameView,
  counterView,
  bilanText,
  parseChannels,
  resetShoe,
  unlockGate,
  applyAutoUnlock,
  sweepAutoUnlock,
  canSend,
  noteGateSent,
  gateView,
  autoView,
  autoGate,
  resetAutoGate,
  noteSent,
  silenceView,
  silenceGate,
  resetSilenceGate,
  silenceShouldSend,
  noteSilenceSent,
  resetGate,
  noteClosed,
  shadowRuntime,
  syncCostume,
  pullCostume,
};
