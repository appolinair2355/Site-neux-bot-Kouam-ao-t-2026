# Bot Baccara 1xbet — v2 (déployable sur Render.com)

## Corrections de cette version

- **Vérification fidèle de la main choisie** : les costumes sont lus sur **toute la main**
  (toutes les cartes) du **joueur**, pas sur une seule carte.
- **Compteur B sur les costumes de la main choisie** : +1 quand le costume apparaît,
  **0** quand il manque, et **il ne dépasse jamais le B configuré** : arrivé à B il
  repart à zéro, donc l'apparition suivante remet **1** (ex. B=3 → 1,2,3 puis 1…).
  Le B s'impose à **toutes** les prédictions : aucune prédiction n'est envoyée pendant
  qu'un costume est à son maximum.
- **Rattrapages** : on vérifie d'abord le **numéro prédit**, puis les rattrapages
  configurés ; si le costume n'est jamais venu → ❌. `/setmaxr <n>`
- **Aucun mot de passe** : le tableau de bord et les réglages sont directement
  accessibles (plus de `PANEL_PASSWORD`).
- **77 styles de prédiction** (`/setformat 1..77`, `/formats [page]`, `/apercu <n>`),
  repris de `tg-formats.js` + template personnalisé (`/settemplate`).
- **Aucun `\n` ni `'n` visible** : tous les messages passent par `formats.js`
  (nettoyage + choix automatique du `parse_mode` HTML pour les styles en gras).
- **Main du JOUEUR uniquement** : prédiction, compteur B et vérification lisent
  seulement `player_suits`. La main du banquier est **uniquement archivée** en base.
- **Base de données PostgreSQL Render** : `db.js` à la racine, tables créées
  automatiquement au démarrage.

## Déploiement Render

1. Crée un **PostgreSQL** sur Render et copie l'**Internal/External Database URL**.
2. Crée un **Web Service** Node depuis ce dossier (`npm install` / `npm start`).
3. Ajoute la variable d'environnement `DATABASE_URL` (ou envoie `/setdb <url>` au bot,
   ou colle le lien dans le tableau de bord). Optionnel : `BOT_TOKEN`, `ADMIN_ID`.

## Commandes Telegram

| Commande | Effet |
|---|---|
| `/live` | jeu en cours : cartes, costumes, valeurs, parité, compteurs |
| `/setb <n>` | compteur B (apparitions consécutives max) |
| `/setmaxr <n>` | nombre de rattrapages vérifiés |
| `/setformat <n>` | style du message de prédiction (1-12) |
| `/formats` | liste des styles |
| `/sethand joueur\|banquier` | main dont on lit les costumes et le B |
| `/setdb <url>` | lien PostgreSQL Render |
| `/db` | état de la base |
| `/jeux 2/04/2026` | résumé des jeux stockés pour une date |
| `/canaux`, `/activer <id>`, `/desactiver <id>` | gestion des canaux |
| `/stats`, `/reglages` | suivi |

## Stockage (créé automatiquement)

`games` : `number`, `played_on` (date), `winner` (Joueur/Banquier/Égalité),
`player_cards`, `banker_cards`, `player_suits`, `banker_suits`,
`player_value`, `banker_value`, `player_parity`, `banker_parity`, `phase`, `raw`.

`predictions` : cible, costume, main, B, compteur, rattrapages, statut, tour trouvé.

`settings` : B, rattrapages, main, format.

API web : `/api/state`, `/api/games`, `/api/history?date=2/04/2026`.


## Vérifier les données de la base de données

### Depuis Telegram (le plus simple)

| Commande | Ce qui s'affiche |
|---|---|
| `/db` | état de la connexion + lien masqué |
| `/base` | nombre de jeux, de prédictions, de réglages, dernier jeu, période couverte |
| `/dates` | dates disponibles avec le nombre de jeux par jour |
| `/jeux 7/08/2026` | résumé du jour : total, Joueur/Banquier/Égalité, pair/impair |
| `/derniers 15` | les 15 derniers jeux : cartes joueur, valeur, parité, gagnant |
| `/jeu 1234` | fiche complète d'un jeu (cartes joueur, costumes, banquier archivé, phase) |
| `/pred 7/08/2026` | prédictions du jour : ✅ / ❌ / ⌛, taux de réussite, rattrapage moyen |
| `/sql SELECT number, player_suits FROM games ORDER BY number DESC LIMIT 10` | requête **SELECT uniquement** (lecture seule, 20 lignes max) |

### Depuis le navigateur (API JSON du tableau de bord)

```
GET  /api/db/overview                 → totaux + dates disponibles
GET  /api/db/games?limit=20           → derniers jeux enregistrés
GET  /api/db/game/1234                → un jeu précis
GET  /api/db/predictions?date=7/08/2026 → prédictions + bilan
GET  /api/history?date=7/08/2026      → jeux d'une date
POST /api/db/query {"sql":"SELECT ..."} → requête lecture seule
```

### Depuis un terminal (psql)

```bash
psql "$DATABASE_URL" -c "SELECT number, played_on, winner, player_cards, player_suits,
       player_value, player_parity FROM games ORDER BY number DESC LIMIT 20;"

psql "$DATABASE_URL" -c "SELECT target, suit, max_r, status, rattrapage
       FROM predictions ORDER BY target DESC LIMIT 20;"

# taux de réussite du jour
psql "$DATABASE_URL" -c "SELECT count(*) total,
       count(*) FILTER (WHERE status='gagne') gagne,
       count(*) FILTER (WHERE status='perdu') perdu
       FROM predictions WHERE played_on = current_date;"
```

