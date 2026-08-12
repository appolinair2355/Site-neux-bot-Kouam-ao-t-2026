// ai-analyzer.js — analyse prudente de l'historique Baccarat via Pollinations.ai
'use strict';

const config = require('./config');

const MAX_GAMES = 120;
const SUITS = ['♦️', '❤️', '♣️', '♠️'];

function compactGame(game) {
  return {
    n: game.number,
    player: game.player || game.player_cards || [],
    banker: game.banker || game.banker_cards || [],
    playerSuits: game.playerSuits || game.player_suits || [],
    bankerSuits: game.bankerSuits || game.banker_suits || [],
    playerValue: game.playerValue ?? game.player_value ?? null,
    bankerValue: game.bankerValue ?? game.banker_value ?? null,
    winner: game.winner || null,
    finished: game.finished !== false,
  };
}

function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try { return JSON.parse(candidate); } catch (_) {}
  const object = candidate.match(/\{[\s\S]*\}/);
  if (!object) return null;
  try { return JSON.parse(object[0]); } catch (_) { return null; }
}

function localSummary(games) {
  const counts = Object.fromEntries(SUITS.map((s) => [s, 0]));
  const recent = games.slice(0, 30);
  for (const game of games) {
    for (const suit of [...(game.playerSuits || []), ...(game.bankerSuits || [])]) {
      if (counts[suit] !== undefined) counts[suit] += 1;
    }
  }
  return {
    games: games.length,
    recentGames: recent.length,
    suitCounts: counts,
    playerWins: games.filter((g) => g.winner === 'Joueur').length,
    bankerWins: games.filter((g) => g.winner === 'Banquier').length,
    ties: games.filter((g) => g.winner === 'Égalité').length,
  };
}

async function analyze({ games = [], date = null, objective = '' } = {}) {
  if (!config.POLLINATIONS_API_KEY) {
    const error = new Error('POLLINATIONS_API_KEY manquante dans les variables du déploiement.');
    error.code = 'AI_NOT_CONFIGURED';
    throw error;
  }

  const normalized = games.map(compactGame).filter((game) => game.n != null).slice(0, MAX_GAMES);
  if (normalized.length < 6) {
    const error = new Error('Il faut au moins 6 jeux terminés pour produire une analyse utile.');
    error.code = 'NOT_ENOUGH_DATA';
    throw error;
  }

  const summary = localSummary(normalized);
  const system = [
    'Tu es un analyste prudent de données Baccarat.',
    'Tu dois analyser uniquement les observations fournies et ne jamais promettre une prédiction fiable ou certaine.',
    'Les cartes de la main joueur sont la seule base de vérification des stratégies; la main banquier sert aux comparaisons et au contexte.',
    'Cherche des fréquences, séries, absences, distributions et signaux de sur-ajustement.',
    'Une stratégie proposée doit être testable, réversible, limitée à un échantillon minimum et accompagnée de ses risques.',
    'Réponds uniquement avec un JSON valide, sans Markdown.',
  ].join(' ');
  const user = {
    demande: objective || 'Identifier les signaux observables et proposer des stratégies testables pour les prochains jeux.',
    dateAnalysee: date || 'historique disponible',
    resumeLocal: summary,
    jeux: normalized,
    formatReponse: {
      title: 'titre court',
      confidence: 'faible|moyenne|exploratoire',
      observation: 'résumé factuel',
      strategies: [{
        name: 'nom',
        logic: 'règle testable en une phrase',
        trigger: 'déclencheur',
        target: 'tour ou condition ciblée',
        suggestedLead: 1,
        minimumSample: 20,
        evidence: 'ce que les données montrent',
        risks: 'risques et limites',
        compatibleExisting: 'costume|dominant|matchnul|parite|absente|ombre|null',
      }],
      nextChecks: ['contrôles à faire sur les prochains jeux'],
    },
  };

  const response = await fetch(`${config.POLLINATIONS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${config.POLLINATIONS_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.POLLINATIONS_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Pollinations.ai a répondu ${response.status}.`);
    error.code = 'AI_REQUEST_FAILED';
    throw error;
  }
  const text = body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || '';
  const result = extractJson(text);
  if (!result) {
    const error = new Error('La réponse de Pollinations.ai n’est pas un JSON exploitable.');
    error.code = 'AI_INVALID_RESPONSE';
    throw error;
  }
  return {
    ...result,
    generatedAt: new Date().toISOString(),
    sample: normalized.length,
    localSummary: summary,
  };
}

module.exports = { analyze, compactGame, localSummary, MAX_GAMES };