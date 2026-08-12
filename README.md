# Baccara Control Room

Bot Baccarat 1xbet avec tableau de bord web, moteur multi-stratégies, séparation
des canaux Telegram et analyseur guidé par Pollinations.ai.

## Déploiement sur Render

1. Crée un service Web Node depuis ce dossier.
2. Commande de build : `npm install`
3. Commande de démarrage : `npm start`
4. Health check : `/health`
5. Ajoute les variables suivantes dans Render :

| Variable | Obligatoire | Rôle |
| --- | --- | --- |
| `BOT_TOKEN` | Oui pour Telegram | Token du bot Telegram |
| `ADMIN_ID` | Recommandé | Identifiant Telegram de l'administrateur |
| `DATABASE_URL` | Recommandé | PostgreSQL Render pour conserver l'historique |

| `POLLINATIONS_MODEL` | Non | Modèle Pollinations, valeur par défaut `openai` |

Les clés et les URLs privées ne sont pas incluses dans le ZIP.

## Fonctionnalités

- Accueil simplifié avec accès par boutons aux stratégies, à l'analyseur IA et
  aux 87 formats Telegram.
- Analyseur Pollinations.ai : étude des jeux passés, fréquences de costumes,
  séries, absences, parité et propositions de règles testables.
- Les propositions IA sont enregistrées comme plans inactifs : aucune règle
  générée n'est activée automatiquement.
- Chaque stratégie possède un **canal public** et un **canal silencieux**.
- Une prédiction silencieuse ne part que vers le canal silencieux.
- Une prédiction activée après le filtre double perte ne part que vers le canal
  public.
- Le même identifiant est refusé dans les deux catégories pour éviter les
  doublons de routage.
- La vérification reste basée sur la main du joueur ; la main du banquier est
  conservée pour le contexte et les statistiques.

## Utilisation

Ouvre le tableau de bord sur l'URL du service Render :

- `/#/` : accueil
- `/#/strategies` : catalogue et réglages
- `/#/ai` : analyseur et création de plans
- `/#/formats` : aperçu des formats
- `/#/settings` : token Telegram, base et réglages globaux

Après avoir ajouté le bot comme administrateur dans les canaux Telegram,
renseigne chaque ID dans la fiche de la stratégie correspondante. Utilise les
boutons de test pour vérifier séparément le canal public et le canal silencieux.

## Commandes Telegram conservées

`/live`, `/stats`, `/reglages`, `/canaux`, `/activer`, `/desactiver`,
`/setb`, `/setmaxr`, `/setformat`, `/formats`, `/apercu`, `/settemplate`,
`/setdb`, `/jeux`, `/base`, `/dates`, `/derniers`, `/jeu`, `/pred` et les
commandes de stratégie existantes restent disponibles.

## Avertissement

Les statistiques et les analyses IA décrivent uniquement un historique observé.
Elles ne garantissent pas le résultat d'un jeu et ne doivent pas être présentées
comme une certitude.

## Analyseur IA (Pollinations.ai en dur)

Toutes les adresses de l'API sont écrites en dur dans `config.js` :

- Base : `https://gen.pollinations.ai`
- Texte : `https://gen.pollinations.ai/v1/chat/completions`
- Image : `https://gen.pollinations.ai/image/{PROMPT}?model=flux`
- Vidéo : `https://gen.pollinations.ai/video/{PROMPT}?model=veo&duration=4`
- Audio : `https://gen.pollinations.ai/audio/{TEXT}?voice=nova`
- Modèles : `https://gen.pollinations.ai/v1/models`

La clé se remplace dans `config.js` (`POLLINATIONS.API_KEY`) ou à chaud depuis
la page « Analyseur IA ». Sans clé valide, le moteur local continue d'analyser
seul, en temps réel.

L'analyseur tourne automatiquement : analyse locale toutes les 15 s, enrichissement
Pollinations.ai toutes les 3 min. Chaque constat apparaît dans « Résultats », chaque
stratégie trouvée est enregistrée (désactivée) dans « Stratégies IA créées ».

La page « Envois » vérifie, pour chaque stratégie, le token du bot, les canaux
public et silencieux, le droit de publier et la dernière erreur d'envoi.
