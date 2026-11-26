# Magic Trims

Une table de jeu **Magic: The Gathering Commander** pour jouer entre amis à distance, jusqu'à 5 joueurs en multijoueur libre, sous Windows.

Projet privé, entre amis. Les données et images des cartes viennent de [Scryfall](https://scryfall.com) ; les decks s'importent depuis [Moxfield](https://moxfield.com), [deckstats.net](https://deckstats.net) ou [Archidekt](https://archidekt.com).

## Feuille de route

1. **Fondations et decks** : modèle de partie, système d'actions, import Moxfield + Scryfall. *(fait)*
2. **Multijoueur** : chaque joueur peut héberger la partie depuis l'appli, sans serveur à payer. *(fait)*
3. **Table virtuelle jouable (v1)** : interface, glisser-déposer, installateur Windows. *(fait)*
4. **Moteur de règles** : tours et phases, mana, pile, puis effets des cartes courantes, petit à petit. *(en cours : tours et phases, priorité et pile, mana, terrains et sorts faits)* Le mode manuel reste toujours disponible pour ce que le moteur ne gère pas.

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
- **Importer un deck** : colle la liste exportée depuis Moxfield (*Export → Copy for Moxfield*) ou deckstats.net (*Exporter → Texte*), ou le lien d'un deck Archidekt. L'appli retrouve les cartes sur Scryfall et signale les problèmes de construction.
- **Salon** : chacun choisit son deck ; l'hôte choisit le mode, les équipes, les points de vie, Planechase, et s'il accepte les decks non légaux pour le mode.
- **Table** :
  - **tour et phases** : la barre au-dessus des boutons montre l'étape en cours. **Étape suivante** (ou Entrée) avance d'une étape ; un clic sur une étape plus loin y va directement ; **Finir le tour** passe au joueur suivant. Le dégagement au début du tour et la pioche à l'étape de pioche sont automatiques (pas de pioche au premier tour d'une partie à deux ni pour l'équipe qui commence en Géant à deux têtes), et le nettoyage rappelle s'il faut défausser au-delà de 7 cartes. L'hôte peut couper ces automatismes dans le salon ;
  - **pile et priorité** : quand une carte arrive sur la pile, son lanceur reçoit la priorité, puis chacun **passe la priorité** à son tour (bouton ou Entrée) ou répond avec une autre carte. Quand tout le monde a passé d'affilée, le dessus de la pile se résout : un permanent arrive sur le champ de bataille, un éphémère ou un rituel va au cimetière (son effet s'applique encore à la main). Le tour n'avance pas tant que la pile n'est pas vide. On peut toujours retirer une carte de la pile à la main (contresort) ;
  - glisser-déposer les cartes entre la main, le champ de bataille, le cimetière, l'exil, la bibliothèque, la zone de commandement et la pile ; déposer une carte sur le champ de bataille d'un autre joueur lui en donne le contrôle ;
  - **survol** : la carte s'agrandit à côté du curseur après une demi-seconde (et dans le panneau de droite) ;
  - **double-clic** : engager / dégager (sur le champ de bataille), jouer la carte (dans la main) ;
  - **jouer avec les règles** : double-clic sur une carte de ta main (ou sur ton commandant) pour **jouer le terrain** (un par tour, pendant ta phase principale) ou **lancer le sort**. Le coût est payé avec ta réserve, et le moteur engage tout seul les terrains qui manquent (en gardant de préférence les terrains polyvalents). Il vérifie le moment (rituel pendant ta phase principale pile vide, éphémère ou flash quand tu as la priorité), ajoute la taxe de commandant et demande la valeur de X. Pour une carte scindée ou modale, un menu propose chaque face. Le glisser-déposer reste libre pour tout ce que le moteur ne gère pas ;
  - **clic droit** sur une carte : marqueurs, face cachée, transformer, déplacer, donner le contrôle, révéler ;
  - **clic sur la bibliothèque** : piocher, mélanger, regarder ou révéler le dessus, meuler, exiler ;
  - points de vie, poison et blessures de commandant avec les boutons − / + (Maj+clic : ±5) ;
  - jetons (recherche Scryfall), dés, mulligan, journal de la partie et discussion ;
  - **mana** : double-clic sur un terrain (ou un permanent comme Sol Ring) pour l'engager et ajouter son mana à ta réserve, avec un menu quand il y a un choix (Command Tower, terrains doubles…). La réserve s'affiche à côté des points de vie : clic pour ajouter du mana à la main, clic droit pour en dépenser. Elle se vide à chaque changement d'étape. Une carte dont le moteur ne reconnaît pas le mana s'engage simplement ;
  - **mulligan** : après un mulligan payant, on clique sur les cartes à mettre au-dessous de sa bibliothèque puis sur **Garder cette main** ; la partie n'avance pas tant que ce n'est pas fait.
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
- **Archidekt** : colle le lien du deck (`https://archidekt.com/decks/…`, le deck doit être public), ou son export texte (**Export** → **Text**). Le commandant est la carte de la catégorie « Commander » ; les catégories hors du deck (Maybeboard, Sideboard) sont ignorées.

Ni l'un ni l'autre n'a d'API publique officielle, d'où le copier-coller.
