// bot.js — bot Telegram + boucle de prédiction/vérification
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const api = require('./api');
const store = require('./store');
const db = require('./db');
const predit = require('./predit');
const fmt = require('./formats');
const strategies = require('./strategies');
const {
  state, evaluate, verify, registerGames, setOnFinished,
  predictionText, predictionMessage, liveText, stats, SUITS,
  initStrategies, setStrategyConfig, resetStrategy, strategyChannels, parityRuntime,
  bilanText, canSend, gateView, autoView, noteSent, shadowRuntime, sweepAutoUnlock, unlockGate,
  silenceView, silenceShouldSend, noteSilenceSent,
} = require('./predictor');

let bot = null;
let loopStarted = false;

const saved = store.read();
state.botToken = saved.botToken || config.BOT_TOKEN || '';
state.adminId = saved.adminId || config.ADMIN_ID;
if (Array.isArray(saved.channels)) state.channels = saved.channels;
if (Array.isArray(saved.activeChannels)) state.activeChannels = saved.activeChannels;
if (saved.B) state.B = saved.B;
if (saved.maxR != null) state.maxR = saved.maxR;
state.hand = 'joueur';
if (saved.format) state.format = saved.format;
if (saved.template !== undefined) state.template = saved.template;
if (saved.strategies && typeof saved.strategies === 'object') state.strategies = saved.strategies;
if (Array.isArray(saved.aiAnalyses)) state.aiAnalyses = saved.aiAnalyses;
if (Array.isArray(saved.aiStrategies)) state.aiStrategies = saved.aiStrategies;
initStrategies();

function persist() {
  store.patch({
    botToken: state.botToken,
    adminId: state.adminId,
    channels: state.channels,
    activeChannels: state.activeChannels,
    B: state.B,
    maxR: state.maxR,
    hand: 'joueur',
    format: state.format,
    template: state.template,
    strategies: state.strategies,
    aiAnalyses: state.aiAnalyses,
    aiStrategies: state.aiStrategies,
  });
  if (db.ready) {
    // configuration complète (token, admin, canaux) : elle est relue au démarrage
    db.saveAppConfig({
      botToken: state.botToken || '',
      adminId: state.adminId || 0,
      channels: state.channels || [],
      activeChannels: state.activeChannels || [],
      B: state.B,
      maxR: state.maxR,
      format: state.format,
      template: state.template || '',
      savedAt: new Date().toISOString(),
    });
    db.setSetting('B', state.B);
    db.setSetting('maxR', state.maxR);
    db.setSetting('format', state.format);
    db.setSetting('template', state.template || '');
    // chaque stratégie est enregistrée en base : après un redémarrage le bot
    // repart exactement avec les configurations déjà enregistrées.
    for (const def of strategies.LIST) {
      const cfg = state.strategies[def.key];
      if (cfg) db.saveStrategy(def.key, def.name, cfg);
    }
  }
}

const isAdmin = (msg) => msg.from && msg.from.id === Number(state.adminId);
const deny = (id) => bot && bot.sendMessage(id, "⛔ Commande réservée à l'administrateur.");

function rememberChannel(chat) {
  if (!chat || !['channel', 'supergroup', 'group'].includes(chat.type)) return;
  if (!state.channels.some((c) => c.id === chat.id)) {
    state.channels.push({ id: chat.id, title: chat.title || String(chat.id) });
    persist();
    if (bot)
      bot.sendMessage(
        state.adminId,
        `📡 Nouveau canal détecté : *${chat.title}*\n\`${chat.id}\`\n\n` +
          `Lance \`/activer ${chat.id}\` pour y envoyer les prédictions.`,
        { parse_mode: 'Markdown' }
      );
  }
}

function listChannels() {
  if (!state.channels.length) return '_aucun_';
  return state.channels
    .map((c) => `${state.activeChannels.includes(c.id) ? '✅' : '⚪'} ${c.title} — \`${c.id}\``)
    .join('\n');
}

const HELP =
  '🎴 *Bot Baccara 1xbet — main du JOUEUR*\n\n' +
  '*Jeu*\n' +
  '/live — jeu réellement en cours (cartes + costumes joueur)\n' +
  '/stats — statistiques des prédictions\n' +
  '/reglages — réglages actuels\n\n' +
  '*Canaux*\n' +
  '/canaux — canaux où je suis admin\n' +
  '/activer <id> — activer les prédictions\n' +
  '/desactiver <id> — arrêter\n\n' +
  '*Prédiction*\n' +
  '/setb <n> — compteur B (apparitions consécutives max)\n' +
  '/setmaxr <n> — nombre de rattrapages vérifiés\n' +
  '/setformat <1-87> — style du message de prédiction (87 = nouveau format)\n' +
  '/modesilence <clé> <on|off> [perte|rattrapage] [n] [+N] [nb] [niveau] — mode d\'activation silencieux\n' +
  '/formats [page] — liste des 87 styles (80-83 pair/impair, 84-86 ombre, 87 nouveau format)\n' +
  '/apercu <n> — aperçu complet d\'un style (⌛ / ✅ / ❌)\n' +
  '/settemplate <texte> — style personnalisé ({game} {emoji} {suit} {status} {maxR})\n' +
  '/notemplate — revenir au style numéroté\n\n' +
  '*Stratégies*\n' +
  '/strategies — liste des stratégies et leur état\n' +
  '/strategie <clé> — détail + configuration d\'une stratégie\n' +
  '/activerstrat <clé> — activer une stratégie\n' +
  '/desactiverstrat <clé> — désactiver une stratégie\n' +
  '/setstrat <clé> <format|maxr|b|lead|depart|var|decalage|streak|absence|silence|fenetre|template> <valeur>\n' +
  '/ombre — état de la stratégie « Prédiction dans l\'ombre »\n' +
  '/silence <clé> <on|off> [fenêtre] — mode silencieux + nb max de prédictions après une perte\n' +
  '/debloquer <clé|tout> — débloque immédiatement l\'envoi (déblocage auto après 10 min)\n' +
  '/filtres — état du filtre « double perte » de chaque stratégie\n' +
  '/sauverconfig — enregistrer toutes les configurations en base\n' +
  '/configs — lire les configurations enregistrées en base\n' +
  '/parite — état complet de la stratégie Pair/Impair (VAR)\n' +
  '/setparite <départ> <var> <décalage> <rattrapage> — configuration rapide\n' +
  '/resetstrat <clé> — remettre la configuration par défaut\n' +
  '/supprimerstrat <clé> — supprimer la configuration en base\n\n' +
  '*Base de données*\n' +
  '/setdb <url> — lien PostgreSQL Render\n' +
  '/db — état de la base\n' +
  '/base — nombre de lignes, dernier jeu, période couverte\n' +
  '/dates — dates disponibles\n' +
  '/jeux [2/04/2026] — résumé des jeux d\'une date\n' +
  '/derniers [n] — derniers jeux enregistrés\n' +
  '/jeu <numéro> — fiche complète d\'un jeu\n' +
  '/pred [date] — prédictions enregistrées + taux\n' +
  '/sql <SELECT ...> — requête de lecture seule';

