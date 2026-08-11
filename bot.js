// bot.js — bot Telegram + boucle de prédiction/vérification
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const api = require('./api');
const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const strategies = require('./strategies');
const {
  state, evaluate, verify, registerGames, setOnFinished,
  predictionText, predictionMessage, liveText, stats, SUITS,
  initStrategies, setStrategyConfig, resetStrategy, strategyChannels, parityRuntime,
  bilanText,
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
  });
  if (db.ready) {
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
  '/setformat <1-83> — style du message de prédiction\n' +
  '/formats [page] — liste des 83 styles (80-83 = pair/impair)\n' +
  '/apercu <n> — aperçu complet d\'un style (⌛ / ✅ / ❌)\n' +
  '/settemplate <texte> — style personnalisé ({game} {emoji} {suit} {status} {maxR})\n' +
  '/notemplate — revenir au style numéroté\n\n' +
  '*Stratégies*\n' +
  '/strategies — liste des stratégies et leur état\n' +
  '/strategie <clé> — détail + configuration d\'une stratégie\n' +
  '/activerstrat <clé> — activer une stratégie\n' +
  '/desactiverstrat <clé> — désactiver une stratégie\n' +
  '/setstrat <clé> <format|maxr|b|lead|depart|var|decalage|template> <valeur>\n' +
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
    `• Format : *${state.format}/77*${state.template ? ' (template perso)' : ''}\n` +
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
    };
    if (!map[field]) return b.sendMessage(msg.chat.id, '⚠️ Champ inconnu (format, formatdistribution, maxr, b, lead, depart, var, decalage, streak, template).');
    const cfg = setStrategyConfig(key, { [map[field]]: value });
    persist();
    b.sendMessage(msg.chat.id, `✅ ${strategies.BY_KEY[key].name} → ${field} = ${cfg[map[field]]}\n\n${fmt.formatPreview(cfg.format, { maxR: cfg.maxR })}`);
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
async function announceConfig(key) {
  const def = strategies.BY_KEY[key];
  const cfg = state.strategies[key] || {};
  const ids = strategyChannels(key);
  if (!def) return { ok: false, error: 'Stratégie inconnue' };
  if (!ids.length) return { ok: false, error: 'Aucun canal configuré pour cette stratégie' };
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
      `📊 Bilan automatique : ${cfg.bilan === false ? 'non' : 'oui'}\n\n` +
      'Ce canal recevra désormais les prédictions de cette stratégie. 🚀';
    try {
      await sender.sendMessage(id, text);
      sent.push(id);
      countSent(key);
      info.confirmed = true;
    } catch (e) {
      failed.push({ id, error: e.message });
      info.confirmed = false;
      info.error = e.message;
    }
    infos.push(info);
  }
  cfg.channelInfos = infos;
  return { ok: sent.length > 0, sent, failed, channels: infos };
}

// envoi d'un message de test dans le(s) canal(aux) d'une stratégie
async function testSend(key) {
  const def = strategies.BY_KEY[key];
  if (!def) return { ok: false, error: 'Stratégie inconnue' };
  const sender = senderFor();
  if (!sender) return { ok: false, error: "Aucun token API configuré dans les réglages" };
  const ids = strategyChannels(key);
  if (!ids.length) return { ok: false, error: 'Aucun canal configuré pour cette stratégie' };
  const cfg = state.strategies[key] || {};
  const preview = fmt.formatPreview(cfg.format, { maxR: cfg.maxR });
  const text = `🧪 TEST D'ENVOI\n\n🧠 ${def.name}\n\n${preview}\n\nSi tu vois ce message, les prédictions arriveront bien ici. ✅`;
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
async function announceMainBot() {
  const sender = senderFor();
  if (!sender) return { ok: false, error: 'Aucun token API configuré' };
  const ids = state.activeChannels || [];
  if (!ids.length) return { ok: false, error: 'Aucun canal actif' };
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
  if (!sender) { state.sendErrors[pred.strategy] = 'Aucun token Telegram configuré'; return; }
  const ids = strategyChannels(pred.strategy);
  if (!ids.length) { state.sendErrors[pred.strategy] = 'Aucun canal configuré'; return; }
  state.sendErrors[pred.strategy] = null;
  const { text, parse_mode } = predictionText(pred);
  for (const id of ids) {
    try {
      const m = await sender.sendMessage(id, text, parse_mode ? { parse_mode } : {});
      pred.messages.push({ chatId: id, messageId: m.message_id });
      countSent(pred.strategy);
    } catch (e) {
      state.sendErrors[pred.strategy] = `${id} : ${e.message}`;
      console.error('Envoi échoué', id, e.message);
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

async function tick() {
  try {
    const games = await api.fetchGames();
    state.lastError = null;
    registerGames(games);

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
  } catch (e) {
    state.lastError = e.message;
  }
}

async function startLoop() {
  // base de données : chaque jeu terminé est archivé par date
  setOnFinished((round) => { if (db.ready) db.saveGame(round); });
  const s = await db.connect();
  console.log(s.ready ? '🗄️ Base de données connectée' : `🗄️ Base non connectée : ${s.error}`);
  if (s.ready) {
    const B = await db.getSetting('B');
    const maxR = await db.getSetting('maxR');
    const tpl = await db.getSetting('template');
    const fmtId = await db.getSetting('format');
    if (B) state.B = parseInt(B, 10) || state.B;
    if (maxR != null) state.maxR = parseInt(maxR, 10);
    if (fmtId) state.format = parseInt(fmtId, 10) || state.format;
    state.template = tpl ? tpl : null;
    const rows = await db.loadStrategies();
    for (const [key, cfg] of Object.entries(rows)) {
      if (strategies.BY_KEY[key]) state.strategies[key] = { ...strategies.defaultsFor(key), ...cfg };
    }
    initStrategies();
    console.log('🧠 Stratégies chargées depuis la base : ' + Object.keys(rows).join(', ') || 'aucune');
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

module.exports = { startLoop, startBot, botStatus, activate, deactivate, persist, listChannels, sendBilan, dropSender, announceConfig, announceMainBot, resolveChat, testSend, senderFor };
