# Serveur central (facultatif)

Le serveur central sert à **partager des decks entre amis d'un même groupe**. Il est entièrement facultatif : sans lui (ou s'il est injoignable), l'appli fonctionne exactement comme avant. Les parties, elles, restent hébergées par un joueur depuis l'appli.

## Choix faits

| Sujet | Choix | Pourquoi |
|---|---|---|
| Hébergement | **Cloudflare Workers + Durable Objects**, offre gratuite | Gratuit, sans carte bancaire, toujours disponible, sans machine à entretenir. |
| Données | SQLite intégré au Durable Object | Pas de base à créer ni à payer ; les données restent chez Cloudflare. |
| Comptes | Un **code secret par groupe d'amis** + un pseudo | Pas d'e-mail ni de mot de passe à gérer entre amis. |
| Code | `packages/central` : la logique (`handler.ts`, `store.ts`) n'utilise que des API web standard | Le même code tourne sur Cloudflare et dans un petit serveur Node d'essai local (et les tests). |

**Limites de l'offre gratuite** : 100 000 requêtes par jour, très au-delà de l'usage d'un groupe d'amis (chaque ouverture de l'onglet Communauté ou partage = 1 requête). En cas de dépassement, les requêtes échouent jusqu'au lendemain ; rien n'est jamais facturé.

### Comptes et sécurité

- Le code du groupe (ex. `K7Q2M-9XRTA`) est à donner aux amis. Casse, espaces et tirets sont ignorés à la saisie.
- En rejoignant, chaque joueur reçoit un jeton que l'appli garde ; le serveur n'en stocke que l'empreinte (SHA-256).
- Rejoindre avec un pseudo déjà pris dans le groupe reprend ce compte (réinstallation, autre PC) et invalide l'ancien jeton. Entre amis, le code du groupe sert de preuve : ne le diffuse pas en dehors du groupe.
- Après 10 codes faux en 10 minutes, une adresse IP est bloquée temporairement.
- Seul le joueur qui a partagé un deck peut le modifier ou le retirer. Les groupes ne voient pas les decks des autres groupes.
- Les groupes se créent avec une **clé d'administration** que toi seul connais (secret Cloudflare `ADMIN_KEY`).
- Cloudflare sert tout en HTTPS.

## Mise en ligne (une seule fois, environ 10 minutes)

Il faut Node 22 et le dépôt à jour (`git pull`, `npm install`). Les commandes se tapent à la racine du dépôt, dans PowerShell.

1. **Créer un compte Cloudflare** gratuit sur <https://dash.cloudflare.com/sign-up> (e-mail + mot de passe, pas de carte bancaire). Au premier passage dans **Workers & Pages**, Cloudflare demande de choisir un sous-domaine `xxx.workers.dev` : choisis-en un (par exemple ton pseudo).
2. **Se connecter depuis le PC** :
   ```sh
   npx wrangler@4 login
   ```
   Le navigateur s'ouvre ; accepte l'autorisation.
3. **Déployer** :
   ```sh
   npm run central:deploy
   ```
   À la fin, wrangler affiche l'adresse du serveur, du genre `https://magic-trims-central.xxx.workers.dev`. Note-la.
4. **Choisir la clé d'administration** (une longue phrase ou suite de caractères que tu gardes pour toi) :
   ```sh
   cd packages/central
   npx wrangler@4 secret put ADMIN_KEY
   cd ../..
   ```
   wrangler demande la valeur : colle ta clé.
5. **Créer le groupe d'amis** :
   ```sh
   npm run central -- nouveau-groupe "Les amis" --distant https://magic-trims-central.xxx.workers.dev --cle TA_CLE
   ```
   La commande affiche le **code du groupe**. `groupes` à la place de `nouveau-groupe "…"` réaffiche les groupes et leurs codes.
6. **Donner aux amis** l'adresse (`magic-trims-central.xxx.workers.dev`) et le code du groupe.

Pour mettre à jour le serveur après une nouvelle version du jeu : `git pull` puis `npm run central:deploy`. Les données sont conservées.

## Dans l'appli

Accueil → **Groupe d'amis (facultatif)** : adresse du serveur et code du groupe, puis **Rejoindre le groupe**. L'adresse peut s'écrire sans `https://`.

- **Mes decks importés** → **Partager** envoie le deck au groupe ; **Ne plus partager** le retire. Modifier un deck partagé met aussi à jour la version du groupe.
- **Communauté** liste les decks partagés par le groupe, avec qui les a partagés ; **Copier** l'ajoute à tes decks pour le choisir au salon.
- Si le serveur ne répond pas (5 secondes au plus), l'onglet Communauté l'indique ; rien d'autre ne change.

## Essai local, sans Cloudflare

```sh
npm run central                         # serveur d'essai sur ce PC (port 47475), crée le groupe « Mes amis »
npm run central -- groupes              # groupes de la base locale (~/.magic-trims/central.sqlite)
```

Dans l'appli, l'adresse est alors `localhost`. Node affiche un avertissement « SQLite is an experimental feature » : il est sans conséquence. Pour essayer le vrai Worker sur ce PC : `npm run dev:worker -w @magic-trims/central`.

## API

Toutes les réponses sont en JSON. Les routes marquées 🔒 demandent l'en-tête `Authorization: Bearer <jeton>` ; 🔑 demande la clé d'administration.

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/api` | Vérifie qu'il s'agit d'un serveur Magic Trims. |
| POST | `/api/join` `{ code, name }` | Rejoint un groupe, renvoie `{ token, member, group }`. |
| GET 🔒 | `/api/me` | Joueur et groupe du jeton. |
| GET 🔒 | `/api/decks` | Decks partagés du groupe. |
| PUT 🔒 | `/api/decks/:id` `{ name, text, deck }` | Partage ou met à jour un de ses decks. |
| DELETE 🔒 | `/api/decks/:id` | Retire un de ses decks. |
| GET 🔑 | `/api/admin/groups` | Liste les groupes et leurs codes. |
| POST 🔑 | `/api/admin/groups` `{ name }` | Crée un groupe. |

## Plus tard

Les autres pistes de l'issue #23 s'ajouteront sur la même base : résultats de parties et statistiques, tournois, remontée des cartes non gérées par le moteur.
