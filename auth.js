// auth.js — protection du tableau de bord web
//
//  • Compte administrateur fixe : identifiant « sossoukouam » / mot de passe
//    « arrow2026 » (semé automatiquement en base au premier démarrage, une
//    seule fois — un changement de mot de passe ultérieur n'est jamais
//    écrasé au redémarrage).
//  • Si les identifiants ne correspondent à aucun compte connu, la personne
//    peut créer un compte : email @gmail.com + mot de passe + confirmation.
//  • Un code de confirmation à 6 chiffres est alors envoyé sur cette adresse
//    Gmail (via le compte expéditeur configuré une fois par l'admin) et
//    expire au bout de 15 minutes.
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');

const ADMIN_IDENTIFIER = 'sossoukouam';
const ADMIN_PASSWORD_DEFAULT = 'arrow2026';
const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CODE_ATTEMPTS = 5;

function normalize(v) {
  return String(v || '').trim().toLowerCase();
}

function isGmail(email) {
  return /^[^\s@]+@gmail\.com$/i.test(normalize(email));
}

function genCode() {
  return String(crypto.randomInt(100000, 1000000)); // toujours 6 chiffres
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

// ---------------------------------------------------------------------------
// Compte administrateur — semé une seule fois (ON CONFLICT DO NOTHING) pour
// ne jamais écraser un mot de passe déjà changé par la suite.
// ---------------------------------------------------------------------------
async function ensureAdminSeed() {
  if (!db.ready) return;
  try {
    const hash = await bcrypt.hash(ADMIN_PASSWORD_DEFAULT, 10);
    await db.exec(
      `INSERT INTO users (identifier, email, password_hash, role, verified)
       VALUES ($1, NULL, $2, 'admin', true)
       ON CONFLICT (identifier) DO NOTHING`,
      [ADMIN_IDENTIFIER, hash]
    );
  } catch (e) { console.error('Seed admin impossible :', e.message); }
}

async function findUser(identifierOrEmail) {
  const v = normalize(identifierOrEmail);
  if (!v) return null;
  const rows = await db.rows(
    `SELECT * FROM users WHERE lower(identifier) = $1 OR lower(email) = $1 LIMIT 1`,
    [v]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------
async function login(identifierRaw, password) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée.' };
  const identifier = normalize(identifierRaw);
  const pwd = String(password || '');
  if (!identifier || !pwd) return { ok: false, error: 'Identifiant et mot de passe requis.' };
  const user = await findUser(identifier);
  if (!user) return { ok: false, error: 'Identifiants incorrects.', unknown: true };
  if (!user.verified) {
    return {
      ok: false,
      error: "Ce compte n'est pas encore vérifié — un code de confirmation est requis.",
      needsVerification: true,
      email: user.email,
    };
  }
  const match = await bcrypt.compare(pwd, user.password_hash);
  if (!match) return { ok: false, error: 'Identifiants incorrects.' };
  return { ok: true, userId: user.id, identifier: user.identifier, role: user.role };
}

// ---------------------------------------------------------------------------
// Création de compte (si les identifiants fournis ne correspondent à rien)
// ---------------------------------------------------------------------------
async function signup(emailRaw, password, confirmPassword) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée.' };
  const email = normalize(emailRaw);
  if (!isGmail(email)) return { ok: false, error: 'Seules les adresses @gmail.com sont acceptées.' };
  if (!password || String(password).length < 6)
    return { ok: false, error: 'Mot de passe trop court (6 caractères minimum).' };
  if (password !== confirmPassword)
    return { ok: false, error: 'Les deux mots de passe ne correspondent pas.' };

  const existing = await findUser(email);
  if (existing && existing.verified)
    return { ok: false, error: 'Un compte existe déjà avec cet email — connectez-vous.' };

  const hash = await bcrypt.hash(String(password), 10);
  if (existing) {
    await db.exec(`UPDATE users SET password_hash = $2 WHERE id = $1`, [existing.id, hash]);
  } else {
    await db.exec(
      `INSERT INTO users (identifier, email, password_hash, role, verified)
       VALUES ($1, $1, $2, 'user', false)`,
      [email, hash]
    );
  }

  return sendConfirmationCode(email);
}

async function sendConfirmationCode(emailRaw) {
  const email = normalize(emailRaw);
  const code = genCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await db.exec(
    `INSERT INTO email_codes (email, code_hash, attempts, expires_at, created_at)
     VALUES ($1, $2, 0, $3, now())
     ON CONFLICT (email) DO UPDATE SET
       code_hash = EXCLUDED.code_hash, attempts = 0,
       expires_at = EXCLUDED.expires_at, created_at = now()`,
    [email, hashCode(code), expiresAt]
  );
  try {
    await sendMail(email, code);
  } catch (e) {
    return { ok: false, error: `Compte créé mais l'envoi de l'email a échoué : ${e.message}` };
  }
  return { ok: true, email };
}

async function resend(emailRaw) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée.' };
  const email = normalize(emailRaw);
  const user = await findUser(email);
  if (!user || user.verified)
    return { ok: false, error: 'Aucune inscription en attente pour cet email.' };
  return sendConfirmationCode(email);
}

