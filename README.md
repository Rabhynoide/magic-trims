# Magic Trims

Une table de jeu **Magic: The Gathering Commander** pour jouer entre amis à distance, jusqu'à 5 joueurs en multijoueur libre, sous Windows.

Projet privé, entre amis. Les données et images des cartes viennent de [Scryfall](https://scryfall.com) ; les decks s'importent depuis [Moxfield](https://moxfield.com).

## Feuille de route

1. **Fondations et decks** : modèle de partie, système d'actions, import Moxfield + Scryfall. *(en cours)*
2. **Multijoueur** : chaque joueur peut héberger la partie depuis l'appli, sans serveur à payer.
3. **Table virtuelle jouable (v1)** : interface, glisser-déposer, installateur Windows.
4. **Moteur de règles** : tours et phases, mana, pile, puis effets des cartes courantes, petit à petit.

## Organisation du code

```
packages/
  core/   Logique de jeu pure (aucune dépendance à l'interface ni au réseau)
```

### `@magic-trims/core`

- `types.ts` : l'état d'une partie (joueurs, zones, cartes, points de vie, blessures de commandant, poison…).
- `actions.ts` : la liste des actions possibles (piocher, déplacer une carte, engager, mulligan, passer le tour…).
- `reducer.ts` : `applyAction(état, { actorId, action })` valide une action et retourne le nouvel état. **Toute modification de la partie passe par là** : c'est ici que le moteur de règles viendra se brancher.
- `setup.ts` : `createGame()` met en place une partie (commandants, mélange, mains de départ).
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
