# Magic Trims

Une table de jeu **Magic: The Gathering Commander** pour jouer entre amis à distance, jusqu'à 5 joueurs en multijoueur libre, sous Windows.

Projet privé, entre amis. Les données et images des cartes viennent de [Scryfall](https://scryfall.com) ; les decks s'importent depuis [Moxfield](https://moxfield.com).

## Feuille de route

1. **Fondations et decks** : modèle de partie, système d'actions, import Moxfield + Scryfall. *(en cours)*
2. **Multijoueur** : chaque joueur peut héberger la partie depuis l'appli, sans serveur à payer.
3. **Table virtuelle jouable (v1)** : interface, glisser-déposer, installateur Windows.
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

Tous les réglages (points de vie, poison, partage entre coéquipiers…) restent modifiables par l'hôte. Pas retenus, faute de place à 5 joueurs : Empereur (6 joueurs) et Grande Mêlée (10 et plus).

`evaluateOutcome()` indique les joueurs éliminés (points de vie, poison, blessures de commandant, abandon) et les vainqueurs selon le mode.

## Organisation du code

```
packages/
  core/   Logique de jeu pure (aucune dépendance à l'interface ni au réseau)
```

### `@magic-trims/core`

- `types.ts` : l'état d'une partie (joueurs, zones, cartes, points de vie, blessures de commandant, poison…).
- `actions.ts` : la liste des actions possibles (piocher, déplacer une carte, engager, mulligan, passer le tour…).
- `reducer.ts` : `applyAction(état, { actorId, action })` valide une action et retourne le nouvel état. **Toute modification de la partie passe par là** : c'est ici que le moteur de règles viendra se brancher.
- `setup.ts` : `createGame()` met en place une partie (places selon le mode, commandants, mélange, mains de départ).
- `modes.ts` : les modes de jeu, les équipes et la détection des vainqueurs.
- `view.ts` : `viewFor(état, joueur)` donne ce qu'un joueur a le droit de voir (pas les mains adverses, pas l'ordre des bibliothèques). C'est ce que le serveur enverra à chaque client.
- `deck/` : lecture d'une liste Moxfield, résolution des cartes sur Scryfall (avec cache), vérification des règles de construction Commander.

## Développement

Il faut [Node.js](https://nodejs.org) 20 ou plus récent.

```sh
npm install
npm test           # tests
npm run typecheck  # vérification des types
```

## Importer un deck Moxfield

Sur la page du deck : **Export** → **Copy for Moxfield** (ou « Copy for MTGO / Arena »), puis coller le texte dans l'appli. Moxfield n'a pas d'API publique officielle, d'où le copier-coller.