// ---------------------------------------------------------------------------
// Vérification du code (expire après 15 min, 5 tentatives max)
// ---------------------------------------------------------------------------
async function verify(emailRaw, codeRaw) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée.' };
  const email = normalize(emailRaw);
  const code = String(codeRaw || '').trim();
  if (!email || !code) return { ok: false, error: 'Email et code requis.' };

  const rows = await db.rows(`SELECT * FROM email_codes WHERE email = $1`, [email]);
  const row = rows[0];
  if (!row) return { ok: false, error: "Aucun code en attente pour cet email — recommencez l'inscription." };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'Code expiré (15 minutes) — demandez-en un nouveau.', expired: true };
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    return { ok: false, error: 'Trop de tentatives incorrectes — demandez un nouveau code.', expired: true };
  }
  if (hashCode(code) !== row.code_hash) {
    await db.exec(`UPDATE email_codes SET attempts = attempts + 1 WHERE email = $1`, [email]);
    return { ok: false, error: `Code incorrect (${row.attempts + 1}/${MAX_CODE_ATTEMPTS} tentatives).` };
  }

  await db.exec(`UPDATE users SET verified = true WHERE email = $1`, [email]);
  await db.exec(`DELETE FROM email_codes WHERE email = $1`, [email]);
  const user = await findUser(email);
  return { ok: true, userId: user.id, identifier: user.identifier, role: user.role };
}

// ---------------------------------------------------------------------------
// Compte Resend expéditeur — configuré UNE FOIS par l'admin (stocké en base,
// réutilisé pour tous les envois de code suivants). Resend envoie par API
// HTTP (port 443, jamais bloqué) au lieu du SMTP classique — voir
// https://resend.com/docs/api-reference/emails/send-email.
// ---------------------------------------------------------------------------
async function configureMailSender(apiKeyRaw, fromRaw) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée.' };
  const apiKey = String(apiKeyRaw || '').trim();
  if (!apiKey) return { ok: false, error: "Clé API Resend requise (créez un compte sur resend.com)." };
  const from = String(fromRaw || '').trim();
  await db.setSetting('resend_api_key', apiKey);
  if (from) await db.setSetting('resend_from', from);
  return { ok: true, from: from || null };
}

async function mailerStatus() {
  let apiKey = null, from = null;
  if (db.ready) {
    apiKey = await db.getSetting('resend_api_key');
    from = await db.getSetting('resend_from');
  }
  apiKey = apiKey || config.RESEND_API_KEY;
  from = from || config.RESEND_FROM;
  return { configured: !!(apiKey && apiKey !== 'RESEND_API_KEY_A_REMPLACER'), from: from || null };
}

// ---------------------------------------------------------------------------
// Diagnostic public (aucune donnée sensible renvoyée) — pour comprendre,
// sans être connecté, pourquoi la connexion admin échoue en production :
// la base utilisée est-elle bien joignable ? le compte existe-t-il vraiment ?
// ---------------------------------------------------------------------------
async function debugInfo() {
  const dbStatus = db.status();
  if (!dbStatus.ready) {
    return { db: dbStatus, usersTableReachable: false };
  }
  let userCount = null;
  let adminExists = false;
  let adminVerified = null;
  try {
    const countRows = await db.rows(`SELECT count(*)::int AS n FROM users`);
    userCount = countRows[0] ? countRows[0].n : null;
    const admin = await findUser(ADMIN_IDENTIFIER);
    adminExists = !!admin;
    adminVerified = admin ? !!admin.verified : null;
  } catch (e) {
    return { db: dbStatus, usersTableReachable: false, error: e.message };
  }
  return { db: dbStatus, usersTableReachable: true, userCount, adminExists, adminVerified };
}

async function sendMail(to, code) {
  let apiKey = null, from = null;
  if (db.ready) {
    apiKey = await db.getSetting('resend_api_key');
    from = await db.getSetting('resend_from');
  }
  // Repli sur la clé Resend écrite en dur dans config.js.
  apiKey = apiKey || config.RESEND_API_KEY;
  from = from || config.RESEND_FROM;
  if (!apiKey || apiKey === 'RESEND_API_KEY_A_REMPLACER') {
    throw new Error(
      "Clé API Resend non configurée — l'administrateur doit la renseigner une fois dans les réglages de sécurité."
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // 8s au lieu de rester planté
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'Code de confirmation — Baccara Bot',
        text:
          `Votre code de confirmation est : ${code}\n\n` +
          `Il expire dans 15 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Délai dépassé en contactant Resend (8s).');
    throw new Error(`Connexion à Resend impossible : ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try { const body = await res.json(); detail = body && (body.message || JSON.stringify(body)); } catch (_) {}
    throw new Error(`Resend a refusé l'envoi (${res.status})${detail ? ' : ' + detail : ''}`);
  }
}

module.exports = {
  ADMIN_IDENTIFIER,
  ensureAdminSeed,
  login,
  signup,
  verify,
  resend,
  configureMailSender,
  mailerStatus,
  debugInfo,
};