function settingsText() {
  return (
    `⚙️ *Réglages*\n` +
    `• Compteur B : *${state.B}*\n` +
    `• Rattrapages : *${state.maxR}*\n` +
    `• Main vérifiée : *joueur uniquement*\n` +
    `• Format : *${state.format}/${fmt.FORMAT_COUNT}*${state.template ? ' (template perso)' : ''}\n` +
    `• Compteurs : ${SUITS.map((s) => `${s}${state.counters[s]}`).join(' ')}\n` +
    `• Base de données : ${db.status().ready ? '🟢 connectée' : '🔴 non connectée'}`
  );
}

function fmtDate(d) {
  if (!d) return '—';
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const [y, mo, da] = s.split('-');
  return da ? `${da}/${mo}/${y}` : s;
}

function wire(b) {
  b.on('polling_error', (e) => { state.botError = e.message; });
  b.on('my_chat_member', (u) => {
    const status = u.new_chat_member && u.new_chat_member.status;
    if (['administrator', 'member', 'creator'].includes(status)) rememberChannel(u.chat);
  });
  b.on('channel_post', (m) => rememberChannel(m.chat));

  b.onText(/^\/(start|aide|help)/, (msg) =>
    b.sendMessage(msg.chat.id, HELP, { parse_mode: 'Markdown' })
  );

  b.onText(/^\/(live|encours|jeu)\b/, (msg) =>
    b.sendMessage(msg.chat.id, liveText(), { parse_mode: 'Markdown' })
  );

  b.onText(/^\/reglages/, (msg) =>
    b.sendMessage(msg.chat.id, settingsText(), { parse_mode: 'Markdown' })
  );

  b.onText(/^\/canaux/, (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    b.sendMessage(msg.chat.id, `📋 *Canaux*\n${listChannels()}`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/setb(?:\s+(\d+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, `ℹ️ Usage : /setb <n>  (actuel : ${state.B})`);
    state.B = Math.max(1, parseInt(m[1], 10));
    for (const s of SUITS) if (state.counters[s] > state.B) state.counters[s] = 0;
    persist();
    b.sendMessage(
      msg.chat.id,
      `✅ B = ${state.B}\nLe compteur monte de 1 à ${state.B} quand le costume apparaît dans la main du joueur, retombe à 0 quand il manque, et repart à 1 après avoir atteint ${state.B}.`
    );
  });

  b.onText(/^\/setmaxr(?:\s+(\d+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, `ℹ️ Usage : /setmaxr <n>  (actuel : ${state.maxR})`);
    state.maxR = Math.max(0, Math.min(9, parseInt(m[1], 10)));
    persist();
    b.sendMessage(msg.chat.id, `✅ Rattrapages = ${state.maxR} : on vérifie le numéro prédit puis ${state.maxR} tour(s) suivant(s).`);
  });

  b.onText(/^\/setformat(?:\s+(\d+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const list = fmt.formatList(1, 26);
    if (!m[1])
      return b.sendMessage(
        msg.chat.id,
        `ℹ️ Usage : /setformat <1-${fmt.FORMAT_COUNT}>  (actuel : ${state.format})\n\n${list.text}\n\n➡️ /formats 2 pour la suite`
      );
    state.format = fmt.clampFormat(m[1]);
    state.template = null;
    persist();
    b.sendMessage(
      msg.chat.id,
      `✅ Format des prédictions = ${state.format}/${fmt.FORMAT_COUNT}\n\n` +
        `⌛ Prédiction :\n${fmt.formatPreview(state.format, { maxR: state.maxR })}\n\n` +
        `✅ Gagné :\n${fmt.formatPreview(state.format, { maxR: state.maxR, status: 'gagné', rattrapage: 1 })}\n\n` +
        `❌ Perdu :\n${fmt.formatPreview(state.format, { maxR: state.maxR, status: 'perdu', rattrapage: state.maxR })}`
    );
  });

  b.onText(/^\/formats(?:\s+(\d+))?/, (msg, m) => {
    const list = fmt.formatList(m[1] || 1, 26);
    b.sendMessage(
      msg.chat.id,
      `🎨 Styles de prédiction (${list.page}/${list.pages}) — ${fmt.FORMAT_COUNT} au total\n\n${list.text}\n\n` +
        `➡️ /formats <page> • /apercu <n> • /setformat <n>`
    );
  });

  b.onText(/^\/apercu(?:\s+(\d+))?/, (msg, m) => {
    if (!m[1]) return b.sendMessage(msg.chat.id, `ℹ️ Usage : /apercu <1-${fmt.FORMAT_COUNT}>`);
    const id = fmt.clampFormat(m[1]);
    b.sendMessage(
      msg.chat.id,
      `🎨 Style ${id}/${fmt.FORMAT_COUNT}\n\n⌛\n${fmt.formatPreview(id, { maxR: state.maxR })}\n\n` +
        `✅\n${fmt.formatPreview(id, { maxR: state.maxR, status: 'gagné', rattrapage: 1 })}\n\n` +
        `❌\n${fmt.formatPreview(id, { maxR: state.maxR, status: 'perdu', rattrapage: state.maxR })}`
    );
  });

  b.onText(/^\/settemplate(?:\s+([\s\S]+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1])
      return b.sendMessage(
        msg.chat.id,
        'ℹ️ Usage : /settemplate 🎯 #{game} | {emoji} {suit} | {status}\n' +
          'Variables : {game} {emoji} {suit} {status} {maxR} {rattrapage} {strategy}'
      );
    state.template = m[1].trim();
    persist();
    b.sendMessage(msg.chat.id, `✅ Template personnalisé actif :\n\n${fmt.renderMessage(state.format, { gameNumber: 1234, suit: '♦️', maxR: state.maxR }, state.template).text}`);
  });

  b.onText(/^\/notemplate/, (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    state.template = null;
    persist();
    b.sendMessage(msg.chat.id, `✅ Retour au style numéroté ${state.format}/${fmt.FORMAT_COUNT}.`);
  });

  b.onText(/^\/sethand(?:\s+(\w+))?/, (msg) =>
    b.sendMessage(
      msg.chat.id,
      'ℹ️ Ce bot analyse *uniquement la main du joueur*. La main du banquier est seulement enregistrée en base de données.',
      { parse_mode: 'Markdown' }
    )
  );

  b.onText(/^\/setdb(?:\s+(\S+))?/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /setdb postgresql://user:pass@host/db');
    const s = await db.connect(m[1]);
    b.sendMessage(msg.chat.id, s.ready ? '✅ Base de données connectée, tables créées.' : `❌ Échec : ${s.error}`);
  });

  b.onText(/^\/db\b/, (msg) => {
    const s = db.status();
    b.sendMessage(msg.chat.id, `🗄️ Base : ${s.ready ? '🟢 connectée' : '🔴 non connectée'}\n${s.url || 'aucun lien'}\n${s.error ? '⚠️ ' + s.error : ''}`);
  });

  b.onText(/^\/jeux(?:\s+(\S+))?/, async (msg, m) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const sum = await db.dailySummary(m[1]);
    if (!sum) return b.sendMessage(msg.chat.id, '⚠️ Date invalide. Exemple : /jeux 2/04/2026');
    b.sendMessage(
      msg.chat.id,
      `📅 *${sum.date}*\nJeux : ${sum.total}\n🧍 Joueur : ${sum.joueur} | 🏦 Banquier : ${sum.banquier} | 🤝 Égalité : ${sum.egalite}\n` +
        `Joueur pair ${sum.joueur_pair} / impair ${sum.joueur_impair}\nBanquier pair ${sum.banquier_pair} / impair ${sum.banquier_impair}`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/base\b/, async (msg) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const o = await db.overview();
    if (!o) return b.sendMessage(msg.chat.id, '⚠️ Lecture impossible.');
    b.sendMessage(
      msg.chat.id,
      `🗄️ *Contenu de la base*\n` +
        `• Jeux : ${o.games}\n• Prédictions : ${o.predictions}\n• Réglages : ${o.settings}\n` +
        `• Dernier jeu : ${o.dernier_jeu ? '#N' + o.dernier_jeu : '—'}\n` +
        `• Période : ${fmtDate(o.depuis)} → ${fmtDate(o.jusqua)}`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/dates\b/, async (msg) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const rows = await db.availableDates(15);
    if (!rows.length) return b.sendMessage(msg.chat.id, 'Aucune donnée enregistrée pour le moment.');
    b.sendMessage(msg.chat.id, `📅 Dates disponibles\n${rows.map((r) => `• ${fmtDate(r.played_on)} — ${r.total} jeux`).join('\n')}`);
  });

  b.onText(/^\/derniers(?:\s+(\d+))?/, async (msg, m) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const rows = await db.lastGames(Math.max(1, Math.min(30, parseInt(m[1], 10) || 10)));
    if (!rows.length) return b.sendMessage(msg.chat.id, 'Aucun jeu enregistré.');
    b.sendMessage(
      msg.chat.id,
      `🧾 Derniers jeux (main joueur)\n` +
        rows
          .map((r) => `#N${r.number} • ${(r.player_cards || []).join(' ') || '—'} = ${r.player_value ?? '—'} (${r.player_parity || '—'}) • ${r.winner || 'en cours'}`)
          .join('\n')
    );
  });

  b.onText(/^\/jeu\s+(\d+)/, async (msg, m) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const g = await db.gameByNumber(m[1]);
    if (!g) return b.sendMessage(msg.chat.id, `⚠️ Jeu #N${m[1]} introuvable en base.`);
    b.sendMessage(
      msg.chat.id,
      `🧾 *Jeu #N${g.number}* — ${fmtDate(g.played_on)}\n` +
        `🃏 Joueur : ${(g.player_cards || []).join(' ') || '—'} = *${g.player_value ?? '—'}* (${g.player_parity || '—'}, ${g.player_count ?? '—'} cartes)\n` +
        `🎯 Costumes joueur : ${(g.player_suits || []).join(' ') || '—'}\n` +
        `🏦 Banquier (archive) : ${(g.banker_cards || []).join(' ') || '—'} = ${g.banker_value ?? '—'}\n` +
        `🏁 Résultat : ${g.winner || '—'} • phase ${g.phase || '—'}`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/pred(?:ictions)?(?:\s+(\S+))?/, async (msg, m) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const sum = await db.predictionSummary(m[1]);
    if (!sum) return b.sendMessage(msg.chat.id, '⚠️ Date invalide. Exemple : /pred 2/04/2026');
    const rows = await db.predictionsByDate(m[1], 15);
    const lines = rows.map((r) => {
      const ico = r.status === 'gagne' ? `✅ ${r.rattrapage ?? 0}` : r.status === 'perdu' ? '❌' : '⌛';
      return `#N${r.target} ${r.suit} +${r.max_r} → ${ico}`;
    });
    b.sendMessage(
      msg.chat.id,
      `🎯 *Prédictions ${fmtDate(sum.date)}*\nTotal ${sum.total} • ✅ ${sum.gagne} • ❌ ${sum.perdu} • ⌛ ${sum.attente} • taux *${sum.taux}%*\n` +
        `Rattrapage moyen : ${sum.r_moyen}\n\n${lines.join('\n') || '_aucune ligne_'}`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/sql\s+([\s\S]+)/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const r = await db.readOnlyQuery(m[1], 20);
    if (r.error) return b.sendMessage(msg.chat.id, `❌ ${r.error}`);
    if (!r.rows.length) return b.sendMessage(msg.chat.id, '✅ Requête exécutée : 0 ligne.');
    const txt = r.rows.map((row) => JSON.stringify(row)).join('\n').slice(0, 3500);
    b.sendMessage(msg.chat.id, `✅ ${r.rows.length} ligne(s)\n\n${txt}`);
  });

  b.onText(/^\/activer\s+(-?\d+)/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const id = parseInt(m[1], 10);
    activate(id);
    b.sendMessage(msg.chat.id, `✅ Prédictions activées pour \`${id}\``, { parse_mode: 'Markdown' });
    try {
      await b.sendMessage(id, '🟢 *Prédictions actives*', { parse_mode: 'Markdown' });
    } catch (e) {
      b.sendMessage(msg.chat.id, `⚠️ Impossible d'écrire dans ce canal : ${e.message}`);
    }
  });

  b.onText(/^\/desactiver\s+(-?\d+)/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    deactivate(parseInt(m[1], 10));
    b.sendMessage(msg.chat.id, `🔴 Prédictions désactivées pour \`${m[1]}\``, { parse_mode: 'Markdown' });
  });


  // ---- stratégies ---------------------------------------------------------
  b.onText(/^\/strategies\b/, (msg) => {
    const lines = strategies.LIST.map((d) => {
      const c = state.strategies[d.key] || {};
      const st = stats(d.key);
      return `${c.enabled ? '🟢' : '🔴'} *${d.name}* — \`${d.key}\`\n` +
        `   format ${c.format}${d.key === 'matchnul' ? '/' + (c.formatDistribution || 79) : ''} • +${c.maxR} rattrapage(s)` +
        `${d.usesB ? ' • B=' + c.b : ''}` +
        `${d.key === 'parite' ? ` • départ ${c.startGame} • VAR ${c.varStep} • décalage ${c.decalage}` : ''}` +
        `${d.key === 'absente' ? ` • ${c.streak || 3} jeux consécutifs` : ''}` +
        ` • ${st.win}✅/${st.loss}❌ (${st.rate}%)`;
    });
    b.sendMessage(msg.chat.id, `🧠 *Stratégies*\n\n${lines.join('\n\n')}\n\n➡️ /strategie <clé>`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/strategie(?:\s+(\w+))?/, (msg, m) => {
    const key = (m[1] || '').toLowerCase();
    const d = strategies.BY_KEY[key];
    if (!d) return b.sendMessage(msg.chat.id, `ℹ️ Usage : /strategie <${strategies.LIST.map((x) => x.key).join('|')}>`);
    const c = state.strategies[key] || {};
    const st = stats(key);
    b.sendMessage(
      msg.chat.id,
      `🧠 *${d.name}* (\`${d.key}\`)\n\n${d.about}\n\n` +
        `• État : ${c.enabled ? '🟢 active' : '🔴 arrêtée'}\n` +
        `• Format : ${c.format}/${fmt.FORMAT_COUNT}${key === 'matchnul' ? ` (distribution : ${c.formatDistribution || 79})` : ''}\n` +
        `• Rattrapages : +${c.maxR}\n` +
        (d.usesB ? `• Compteur B : ${c.b}\n` : '') +
        `• Prédiction lancée : +${c.lead} tour(s)\n` +
        (key === 'parite'
          ? `• Jeu de départ : ${c.startGame} • VAR : ${c.varStep} • Décalage : ${c.decalage}\n` +
            `• Séquence : ${strategies.triggerSequence(c.startGame, c.varStep, 8).join(' → ')} …\n`
          : '') +
        (key === 'absente' ? `• Jeux consécutifs sans la carte : ${c.streak || 3}\n` : '') +
        `• Canaux : ${(c.channels && c.channels.length ? c.channels.join(', ') : 'canaux actifs globaux')}\n` +
        `• Résultats : ${st.win}✅ / ${st.loss}❌ / ${st.pending}⌛ → ${st.rate}%\n\n` +
        `Aperçu :\n${fmt.formatPreview(c.format, { maxR: c.maxR })}`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/activerstrat(?:\s+(\w+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    if (!strategies.BY_KEY[key]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /activerstrat <clé>');
    setStrategyConfig(key, { enabled: true });
    persist();
    b.sendMessage(msg.chat.id, `🟢 Stratégie *${strategies.BY_KEY[key].name}* activée.`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/desactiverstrat(?:\s+(\w+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    if (!strategies.BY_KEY[key]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /desactiverstrat <clé>');
    setStrategyConfig(key, { enabled: false });
    persist();
    b.sendMessage(msg.chat.id, `🔴 Stratégie *${strategies.BY_KEY[key].name}* arrêtée.`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/setstrat(?:\s+(\w+)\s+(\w+)\s+([\s\S]+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /setstrat <clé> <format|formatdistribution|maxr|b|lead|template> <valeur>');
    const key = m[1].toLowerCase();
    if (!strategies.BY_KEY[key]) return b.sendMessage(msg.chat.id, `⚠️ Stratégie inconnue : ${key}`);
    const field = m[2].toLowerCase();
    const value = m[3].trim();
    const map = {
      format: 'format', formatdistribution: 'formatDistribution', maxr: 'maxR', b: 'b', lead: 'lead', template: 'template',
      depart: 'startGame', start: 'startGame', jeudepart: 'startGame',
      var: 'varStep', decalage: 'decalage', rattrapage: 'maxR',
      streak: 'streak', jeux: 'streak', consecutifs: 'streak',
      absence: 'absence', ombre: 'absence', scope: 'scope', main: 'scope',
      silence: 'silent', silencieux: 'silent', silent: 'silent',
      fenetre: 'lossWindow', intervalle: 'lossWindow', perte: 'lossWindow',
      resetgain: 'resetOnWin',
    };
    if (!map[field]) return b.sendMessage(msg.chat.id, '⚠️ Champ inconnu (format, formatdistribution, maxr, b, lead, depart, var, decalage, streak, absence, scope, silence, fenetre, resetgain, template).');
    const target = map[field];
    let parsed = value;
    if (target === 'silent' || target === 'resetOnWin') parsed = /^(1|oui|on|true|actif)$/i.test(value);
    const cfg = setStrategyConfig(key, { [target]: parsed });
    persist();
    b.sendMessage(msg.chat.id, `✅ ${strategies.BY_KEY[key].name} → ${field} = ${cfg[target]}\n\n${fmt.formatPreview(cfg.format, { maxR: cfg.maxR })}`);
  });

  b.onText(/^\/ombre\b/, (msg) => {
    const r = shadowRuntime();
    const lines = r.suits.map((x) => `${x.suit} absent depuis ${x.absence} jeu(x)${x.watched ? ' 👁️ surveillé' : ''}`);
    b.sendMessage(
      msg.chat.id,
      `🕯️ *Prédiction dans l'ombre*\n` +
        `• État : ${r.enabled ? '🟢 active' : '🔴 arrêtée'}\n` +
        `• Absence minimum : *${r.absence}* jeux\n` +
        `• Prédiction au retour : *+${r.lead}*\n` +
        `• Périmètre : ${r.scope === 'joueur' ? 'main du joueur' : 'joueur + banquier'}\n` +
        `• Dernier jeu terminé : ${r.lastGame ? '#N' + r.lastGame : '—'}\n\n` +
        lines.join('\n') +
        `\n\n📡 ${r.gate.label}` +
        (r.prediction ? `\n🎯 En attente : ${r.prediction.label} sur #N${r.prediction.target}` : ''),
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/silence(?:\s+(\w+))?(?:\s+(\w+))?(?:\s+(\d+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    if (!strategies.BY_KEY[key])
      return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /silence <clé> <on|off> [nombre max de prédictions après une perte]');
    const patch = {};
    if (m[2]) patch.silent = /^(on|oui|1|actif|true)$/i.test(m[2]);
    if (m[3]) patch.lossWindow = parseInt(m[3], 10);
    const cfg = setStrategyConfig(key, patch);
    persist();
    b.sendMessage(
      msg.chat.id,
      `🔕 ${strategies.BY_KEY[key].name}\n` +
        `• Mode silencieux : ${cfg.silent ? 'activé' : 'désactivé'}\n` +
        `• Prédictions max après une perte : ${cfg.lossWindow}\n` +
        `• Retour au silence après un gain : ${cfg.resetOnWin === false ? 'non' : 'oui'}\n\n` +
        gateView(key).label
    );
  });

  // Nouveau mode d'activation silencieux :
  // /modesilence <clé> <on|off> [perte|rattrapage] [nb déclencheurs] [+N] [nb prédictions]
  b.onText(/^\/modesilence(?:\s+(\w+))?(?:\s+(\w+))?(?:\s+(perte|rattrapage))?(?:\s+(\d+))?(?:\s+\+?(\d+))?(?:\s+(\d+))?(?:\s+(\d+))?/i, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    if (!strategies.BY_KEY[key]) {
      return b.sendMessage(msg.chat.id,
        "ℹ️ Usage : /modesilence <clé> <on|off> [perte|rattrapage] [nombre de déclencheurs] [décalage +N] [nombre de prédictions]\n" +
        "Exemple : /modesilence costume on perte 1 10 6\n" +
        "Rattrapage : /modesilence <clé> on rattrapage <nb de fois> <+N> <nb préd.> <niveau 2|3|4>");
    }
    const patch = {};
    if (m[2]) patch.silenceMode = /^(on|oui|1|actif|true)$/i.test(m[2]);
    if (m[3]) patch.silenceTrigger = m[3].toLowerCase();
    if (m[4]) { const n = parseInt(m[4], 10); if (patch.silenceTrigger === 'rattrapage' || (m[3] || '').toLowerCase() === 'rattrapage') patch.silenceRatCount = n; else patch.silenceLossCount = n; }
    if (m[5]) patch.silenceOffset = parseInt(m[5], 10);
    if (m[6]) patch.silenceCount = parseInt(m[6], 10);
    if (m[7]) patch.silenceRatLevel = parseInt(m[7], 10);
    setStrategyConfig(key, patch);
    persist();
    const v = silenceView(key);
    b.sendMessage(msg.chat.id,
      `🤫 ${strategies.BY_KEY[key].name}\n` +
      `• Mode d'activation silencieux : ${v.enabled ? 'activé' : 'désactivé'}\n` +
      `• Déclencheur : ${v.trigger === 'perte' ? `${v.lossCount} perte(s)` : `${v.ratCount} fois rattrapage ${v.ratLevel}`}\n` +
      `• Décalage : +${v.offset} jeux après le jeu déclencheur\n` +
      `• Prédictions envoyées avant l'arrêt : ${v.count}\n` +
      `• Canal : ${(v.channels || []).join(', ') || 'aucun'}\n\n${v.label}`);
  });

  b.onText(/^\/debloquer(?:\s+(\w+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    const keys = key === 'tout' || key === 'all' || !key
      ? strategies.LIST.map((d) => d.key)
      : strategies.BY_KEY[key] ? [key] : null;
    if (!keys) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /debloquer <clé|tout>');
    for (const k of keys) unlockGate(k, true);
    b.sendMessage(msg.chat.id, `🔓 Débloqué : ${keys.map((k) => strategies.BY_KEY[k].name).join(', ')}`);
  });

  b.onText(/^\/filtres\b/, (msg) => {
    const lines = strategies.LIST.map((d) => {
      const g = gateView(d.key);
      return `${g.sending ? '🟢' : '🔕'} *${d.name}* — ${g.label}`;
    });
    b.sendMessage(msg.chat.id, `📡 *Filtres d'envoi*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/sauverconfig\b/, async (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const r = await saveConfigsToDb();
    b.sendMessage(msg.chat.id, r.ok
      ? `💾 Configurations enregistrées en base : ${r.saved.join(', ')}`
      : `⚠️ ${r.error}`);
  });

  b.onText(/^\/configs\b/, async (msg) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '⚠️ Base de données non connectée.');
    const rows = await db.loadStrategies();
    const keys = Object.keys(rows);
    if (!keys.length) return b.sendMessage(msg.chat.id, 'ℹ️ Aucune configuration enregistrée en base pour le moment.');
    const lines = keys.map((k) => {
      const c = rows[k] || {};
      const name = strategies.BY_KEY[k] ? strategies.BY_KEY[k].name : k;
      return `• *${name}* — ${c.enabled ? 'active' : 'arrêtée'} • format ${c.format} • +${c.maxR} • ` +
        `silence ${c.silent ? 'oui' : 'non'} (${c.lossWindow || 3}) • canal ${(c.channels || []).join(', ') || '—'}`;
    });
    b.sendMessage(msg.chat.id, `🗄️ *Configurations en base*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/resetstrat(?:\s+(\w+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    if (!resetStrategy(key)) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /resetstrat <clé>');
    persist();
    b.sendMessage(msg.chat.id, `♻️ Configuration de *${strategies.BY_KEY[key].name}* remise par défaut.`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/supprimerstrat(?:\s+(\w+))?/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    if (!strategies.BY_KEY[key]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /supprimerstrat <clé>');
    if (db.ready) await db.deleteStrategy(key);
    resetStrategy(key);
    setStrategyConfig(key, { enabled: false });
    persist();
    b.sendMessage(msg.chat.id, `🗑️ Configuration de *${strategies.BY_KEY[key].name}* supprimée en base et stratégie arrêtée.`, { parse_mode: 'Markdown' });
  });

  // ---- stratégie Pair / Impair (VAR) --------------------------------------
  b.onText(/^\/parite\b/, (msg) => {
    const r = parityRuntime();
    const c = state.strategies.parite || {};
    b.sendMessage(
      msg.chat.id,
      `🟢🔴 *Pair / Impair (VAR)*\n\n` +
        `• État : ${r.enabled ? '🟢 active' : '🔴 arrêtée'}\n` +
        `• Jeu de départ : *${r.startGame}*\n` +
        `• VAR configuré : *${r.varStep}* (VAR actuel : ${r.varLeft})\n` +
        `• Décalage : *${r.decalage}*\n` +
        `• Rattrapage : *+${r.maxR}*\n` +
        `• Format : *${r.format}/${fmt.FORMAT_COUNT}*\n\n` +
        `🎲 Jeu actuel : *${r.currentGame ? '#N' + r.currentGame : '—'}*\n` +
        `⬅️ Dernier déclencheur : *${r.lastTrigger ? '#N' + r.lastTrigger : '—'}*\n` +
        `➡️ Prochain déclencheur : *#N${r.nextTrigger}*\n` +
        `🔮 Prédiction en cours : ${r.prediction ? `*${r.prediction.parity.toUpperCase()}* sur #N${r.prediction.target} (rattrapage ${r.prediction.step}/${r.prediction.maxR})` : '—'}\n\n` +
        `📈 Séquence : ${r.sequence.join(' → ')} …\n\n` +
        `➡️ /setparite <départ> <var> <décalage> <rattrapage>`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/setparite(?:\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?)?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /setparite <jeu de départ> <var> <décalage> [rattrapage]\nExemple : /setparite 1 2 1 3');
    const cfg = setStrategyConfig('parite', {
      startGame: m[1], varStep: m[2], decalage: m[3],
      ...(m[4] ? { maxR: m[4] } : {}),
    });
    persist();
    const r = parityRuntime();
    b.sendMessage(
      msg.chat.id,
      `✅ Pair / Impair configurée\n` +
        `Départ ${cfg.startGame} • VAR ${cfg.varStep} • Décalage ${cfg.decalage} • Rattrapage +${cfg.maxR}\n\n` +
        `Séquence : ${r.sequence.join(' → ')} …\n` +
        `Prochain déclencheur : #N${r.nextTrigger}`
    );
  });

  b.onText(/^\/stats/, (msg) => {
    const s = stats();
    b.sendMessage(
      msg.chat.id,
      `📊 Prédictions : ${s.total}\n✅ ${s.win} | ❌ ${s.loss} | 🎯 ${s.rate}%\n\n` +
        strategies.LIST.map((d) => {
          const x = stats(d.key);
          return `${(state.strategies[d.key] || {}).enabled ? '🟢' : '🔴'} ${d.name} : ${x.win}✅/${x.loss}❌ (${x.rate}%)`;
        }).join('\n') +
        `\n\nTour live : ${state.live ? '#N' + state.live.number : '—'}`
    );
  });
}

function activate(id) {
  if (!state.activeChannels.includes(id)) state.activeChannels.push(id);
  if (!state.channels.some((c) => c.id === id)) state.channels.push({ id, title: String(id) });
  persist();
}

function deactivate(id) {
  state.activeChannels = state.activeChannels.filter((c) => c !== id);
  persist();
}

async function startBot(token) {
  if (token) state.botToken = token.trim();
  persist();
  state.botError = null;
  if (bot) {
    try { await bot.stopPolling({ cancel: true }); } catch (_) {}
    bot = null;
  }
  if (!state.botToken) {
    state.botError = 'Aucun token configuré';
    return { ok: false, error: state.botError };
  }
  try {
    bot = new TelegramBot(state.botToken, { polling: true });
    wire(bot);
    const me = await bot.getMe();
    state.botUsername = me.username;
    return { ok: true, username: me.username };
  } catch (e) {
    state.botError = e.message;
    bot = null;
    return { ok: false, error: e.message };
  }
}

function botStatus() {
  return {
    running: !!bot,
    username: state.botUsername || null,
    tokenSet: !!state.botToken,
    tokenMasked: state.botToken ? state.botToken.slice(0, 8) + '••••••' + state.botToken.slice(-4) : null,
    adminId: state.adminId,
    error: state.botError || null,
  };
}

// ---------------------------------------------------------------------------
// Expéditeurs : chaque stratégie peut avoir SON propre token de bot
// ---------------------------------------------------------------------------
const senders = new Map(); // token -> instance TelegramBot (sans polling)

// Renvoie TOUJOURS un expéditeur si un token est disponible : le bot principal
// quand il tourne, sinon une instance d'envoi seul (sans polling). Ainsi les
// prédictions partent même si le polling du bot principal est en erreur.
function senderFor() {
  const token = (state.botToken || '').trim();
  if (!token) return null;
  if (bot) return bot;                      // bot principal (polling actif)
  if (!senders.has(token)) {
    try { senders.set(token, new TelegramBot(token, { polling: false })); }
    catch (e) { console.error('Token Telegram invalide :', e.message); senders.set(token, null); }
  }
  return senders.get(token) || null;
}

// Résout un canal (ID numérique ou @nom) : titre, type, abonnés, droit de publier.
async function resolveChat(chatId) {
  const sender = senderFor();
  if (!sender) return { ok: false, error: "Aucun token API configuré dans les réglages." };
  try {
    const chat = await sender.getChat(chatId);
    let memberCount = null;
    try { memberCount = await sender.getChatMemberCount(chat.id); } catch (_) {}
    let canPost = null;
    try {
      const me = await sender.getMe();
      const m = await sender.getChatMember(chat.id, me.id);
      canPost = m.status === 'creator' || (m.status === 'administrator' && m.can_post_messages !== false);
    } catch (_) {}
    return {
      ok: true,
      chat: {
        id: chat.id,
        title: chat.title || chat.username || String(chat.id),
        type: chat.type,
        username: chat.username || null,
        memberCount,
        canPost,
      },
    };
  } catch (e) {
    const msg = /chat not found/i.test(e.message)
      ? "Canal introuvable : ajoute d'abord le bot comme administrateur du canal, puis réessaie."
      : e.message;
    return { ok: false, error: msg };
  }
}

// compteur de messages envoyés par stratégie
function countSent(key, n = 1) {
  const cfg = state.strategies[key];
  if (!cfg) return;
  cfg.sentCount = (cfg.sentCount || 0) + n;
  cfg.lastSentAt = Date.now();
}

function dropSender(token) {
  if (token && senders.has(token)) senders.delete(token);
}

// bilan à envoyer quand le jeu reprend
const bilanPending = new Set();
let lastLiveNumber = null;

async function sendBilan(key) {
  const cfg = state.strategies[key] || {};
  if (cfg.bilan === false) return;
  const sender = senderFor();
  if (!sender) return;
  const text = bilanText(key);
  for (const id of strategyChannels(key)) {
    try { await sender.sendMessage(id, text); countSent(key); }
    catch (e) { console.error('Bilan non envoyé', id, e.message); }
  }
}

// message de confirmation envoyé dans le canal dès qu'on configure
// le token API et/ou l'ID du canal d'une stratégie
async function announceConfig(key, mode = 'published') {
  const def = strategies.BY_KEY[key];
  const cfg = state.strategies[key] || {};
  const ids = strategyChannels(key, mode);
  if (!def) return { ok: false, error: 'Stratégie inconnue' };
  if (!ids.length) return { ok: false, error: `Aucun canal ${mode === 'published' ? 'public' : 'silencieux'} configuré pour cette stratégie` };
  const sender = senderFor();
  if (!sender) return { ok: false, error: "Aucun token API configuré dans les réglages" };

  const sent = [];
  const failed = [];
  const infos = [];
  for (const id of ids) {
    const r = await resolveChat(id);
    const info = r.ok ? r.chat : { id, title: String(id), type: '?', memberCount: null, canPost: null };
    if (!r.ok) info.error = r.error;
    const text =
      '✅ CANAL CONFIGURÉ\n\n' +
      `🧠 Stratégie : ${def.name}\n` +
      `📡 Canal : ${info.title}\n` +
      `🆔 ID : ${info.id}\n` +
      (info.memberCount != null ? `👥 Abonnés : ${info.memberCount}\n` : '') +
      `🤖 Bot : @${state.botUsername || 'bot'} (token des réglages)\n` +
      `🎯 Format ${cfg.format} • +${cfg.maxR} rattrapage(s)\n` +
      `📊 Bilan automatique : ${cfg.bilan === false ? 'non' : 'oui'}\n` +
      `🧭 Routage : ${mode === 'published' ? 'prédictions activées' : mode === 'silence' ? "prédictions du mode d'activation silencieux" : 'prédictions silencieuses'}\n\n` +
      `Ce canal recevra désormais les ${mode === 'published' ? 'prédictions publiées' : 'prédictions silencieuses'} de cette stratégie. 🚀`;
    try {
      // l'envoi est tenté même si getChat a échoué : certains canaux ne
      // répondent pas à getChat mais acceptent parfaitement les messages.
      await sender.sendMessage(id, text);
      sent.push(id);
      countSent(key);
      info.confirmed = true;
      info.error = null;
      state.sendErrors[key] = null;
    } catch (e) {
      failed.push({ id, error: e.message });
      info.confirmed = false;
      info.error = e.message;
      state.sendErrors[key] = `${id} : ${e.message}`;
    }
    infos.push(info);
  }
  if (mode === 'silence') cfg.silenceChannelInfos = infos;
  else if (mode === 'shadow') cfg.shadowChannelInfos = infos;
  else {
    cfg.channelInfos = infos;
    cfg.publishedChannelInfos = infos;
  }
  return {
    ok: sent.length > 0,
    sent,
    failed,
    channels: infos,
    error: sent.length ? null : (failed[0] ? `${failed[0].id} : ${failed[0].error}` : 'Envoi impossible'),
  };
}

// envoi d'un message de test dans le(s) canal(aux) d'une stratégie
async function testSend(key, mode = 'published') {
  const def = strategies.BY_KEY[key];
  if (!def) return { ok: false, error: 'Stratégie inconnue' };
  const sender = senderFor();
  if (!sender) return { ok: false, error: "Aucun token API configuré dans les réglages" };
  const ids = strategyChannels(key, mode);
  if (!ids.length) return { ok: false, error: `Aucun canal ${mode === 'published' ? 'public' : 'silencieux'} configuré pour cette stratégie` };
  const cfg = state.strategies[key] || {};
  const preview = fmt.formatPreview(cfg.format, { maxR: cfg.maxR });
  const text = `🧪 TEST D'ENVOI\n\n🧠 ${def.name}\n🧭 ${mode === 'published' ? 'Canal public' : mode === 'silence' ? "Canal du mode d'activation silencieux" : 'Canal silencieux'}\n\n${preview}\n\nSi tu vois ce message, le routage est correctement configuré. ✅`;
  const sent = [];
  const failed = [];
  for (const id of ids) {
    try { await sender.sendMessage(id, text); sent.push(id); countSent(key); }
    catch (e) { failed.push({ id, error: e.message }); }
  }
  state.sendErrors[key] = failed.length ? `${failed[0].id} : ${failed[0].error}` : null;
  return { ok: sent.length > 0, sent, failed, text };
}

// confirmation pour le bot principal (réglages)
// Configure le canal principal (page Configuration) : vérification + message
async function setMainChannel(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: false, error: "Renseigne l'ID du canal (ex : -1001234567890 ou @moncanal)" };
  if (!state.botToken) return { ok: false, error: "Configure d'abord le token API du bot." };
  const check = await resolveChat(value);
  const id = check.ok ? check.chat.id : (/^-?\d+$/.test(value) ? Number(value) : value);
  if (!state.activeChannels.includes(id)) state.activeChannels.push(id);
  if (!state.channels.some((c) => c.id === id)) {
    state.channels.push({ id, title: check.ok ? check.chat.title : String(id) });
  }
  persist();
  const sender = senderFor();
  const text =
    '✅ CANAL PRINCIPAL CONFIGURÉ\n\n' +
    `🤖 Bot : @${state.botUsername || 'bot'}\n` +
    `📡 Canal : ${check.ok ? check.chat.title : id}\n` +
    `🆔 ID : ${id}\n\n` +
    'Le token API et l’ID du canal sont enregistrés en base de données : ' +
    'après un redémarrage tout repart automatiquement. 🚀';
  try {
    await sender.sendMessage(id, text);
    return { ok: true, id, chat: check.ok ? check.chat : { id, title: String(id) }, sent: true };
  } catch (e) {
    return { ok: false, error: `Message non envoyé dans ${id} : ${e.message}`, id };
  }
}

async function announceMainBot() {
  const sender = senderFor();
  if (!sender) return { ok: false, error: 'Aucun token API configuré' };
  const ids = [...new Set([
    ...(state.activeChannels || []),
    ...strategies.LIST.flatMap((d) => strategyChannels(d.key)),
  ])];
  if (!ids.length) return { ok: false, error: "Token enregistré. Configure maintenant un ID de canal pour recevoir les messages." };
  const text =
    '✅ BOT CONNECTÉ\n\n' +
    `🤖 @${state.botUsername || 'bot'}\n` +
    `📡 Canal : ${ids.join(', ')}\n\n` +
    'Le token API est enregistré : ce canal recevra les prédictions. 🚀';
  const sent = [];
  const failed = [];
  for (const id of ids) {
    try { await sender.sendMessage(id, text); sent.push(id); }
    catch (e) { failed.push({ id, error: e.message }); }
  }
  return { ok: sent.length > 0, sent, failed, text };
}

// ---------------------------------------------------------------------------
// Envoi + vérification des prédictions
// ---------------------------------------------------------------------------
async function broadcast(pred) {
  if (db.ready) db.savePrediction(pred, state.B);
  const sender = senderFor();
  if (!sender) {
    state.sendErrors[pred.strategy] = 'Aucun token Telegram configuré';
    return;
  }
  // ── Mode d'activation SILENCIEUX ────────────────────────────────────────
  // Quand il est actif il pilote seul l'envoi de la stratégie : rien ne part
  // tant que le déclencheur (pertes / rattrapages) n'a pas ouvert la fenêtre,
  // puis les prédictions à partir du jeu « déclencheur + N » sont envoyées
  // dans le canal silencieux configuré, jusqu'au nombre demandé.
  const silCfg = state.strategies[pred.strategy] || {};
  if (silCfg.silenceMode) {
    const view = silenceView(pred.strategy);
    pred.silent = true;
    pred.silenceMode = true;
    pred.gate = view.label;
    if (!silenceShouldSend(pred)) return;
    const silIds = strategyChannels(pred.strategy, 'silence');
    if (!silIds.length) { state.sendErrors[pred.strategy] = 'Aucun canal silencieux configuré'; return; }
    await sendPrediction(pred, sender, silIds);
    if (pred.messages.length) noteSilenceSent(pred.strategy);
    pred.gate = silenceView(pred.strategy).label;
    return;
  }

  // Une prédiction en mode silencieux est envoyée uniquement au canal silencieux.
  // Elle ne fuit jamais vers le canal public avant le déclenchement double perte.
  if (!canSend(pred.strategy)) {
    pred.silent = true;
    pred.gate = gateView(pred.strategy).label;
    const shadowIds = strategyChannels(pred.strategy, 'shadow');
    if (!shadowIds.length) return;
    await sendPrediction(pred, sender, shadowIds);
    return;
  }
  pred.silent = false;
  const ids = strategyChannels(pred.strategy);
  if (!ids.length) { state.sendErrors[pred.strategy] = 'Aucun canal configuré'; return; }
  await sendPrediction(pred, sender, ids);
  // panneau « Prédit » : reprise si la stratégie est certifiée 100%
  try { await predit.mirror(pred); } catch (e) { predit.panel.lastError = e.message; }
  // le déclencheur automatique consomme l'autorisation d'envoi
  if (pred.messages.length) noteSent(pred.strategy);
  pred.gate = gateView(pred.strategy).label;
}

async function sendPrediction(pred, sender, ids) {
  state.sendErrors[pred.strategy] = null;
  const { text, parse_mode } = predictionText(pred);
  for (const id of [...new Set(ids)]) {
    try {
      const m = await sender.sendMessage(id, text, parse_mode ? { parse_mode } : {});
      pred.messages.push({ chatId: id, messageId: m.message_id });
      countSent(pred.strategy);
    } catch (e) {
      state.sendErrors[pred.strategy] = `${id} : ${e.message}`;
    }
  }
}

async function updateResult(pred) {
  if (db.ready) db.closePrediction(pred);
  const sender = senderFor();
  if (!sender) return;
  const { text, parse_mode } = predictionText(pred);
  for (const m of pred.messages) {
    try {
      await sender.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId, ...(parse_mode ? { parse_mode } : {}) });
    } catch (e) {
      try { await sender.sendMessage(m.chatId, text, { reply_to_message_id: m.messageId, ...(parse_mode ? { parse_mode } : {}) }); } catch (_) {}
    }
  }
}

// Reconnexion automatique de la base : si elle n'est pas joignable au démarrage
// (ou tombe en panne), on retente régulièrement puis on relit les configurations.
let dbRetryAt = 0;
async function ensureDb() {
  if (db.ready) return;
  if (Date.now() - dbRetryAt < 30000) return;
  dbRetryAt = Date.now();
  const s = await db.connect();
  if (s.ready) {
    console.log('🗄️ Base de données reconnectée');
    const r = await applyDbConfigs();
    console.log('🧠 Configurations relues : ' + ((r.loaded || []).join(', ') || 'aucune'));
  }
}

async function tick() {
  try {
    await ensureDb();
    const games = await api.fetchGames();
    state.lastError = null;
    registerGames(games);

    // déblocage automatique des stratégies bloquées depuis plus de 10 minutes
    const freed = sweepAutoUnlock();
    if (freed.length) console.log('🔓 Déblocage automatique : ' + freed.join(', '));

    const closed = verify();
    for (const p of closed) {
      await updateResult(p);
      bilanPending.add(p.strategy);           // bilan dès que le jeu reprend
    }

    // Le bilan n'est publié QUE lorsque le jeu en live revient au jeu n°1
    // (nouveau sabot), et non à chaque vérification.
    const liveNumber = state.live ? state.live.number : null;
    if (liveNumber && liveNumber !== lastLiveNumber) {
      const prev = lastLiveNumber;
      lastLiveNumber = liveNumber;
      const nouveauSabot = liveNumber === 1 || (prev != null && liveNumber < prev);
      if (nouveauSabot && bilanPending.size) {
        const keys = [...bilanPending];
        bilanPending.clear();
        for (const k of keys) await sendBilan(k);
      }
    }

    const preds = evaluate();
    for (const pred of preds) await broadcast(pred);

    // panneau « Prédit » : prédictions certifiées à 100% (IA)
    await predit.tick();
  } catch (e) {
    state.lastError = e.message;
  }
}

// ---------------------------------------------------------------------------
// Configurations <-> base de données
// ---------------------------------------------------------------------------
// Enregistre TOUTES les configurations existantes (réglages globaux + chaque
// stratégie) dans la base de données.
async function saveConfigsToDb() {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée' };
  await db.setSetting('B', state.B);
  await db.setSetting('maxR', state.maxR);
  await db.setSetting('format', state.format);
  await db.setSetting('template', state.template || '');
  const keys = [];
  for (const def of strategies.LIST) {
    const cfg = state.strategies[def.key];
    if (!cfg) continue;
    await db.saveStrategy(def.key, def.name, cfg);
    keys.push(def.key);
  }
  return { ok: true, saved: keys };
}

// Lit les configurations enregistrées. Si la base est vide (première
// connexion), les configurations en cours y sont écrites automatiquement.
async function applyDbConfigs() {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée' };
  const B = await db.getSetting('B');
  const maxR = await db.getSetting('maxR');
  const tpl = await db.getSetting('template');
  const fmtId = await db.getSetting('format');
  if (B) state.B = parseInt(B, 10) || state.B;
  if (maxR != null) state.maxR = parseInt(maxR, 10);
  if (fmtId) state.format = parseInt(fmtId, 10) || state.format;
  if (tpl !== null) state.template = tpl ? tpl : null;
  // token API, ID administrateur et canaux enregistrés : restaurés au démarrage
  const app = await db.loadAppConfig();
  const restored = [];
  if (app) {
    if (app.botToken && !state.botToken) { state.botToken = app.botToken; restored.push('token'); }
    if (app.adminId && !state.adminId) { state.adminId = app.adminId; restored.push('admin'); }
    if (Array.isArray(app.channels) && app.channels.length && !state.channels.length) {
      state.channels = app.channels; restored.push('canaux');
    }
    if (Array.isArray(app.activeChannels) && app.activeChannels.length && !state.activeChannels.length) {
      state.activeChannels = app.activeChannels; restored.push('canaux actifs');
    }
  }
  const rows = await db.loadStrategies();
  const loaded = [];
  for (const [key, cfg] of Object.entries(rows)) {
    if (!strategies.BY_KEY[key]) continue;
    state.strategies[key] = { ...strategies.defaultsFor(key), ...cfg };
    loaded.push(key);
  }
  initStrategies();
  // base vide OU nouvelles stratégies absentes → on les enregistre tout de suite
  const missing = strategies.LIST.filter((d) => !loaded.includes(d.key)).map((d) => d.key);
  if (missing.length) await saveConfigsToDb();
  store.patch({
    strategies: state.strategies,
    botToken: state.botToken,
    adminId: state.adminId,
    channels: state.channels,
    activeChannels: state.activeChannels,
  });
  return { ok: true, loaded, added: missing, restored };
}

async function startLoop() {
  predit.restore();
  predit.setSender(senderFor);
  // base de données : chaque jeu terminé est archivé par date
  setOnFinished((round) => { if (db.ready) db.saveGame(round); });
  const s = await db.connect();
  console.log(s.ready ? '🗄️ Base de données connectée' : `🗄️ Base non connectée : ${s.error}`);
  if (s.ready) {
    const r = await applyDbConfigs();
    if ((r.restored || []).length) console.log('🔐 Restauré depuis la base : ' + r.restored.join(', '));
    console.log('🧠 Configurations lues en base : ' + ((r.loaded || []).join(', ') || 'aucune') +
      ((r.added || []).length ? ' • ajoutées : ' + r.added.join(', ') : ''));
  } else {
    initStrategies();
  }
  if (!loopStarted) {
    loopStarted = true;
    setInterval(tick, config.POLL_INTERVAL_MS);
    tick();
  }
  startBot();
}

module.exports = { predit, setMainChannel, broadcast, sendPrediction, updateResult, startLoop, startBot, botStatus, activate, deactivate, persist, listChannels, sendBilan, dropSender, announceConfig, announceMainBot, resolveChat, testSend, senderFor, saveConfigsToDb, applyDbConfigs };
