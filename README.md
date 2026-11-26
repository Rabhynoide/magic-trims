# Magic Trims

Une table de jeu **Magic: The Gathering Commander** pour jouer entre amis à distance, jusqu'à 5 joueurs en multijoueur libre, sous Windows.

Projet privé, entre amis. Les données et images des cartes viennent de [Scryfall](https://scryfall.com) ; les decks s'importent depuis [Moxfield](https://moxfield.com).

## Feuille de route

1. **Fondations et decks** : modèle de partie, système d'actions, import Moxfield + Scryfall. *(fait)*
2. **Multijoueur** : chaque joueur peut héberger la partie depuis l'appli, sans serveur à payer. *(fait)*
3. **Table virtuelle jouable (v1)** : interface, glisser-déposer, installateur Windows. *(en cours)*
4. **Moteur de règles** : tours et phases, mana, pile, puis effets des cartes courantes, petit à petit.

## Modes de jeu

L'hôte choisit le mode en créant la partie (`createGame({ mode, ... })`) :

| Mode | Joueurs | Particularités |
|---|---|---|
| Chacun pour soi | 1 à 5 | Le dernier joueur en lice gagne. |
| Duel | 2 | 20 points de vie par défaut, comme en Duel Commander (réglable). |
| Équipes | 4 ou 5 | 2 contre 2 ou 2 contre 3. Points de vie et tours séparés ; les équipes alternent autour de la table. |
| Géant à deux têtes | 4 | Deux équipes de deux : tour commun, 60 PV, poison (15) et blessures de commandant partagés, mains visibles entre coéquipiers. |
| Étoile (Pentacle) | 5 | Tes ennemis sont les deux joueurs non adjacents ; tu gagnes quand ils sont éliminés. |
| Archenemy | 3 à 5 | Un joueur seul contre une équipe qui joue en même temps ; pioche de machinations, 80 PV par défaut. |

**Planechase** (pioche de plans partagée, dé planaire) se combine avec n'importe quel mode.

Tous les réglages (points de vie, poison, partage entre coéquipiers…) restent modifiables par l'hôte. Mis de côté pour plus tard : Empereur (6 joueurs) et Grande Mêlée (10 et plus), qui demandent de relever la limite de 5 joueurs.

`evaluateOutcome()` indique les joueurs éliminés (points de vie, poison, blessures de commandant, abandon) et les vainqueurs selon le mode.

## Lancer l'appli

```sh
npm install
npm run app     # lance l'appli en mode développement
npm run dist    # fabrique l'installateur Windows dans packages/app/release/
```

Si `npm run app` affiche « Electron uninstall », lance `node scripts/install-electron.mjs` (téléchargement du binaire d'Electron, normalement fait par `npm install`).

L'installateur est aussi fabriqué automatiquement par GitHub Actions à chaque modification de `main` : onglet **Actions** du dépôt → dernier passage → **MagicTrims-installateur-windows**.

### Jouer

- **Accueil** : ton pseudo, héberger une partie ou en rejoindre une avec un code, et tes decks.
- **Importer un deck** : colle la liste exportée depuis Moxfield (*Export → Copy for Moxfield*) ou deckstats.net (*Exporter → Texte*). L'appli retrouve les cartes sur Scryfall et signale les problèmes de construction.
- **Salon** : chacun choisit son deck ; l'hôte choisit le mode, les équipes, les points de vie, Planechase, et s'il accepte les decks non légaux pour le mode.
- **Table** :
  - glisser-déposer les cartes entre la main, le champ de bataille, le cimetière, l'exil, la bibliothèque, la zone de commandement et la pile ; déposer une carte sur le champ de bataille d'un autre joueur lui en donne le contrôle ;
  - **double-clic** : engager / dégager (sur le champ de bataille), jouer la carte (dans la main) ;
  - **clic droit** sur une carte : marqueurs, face cachée, transformer, déplacer, donner le contrôle, révéler ;
  - **clic sur la bibliothèque** : piocher, mélanger, regarder ou révéler le dessus, meuler, exiler ;
  - points de vie, poison et blessures de commandant avec les boutons − / + (Maj+clic : ±5) ;
  - jetons (recherche Scryfall), dés, mulligan, journal de la partie et discussion.
- **Langue des cartes** (accueil ou barre du bas de la table) : chaque joueur choisit la sienne (français par défaut). L'appli affiche l'impression Scryfall dans cette langue, de la même édition si elle existe, sinon d'une autre ; une carte jamais imprimée dans cette langue reste en anglais. Les traductions sont gardées en cache sur le PC.

## Héberger une partie

N'importe quel joueur peut héberger : l'appli lance un petit serveur sur son PC (port 47474) et affiche des **codes de connexion** à donner aux amis (par exemple `60001-05EBJ`), ou l'adresse en clair.

- **Par internet** : l'appli demande à la box d'ouvrir le port (UPnP). Ça marche sur la plupart des box ; sinon, il faut ouvrir le port 47474 à la main dans la box.
- **Avec un réseau privé virtuel** (Radmin VPN, Tailscale) : tout le monde l'installe et rejoint le même réseau, et ça marche à coup sûr. L'appli affiche alors l'adresse correspondante.
- Au premier lancement, Windows demande d'autoriser l'appli dans le pare-feu : il faut accepter.

La partie est sauvegardée automatiquement chez l'hôte. S'il se déconnecte, la partie reprend là où elle en était ; les autres joueurs se reconnectent tout seuls.

Pour tester sans interface : `npm run host` (ou `npm run host -- --reprendre` pour reprendre la dernière partie).

## Organisation du code

```
packages/
  core/   Logique de jeu pure, protocole réseau et client de connexion
  host/   Serveur de partie intégré à l'appli de l'hôte (Node.js)
  app/    Appli Windows (Electron + React)
```

### `@magic-trims/core`

- `types.ts` : l'état d'une partie (joueurs, zones, cartes, points de vie, blessures de commandant, poison…).
- `actions.ts` : la liste des actions possibles (piocher, déplacer une carte, engager, mulligan, passer le tour…).
- `reducer.ts` : `applyAction(état, { actorId, action })` valide une action et retourne le nouvel état. **Toute modification de la partie passe par là** : c'est ici que le moteur de règles viendra se brancher.
- `setup.ts` : `createGame()` met en place une partie (places selon le mode, commandants, mélange, mains de départ).
- `modes.ts` : les modes de jeu, les équipes et la détection des vainqueurs.
- `view.ts` : `viewFor(état, joueur)` donne ce qu'un joueur a le droit de voir (pas les mains adverses, pas l'ordre des bibliothèques). C'est ce que le serveur enverra à chaque client.
- `deck/` : lecture d'une liste Moxfield, résolution des cartes sur Scryfall (avec cache), vérification des règles de construction Commander.
- `protocol.ts` : les messages échangés entre les joueurs et l'hôte, et les codes de connexion.
- `client.ts` : `GameClient`, la connexion d'un joueur à la partie (reconnexion automatique, cache des cartes).

### `@magic-trims/host`

- `game-host.ts` : `GameHost`, l'arbitre : salon (decks, mode, équipes), lancement, actions, vue de chaque joueur, reprise d'une sauvegarde.
- `server.ts` : `startHostServer()`, le serveur WebSocket que l'appli de l'hôte lance, avec sauvegarde automatique.
- `upnp.ts` : ouverture du port sur la box.

## Développement

Il faut [Node.js](https://nodejs.org) 20 ou plus récent.

```sh
npm install
npm test           # tests
npm run typecheck  # vérification des types
```

## Importer un deck

- **Moxfield** : sur la page du deck, **Export** → **Copy for Moxfield** (ou « Copy for MTGO / Arena »).
- **deckstats.net** : **Exporter** → **Texte**. Le commandant est repéré par la mention `# !Commander`.

Ni l'un ni l'autre n'a d'API publique officielle, d'où le copier-coller.
