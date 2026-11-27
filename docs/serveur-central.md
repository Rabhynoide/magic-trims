# Serveur central (facultatif)

Le serveur central sert à **partager des decks entre amis d'un même groupe**. Il est entièrement facultatif : sans lui (ou s'il est éteint ou injoignable), l'appli fonctionne exactement comme avant. Les parties, elles, restent toujours hébergées par un joueur depuis l'appli.

## Choix faits

| Sujet | Choix | Pourquoi |
|---|---|---|
| Logiciel | Petit serveur Node maison (`packages/central`), API JSON sur HTTP | Même langage que le reste du jeu, aucun service tiers, déplaçable n'importe où. |
| Données | Un seul fichier SQLite (`node:sqlite`, intégré à Node 22) | Pas de base à installer ; sauvegarder = copier le fichier. |
| Comptes | Un **code secret par groupe d'amis** + un pseudo | Pas d'e-mail ni de mot de passe à gérer entre amis. |
| Hébergement | Au choix : un PC toujours allumé, un petit VPS, ou une offre gratuite qui accepte Node | Le serveur consomme très peu (quelques Mo de mémoire). |

### Comptes et sécurité

- Le code du groupe (ex. `K7Q2M-9XRTA`) est à donner aux amis. Casse, espaces et tirets sont ignorés à la saisie.
- En rejoignant, chaque joueur reçoit un jeton que l'appli garde ; le serveur n'en stocke que l'empreinte (SHA-256).
- Rejoindre avec un pseudo déjà pris dans le groupe reprend ce compte (réinstallation, autre PC) et invalide l'ancien jeton. Entre amis, le code du groupe sert de preuve : ne le diffuse pas en dehors du groupe.
- Après 10 codes faux en 10 minutes, une adresse IP est bloquée temporairement.
- Seul le joueur qui a partagé un deck peut le modifier ou le retirer. Les groupes ne voient pas les decks des autres groupes.
- Le trafic n'est pas chiffré en HTTP simple : pour un serveur sur internet, place-le derrière un proxy HTTPS (Caddy le fait en une ligne) et donne l'adresse en `https://`.

## Lancer le serveur

Il faut **Node 22.13 ou plus récent** et le dépôt cloné.

```sh
npm install
npm run central                         # démarre le serveur (port 47475)
npm run central -- groupes              # affiche les groupes et leurs codes
npm run central -- nouveau-groupe "Les copains du jeudi"
```

Au premier lancement, un groupe « Mes amis » est créé et son code est affiché.

Options : `--port 47475`, `--base chemin/central.sqlite` (par défaut `~/.magic-trims/central.sqlite`), `--upnp` pour demander à la box d'ouvrir le port (renouvelé toutes les 5 heures). Les variables d'environnement `MAGIC_TRIMS_CENTRAL_PORT` et `MAGIC_TRIMS_CENTRAL_DB` font la même chose, pratique sur un hébergeur.

Node affiche un avertissement « SQLite is an experimental feature » : il est sans conséquence.

### Où l'héberger

- **Un PC de la maison toujours allumé** : `npm run central -- --upnp`, puis donne l'adresse publique affichée. Gratuit, mais le PC doit rester allumé.
- **Radmin VPN ou Tailscale** : si le groupe utilise déjà un de ces réseaux pour jouer, l'adresse 26.x ou 100.x du PC suffit, sans ouvrir de port.
- **Un petit VPS** (environ 4 € par mois) : installer Node 22, cloner le dépôt, lancer `npm run central` avec un gestionnaire de service (systemd, pm2), idéalement derrière Caddy pour le HTTPS.

## Dans l'appli

Accueil → **Groupe d'amis (facultatif)** : adresse du serveur et code du groupe, puis **Rejoindre le groupe**. L'adresse peut s'écrire sans `http://` ni port (`monserveur.fr` devient `http://monserveur.fr:47475`).

- **Mes decks importés** → **Partager** envoie le deck au groupe ; **Ne plus partager** le retire. Modifier un deck partagé met aussi à jour la version du groupe.
- **Communauté** liste les decks partagés par le groupe, avec qui les a partagés ; **Copier** l'ajoute à tes decks pour le choisir au salon.
- Si le serveur ne répond pas (5 secondes au plus), l'onglet Communauté l'indique ; rien d'autre ne change.

## API

Toutes les réponses sont en JSON. Les routes marquées 🔒 demandent l'en-tête `Authorization: Bearer <jeton>`.

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/api` | Vérifie qu'il s'agit d'un serveur Magic Trims. |
| POST | `/api/join` `{ code, name }` | Rejoint un groupe, renvoie `{ token, member, group }`. |
| GET 🔒 | `/api/me` | Joueur et groupe du jeton. |
| GET 🔒 | `/api/decks` | Decks partagés du groupe. |
| PUT 🔒 | `/api/decks/:id` `{ name, text, deck }` | Partage ou met à jour un de ses decks. |
| DELETE 🔒 | `/api/decks/:id` | Retire un de ses decks. |

## Plus tard

Les autres pistes de l'issue #23 s'ajouteront sur la même base : résultats de parties et statistiques, tournois, remontée des cartes non gérées par le moteur.