## Choisir un style de prédiction

1. `/formats` → liste des 77 styles (3 pages : `/formats 2`, `/formats 3`)
2. `/apercu 3` → aperçu du style en ⌛ / ✅ / ❌
3. `/setformat 3` → applique le style
4. `/settemplate 🎯 #{game} | {emoji} {suit} | {status}` → style 100 % personnalisé
   (`/notemplate` pour revenir aux styles numérotés)

## 🟢🔴 Stratégie Pair / Impair (VAR) — clé `parite`

Nouvelle stratégie basée sur **Jeu de départ + VAR + Décalage + Rattrapage**.

### Paramètres
| Paramètre | Clé | Défaut | Rôle |
|---|---|---|---|
| Jeu de départ | `startGame` | 1 | premier jeu déclencheur |
| VAR | `varStep` | 2 | rythme de la séquence des déclencheurs |
| Décalage | `decalage` | 1 | déclencheur + décalage = jeu cible |
| Rattrapage | `maxR` | 3 | nombre de tours de récupération |
| Format | `format` | 80 | style du message (80 à 83 dédiés pair/impair) |

### Séquence des déclencheurs
`trigger(n) = départ + 10n − floor(n / VAR)`

Chaque pas vaut **+10**, sauf tous les **VAR** pas où il vaut **+9** (remise à zéro du compteur VAR).

Départ 1 / VAR 2 → `1 → 11 → 20 → 30 → 39 → 49 → 58 → 68 → 77 → 87 → 96 → 106 …`
(écarts 10, 9, 10, 9, …)

### Règle de prédiction
Sur le jeu déclencheur, seul le **point du JOUEUR** est lu :
* point **pair** → prédiction **IMPAIR**
* point **impair** → prédiction **PAIR**

### Vérification
Jeu cible = déclencheur + décalage. Le bot compare la parité du point du joueur
du jeu cible à la prédiction : identique → ✅ (badge = numéro de rattrapage),
sinon il vérifie les tours suivants jusqu'à `maxR`, puis ❌.

### Reprise automatique
Au démarrage, le bot reconstruit la séquence mathématiquement. Exemple : jeu
actuel 690, départ 1, VAR 2 → dernier déclencheur 685, prochain 695. Aucun jeu
passé n'est rejoué, le bot attend simplement le jeu 695.

### Commandes
```
/parite                              état complet (séquence, dernier/prochain déclencheur)
/setparite 1 2 1 3                   départ, VAR, décalage, rattrapage
/setstrat parite depart 1
/setstrat parite var 2
/setstrat parite decalage 1
/setstrat parite maxr 3
/setstrat parite format 80
/activerstrat parite | /desactiverstrat parite
```

### Formats compatibles
Tous les styles acceptent pair/impair, et **4 styles dédiés** ont été ajoutés :
`80` (carte complète), `81` (style ⚜ classique), `82` (ligne 🌈), `83` (encadré ⚜️).
Total : **83 formats** (`/formats`, `/apercu <n>`).


## Nouveautés

### Pair / Impair (VAR) — déclenchement immédiat
La prédiction part **dès que le jeu déclencheur est terminé** : point du joueur pair
→ prédiction IMPAIR, point impair → prédiction PAIR, sur le jeu déclencheur + décalage.

### Prédiction dans l'ombre (`ombre`)
Surveillance silencieuse des 4 costumes. Un costume absent pendant au moins
`absence` jeux (4 par défaut) est mis sous surveillance ; **aucune prédiction**
tant qu'il n'est pas revenu. Le jeu du retour devient le déclencheur et le même
costume est prédit au jeu **+ `lead`** (4 par défaut).
Exemple : ❤️ absent aux jeux 1→4, retour au jeu 8 → prédiction ❤️ sur le jeu 12.
Formats de message dédiés : **84, 85, 86**.

### Mode silencieux « double perte » (toutes les stratégies)
- `silent` : la stratégie calcule et vérifie ses prédictions sans rien envoyer.
- Une **1ʳᵉ perte** ouvre une fenêtre de `lossWindow` prédictions maximum.
- Une **2ᵉ perte** dans cette fenêtre → l'envoi vers le canal est activé.
  (perte+perte = 1 ; perte/gagné/perte = 2 …)
- Fenêtre dépassée sans 2ᵉ perte → le compteur repart à zéro.
- `resetOnWin` (activé par défaut) : après activation, un gain referme l'envoi.

### Configurations en base de données
- `/sauverconfig` (Telegram) ou « 💾 Tout enregistrer en base » (panel) : enregistre
  tous les réglages et toutes les stratégies.
- `/configs` ou `GET /api/configs` : lit les configurations enregistrées.
- Au démarrage le bot lit la base ; toute configuration absente y est ajoutée
  automatiquement.

### Commandes ajoutées
`/ombre`, `/silence <clé> <on|off> [fenêtre]`, `/filtres`, `/sauverconfig`, `/configs`,
et `/setstrat <clé> <absence|scope|silence|fenetre|resetgain> <valeur>`.
