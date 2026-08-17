// ai-qa.js — « Poser une question à l'IA » : réponses fondées sur les VRAIES
// données du bot (prédictions envoyées, raison de chaque prédiction, état des
// filtres/gates, réglages des stratégies), pas sur des suppositions générales.
//
// Exemple : « Pourquoi la stratégie ombre a prédit le jeu 12 ? » → le module
// retrouve la prédiction ciblant (ou ayant touché) le jeu #12, remonte son
// champ `reason` (rédigé par detect() dans strategies.js, ex. « ❤️ absent
// pendant 5 jeux consécutifs … retour au jeu #N959 → prédiction ❤️ sur #N963
// (+4) ») et le donne à l'IA comme UNIQUE source de vérité pour répondre.
'use strict';

const config = require('./config');
const ai = require('./ai-analyzer');
const db = require('./db');
const strategies = require('./strategies');
const { state, gateView } = require('./predictor');

const MAX_HISTORY = 12; // nombre d'échanges question/réponse gardés en mémoire (par admin)
const runtime = {
  lastAskedAt: null,
  lastError: null,
  history: [], // { question, answer, at }
};

// extrait les numéros de jeu mentionnés dans la question : « jeu 12 »,
// « #N12 », « le 12 », « numéro 12 »…
function extractGameNumbers(text) {
  const found = new Set();
  const re = /#?N?°?\s*(\d{1,6})/gi;
  let m;
  while ((m = re.exec(text))) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) found.add(n);
  }
  return [...found].slice(0, 5);
}

// retrouve, pour un numéro de jeu donné, toute prédiction (mémoire d'abord,
// puis base si absente de la mémoire) ciblant ce jeu ou l'ayant touché.
async function findPredictionsForNumber(number) {
  const fromMemory = (state.predictions || []).filter(
    (p) => p.target === number || p.hitNumber === number
  );
  if (fromMemory.length) {
    return fromMemory.map((p) => ({
      strategy: p.strategy,
      target: p.target,
      suit: p.suit || p.cardsLabel || null,
      status: p.status,
      reason: p.reason || null,
      hitNumber: p.hitNumber || null,
      step: p.step || 0,
      from: p.from || null,
      trigger: p.trigger || null,
      source: 'mémoire',
    }));
  }
  if (!db.ready) return [];
  try {
    const rows = await db.predictionsByNumber(number, 10);
    return rows.map((r) => ({
      strategy: r.strategy,
      target: Number(r.target),
      suit: r.suit,
      status: r.status,
      reason: r.reason || null,
      hitNumber: r.hit_number != null ? Number(r.hit_number) : null,
      step: r.rattrapage || 0,
      from: null,
      trigger: null,
      source: 'base de données',
    }));
  } catch (_) {
    return [];
  }
}

// état courant (config + filtre) de chaque stratégie, condensé pour le contexte IA
function strategiesSnapshot() {
  return strategies.LIST.map((def) => {
    const cfg = (state.strategies && state.strategies[def.key]) || strategies.defaultsFor(def.key);
    const g = gateView(def.key);
    return {
      key: def.key,
      name: def.name,
      enabled: !!cfg.enabled,
      settings: {
        maxR: cfg.maxR, lead: cfg.lead, absence: cfg.absence, scope: cfg.scope,
        silent: !!cfg.silent, lossTrigger: cfg.lossTrigger, lossWindow: cfg.lossWindow,
        lossInterval: cfg.lossInterval, resetOnWin: cfg.resetOnWin,
      },
      gate: { phase: g.phase, label: g.label, sending: g.sending, queueLength: g.queueLength },
    };
  });
}

// dernières prédictions toutes stratégies confondues (contexte général si la
// question ne cible pas un numéro précis)
function recentPredictionsSnapshot(limit = 15) {
  return (state.predictions || []).slice(0, limit).map((p) => ({
    strategy: p.strategy, target: p.target, suit: p.suit || p.cardsLabel || null,
    status: p.status, reason: p.reason || null, hitNumber: p.hitNumber || null,
  }));
}

async function buildContext(question) {
  const numbers = extractGameNumbers(question);
  const matches = {};
  for (const n of numbers) {
    const found = await findPredictionsForNumber(n);
    if (found.length) matches[n] = found;
  }
  return {
    dateHeure: new Date().toISOString(),
    questionNumerosDetectes: numbers,
    predictionsCorrespondantes: matches,
    strategiesActuelles: strategiesSnapshot(),
    dernieresPredictions: recentPredictionsSnapshot(),
  };
}

// Réponse hors-IA (repli) quand aucune clé n'est configurée : on donne quand
// même les données brutes trouvées, sans mise en forme par un modèle de langage.
function fallbackAnswer(context) {
  const nums = context.questionNumerosDetectes;
  if (!nums.length) {
    return "Aucune clé Pollinations.ai configurée pour reformuler la réponse, et aucun numéro de jeu détecté dans la question. Précise un numéro de jeu (ex. « jeu 12 ») pour que je retrouve la prédiction correspondante.";
  }
  const parts = [];
  for (const n of nums) {
    const list = context.predictionsCorrespondantes[n];
    if (!list || !list.length) { parts.push(`Aucune prédiction trouvée pour le jeu #${n}.`); continue; }
    for (const p of list) {
      parts.push(
        `Jeu #${n} — stratégie « ${p.strategy} », statut ${p.status || 'inconnu'}` +
        (p.reason ? ` : ${p.reason}` : ' (aucune raison enregistrée pour cette prédiction).')
      );
    }
  }
  return parts.join('\n');
}

async function ask(question) {
  const q = String(question || '').trim();
  if (!q) { const e = new Error('Question vide.'); e.code = 'EMPTY_QUESTION'; throw e; }
  const context = await buildContext(q);

  let answer;
  let source;
  if (ai.keyLooksValid()) {
    const system = [
      'Tu es l\'assistant technique du bot de prédiction Baccarat « Ombre ».',
      'Tu réponds UNIQUEMENT à partir des données JSON fournies (prédictions réelles, raisons enregistrées par le moteur, réglages des stratégies, état des filtres).',
      'Si l\'information demandée n\'est pas dans les données fournies, dis-le clairement : ne devine jamais un numéro de jeu, une raison ou un résultat qui n\'y figure pas.',
      'Le champ "reason" d\'une prédiction est la raison réelle, déjà calculée par le bot : reformule-la clairement en français plutôt que de la réinventer.',
      'Réponds de façon concise, factuelle, en français, sans markdown ni listes inutiles pour une question simple.',
    ].join(' ');
    try {
      const response = await fetch(config.POLLINATIONS.CHAT_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${ai.apiKey()}`,
        },
        body: JSON.stringify({
          model: config.POLLINATIONS.MODEL,
          temperature: 0.1,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify({ question: q, donnees: context }) },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || `Pollinations.ai a répondu ${response.status}.`);
      answer = (body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || '').trim();
      if (!answer) throw new Error('Réponse vide de Pollinations.ai.');
      source = 'pollinations';
    } catch (e) {
      runtime.lastError = e.message;
      // repli sur les données brutes plutôt que de laisser la question sans réponse
      answer = fallbackAnswer(context);
      source = 'local (secours après erreur IA : ' + e.message + ')';
    }
  } else {
    answer = fallbackAnswer(context);
    source = 'local';
  }

  const entry = { question: q, answer, source, at: new Date().toISOString() };
  runtime.history = [entry, ...runtime.history].slice(0, MAX_HISTORY);
  runtime.lastAskedAt = Date.now();
  if (source === 'pollinations') runtime.lastError = null;
  return entry;
}

function history() {
  return runtime.history;
}

module.exports = { ask, history, extractGameNumbers, buildContext };
