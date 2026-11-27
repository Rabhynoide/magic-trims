# Magic Trims

Une table de jeu **Magic: The Gathering Commander** pour jouer entre amis à distance, jusqu'à 5 joueurs en multijoueur libre, sous Windows.

Projet privé, entre amis. Les données et images des cartes viennent de [Scryfall](https://scryfall.com) ; les decks s'importent depuis [Moxfield](https://moxfield.com), [deckstats.net](https://deckstats.net) ou [Archidekt](https://archidekt.com).

## Feuille de route

1. **Fondations et decks** : modèle de partie, système d'actions, import Moxfield + Scryfall. *(fait)*
2. **Multijoueur** : chaque joueur peut héberger la partie depuis l'appli, sans serveur à payer. *(fait)*
3. **Table virtuelle jouable (v1)** : interface, glisser-déposer, installateur Windows. *(fait)*
4. **Moteur de règles** : tours et phases, mana, pile, puis effets des cartes courantes, petit à petit. *(en cours : tours et phases, priorité et pile, mana, terrains et sorts, combat, bot simple, actions d'état, effets courants des éphémères et rituels, capacités déclenchées, activées et statiques courantes, choix « peut » faits)* Le mode manuel reste toujours disponible pour ce que le moteur ne gère pas.

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

## Serveur central (facultatif)

Un petit serveur commun permet de **partager ses decks avec son groupe d'amis** (onglet « Communauté » de la liste des decks). Il est facultatif : sans lui, le jeu fonctionne exactement pareil. Il tourne gratuitement sur Cloudflare (Workers + Durable Objects, sans carte bancaire). Mise en ligne, comptes (code de groupe + pseudo) et essai local : voir [docs/serveur-central.md](docs/serveur-central.md).

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
- **Bots** : dans le salon, l'hôte peut ajouter un adversaire joué par l'ordinateur, avec un de ses decks (liste « Ajouter un bot avec le deck… »). Le bot joue un terrain par tour, lance ses permanents les plus chers qu'il peut payer (il n'applique pas encore les effets des cartes), attaque l'adversaire le plus faible quand c'est sans risque, bloque quand c'est rentable ou que les blessures seraient mortelles. Il tourne chez l'hôte ; on le retire avec « Exclure ». Quand il lance un sort, les autres joueurs passent la priorité comme d'habitude.
- **Salon** : chacun choisit son deck ; l'hôte choisit le mode, les équipes, les points de vie, Planechase, et s'il accepte les decks non légaux pour le mode.
- **Table** :
  - **tour et phases** : la barre au-dessus des boutons montre l'étape en cours. **Étape suivante** (ou Entrée) avance d'une étape ; un clic sur une étape plus loin y va directement ; **Finir le tour** passe au joueur suivant. Le dégagement au début du tour et la pioche à l'étape de pioche sont automatiques (pas de pioche au premier tour d'une partie à deux ni pour l'équipe qui commence en Géant à deux têtes), et le nettoyage rappelle s'il faut défausser au-delà de 7 cartes. L'hôte peut couper ces automatismes dans le salon ;
  - **pile et priorité** : quand une carte arrive sur la pile, son lanceur reçoit la priorité, puis chacun **passe la priorité** à son tour (bouton ou Entrée) ou répond avec une autre carte. Quand tout le monde a passé d'affilée, le dessus de la pile se résout : un permanent arrive sur le champ de bataille, un éphémère ou un rituel va au cimetière (son effet s'applique encore à la main). Le tour n'avance pas tant que la pile n'est pas vide. On peut toujours retirer une carte de la pile à la main (contresort) ;
  - **répondre pendant le tour des autres** : avant que le joueur actif quitte une étape clé (entretien, pioche, début du combat, attaquants, bloqueurs, fin du tour), chaque autre joueur reçoit la priorité à son tour et peut lancer un éphémère ou une carte à flash, ou **passer** (bouton ou Entrée). Le tour avance quand tout le monde a passé ; une réponse va sur la pile et le joueur actif reprend la main après sa résolution. Le menu **Arrêts** choisit à l'avance les étapes où l'on s'arrête : le moteur ne regarde jamais ta main pour décider, les autres ne peuvent donc pas deviner si tu as un éphémère. Les bots ne s'arrêtent jamais ;
  - **effets des sorts** : pour un éphémère ou un rituel, le moteur lit le texte de la carte et applique les formules courantes à la résolution : piocher, détruire ou exiler une cible ou tout un type de permanents, renvoyer en main, infliger des blessures, gagner ou perdre des points de vie, créer des jetons créature, contrer un sort, ajouter du mana. Au lancement, un bandeau demande les cibles : clic sur une carte, ou sur **Cibler** à côté d'un joueur (Échap pour annuler). Un sort dont toutes les cibles ont disparu ne fait rien. Ce que le moteur ne comprend pas est rappelé dans le journal (« À appliquer à la main… ») ;
  - **capacités déclenchées** : les capacités courantes des permanents se déclenchent seules et vont sur la pile, dans l'ordre du tour à partir du joueur actif : « quand ~ arrive », « quand ~ (ou une autre créature) meurt », « à chaque fois qu'un joueur pioche », « gagne ou perd des PV », « joue un terrain », « au début de l'entretien, de l'étape de pioche ou de l'étape de fin » (par exemple Sheoldred, Blood Artist, Sanguine Bond, Exquisite Blood, Phyrexian Arena, Howling Mine). Elles se résolvent comme un sort, quand tout le monde a passé. Quand il faut choisir une cible parmi plusieurs, le bandeau de ciblage s'ouvre chez le contrôleur, et la partie attend son choix. Le tour s'arrête à l'étape où des capacités se déclenchent. Une capacité que le moteur ne comprend pas entièrement ne se déclenche pas : la carte garde sa pastille. Les déclencheurs « quand tu lances un sort », « quand ~ attaque ou bloque » et l'exploitation sont aussi reconnus. Les changements de PV faits à la main avec − / + ne déclenchent rien (ce sont des corrections). Au plus 50 capacités se déclenchent par action, pour éviter une boucle sans fin ;
  - **cartes non gérées** : une pastille sur la carte signale ce que le moteur ne fait pas (« ½ » : en partie, « main » : rien) ; survole-la pour voir ce qui reste à faire. Quand une carte est agrandie (survol), un encart à côté d'elle liste chacune de ses capacités avec ✓ (automatique), ½ (en partie) ou ✋ (à la main), comme les encarts de mots-clés d'Arena. Au salon, sous « Mon deck », un bilan indique combien de cartes du deck sont automatiques.;
  - **capacités activées** : clic droit sur un de tes permanents (ou sur une carte de ton cimetière, comme Clattering Augur) puis **Activer…**. Le moteur paie le coût (mana avec engagement automatique des terrains, {T}, points de vie, sacrifice, loyauté d'un planeswalker), demande les cibles et la créature à sacrifier, puis met la capacité sur la pile. **Équiper** et les capacités de loyauté se font à la vitesse d'un rituel (une capacité de loyauté par tour). Une capacité de mana (Blood Celebrant) ne passe pas par la pile et demande la couleur. Si l'effet n'est compris qu'en partie (Expedition Map), le reste est rappelé dans le journal ;
  - **choix « peut »** : une capacité « you may… » s'arrête à sa résolution sur un bandeau **Oui / Non** chez son contrôleur (la partie attend sa réponse). L'exploitation demande la créature à sacrifier ;
  - **auras** : lancer une aura demande ce qu'elle enchante ; elle arrive attachée (ou va au cimetière si la cible a disparu) ;
  - **coût alternatif** : un sort comme Baleful Mastery a une seconde entrée « Lancer … pour {1}{B} » ;
  - **modes** : un sort ou une capacité « Choose one or more — » ouvre, à sa résolution, une fenêtre avec une case par mode (modes sans cible pour l'instant) ;
  - **fenêtre de choix** : chercher dans sa bibliothèque, choisir la carte qu'un adversaire défausse après avoir révélé sa main, ou cibler une carte d'un cimetière se fait dans une même fenêtre qui montre les cartes possibles ;
  - **sagas** : un marqueur de savoir à l'arrivée puis au début de chaque première phase principale, chaque chapitre se déclenche, et la saga est sacrifiée après le dernier ; la lecture anticipée demande le chapitre de départ ;
  - **jetons prédéfinis** : Trésor, Nourriture, Indice, Sang ;
  - **sacrifices obligatoires** : « sacrifie un artefact » ouvre la fenêtre de choix quand il y a plusieurs possibilités (« si tu ne peux pas… » s'applique sinon, comme pour Rust Elemental) ;
  - **auras qui transforment** : Darksteel Mutation et Witness Protection donnent d'autres caractéristiques à la créature enchantée, qui les perd quand l'aura part ; les auras « Enchant player » enchantent un joueur (Paradox Haze, avec une étape d'entretien supplémentaire) ;
  - **cibles facultatives et retours différés** : « jusqu'à une cible » propose « Sans cible » ; une carte exilée par The Eternal Wanderer revient au début de la prochaine étape de fin de son propriétaire ;
  - **regard** : un sort ou une capacité qui commence par « Scry N » (Read the Bones) montre à son contrôleur les cartes du dessus de sa bibliothèque ; il les range au-dessus (dans l'ordre voulu) ou au-dessous, puis la résolution continue ;
  - **effets statiques** : mots-clés et bonus donnés par un équipement, une aura ou à « tes créatures » (Lightning Greaves, Darksteel Plate), réductions de coût (Jet Medallion, Bontu's Monument), « pas de taille maximale de main », « tes adversaires ne peuvent pas gagner de PV », « ne peut pas bloquer », force et endurance égales à la taille de la main (Psychosis Crawler) ;
  - **sorts avec coût supplémentaire** : « sacrifie une créature » (Village Rites) est demandé au lancement ;
  - **dons et échanges de contrôle** : « l'adversaire ciblé gagne le contrôle de… » (Zedruu, Harmless Offering, Bazaar Trader, Humble Defector, Akroan Horse) et « échange le contrôle de… » (Political Trickery, Vedalken Plotter). Zedruu compte les permanents que tu possèdes chez les adversaires ;
  - **prison et restrictions** : les taxes d'attaque (Ghostly Prison, Propaganda, Windborn Muse, Sphere of Safety) sont payées d'office à la déclaration des attaquants, en engageant des terrains au besoin ; « tu ne peux pas lancer de sorts de créature » (Steel Golem, Grid Monitor), « un seul sort par tour » (Moderation), « tu ne peux pas jouer de terrains » (Aggressive Mining) sont vérifiés. Les terrains qui « arrivent engagés » le font seuls. « Quand ~ quitte le champ de bataille », « tu gagnes la partie » (Felidar Sovereign, Triskaidekaphile) et « tu perds la partie » sont gérés ;
  - **actions d'état** : le moteur vérifie après chaque action ce que les règles font automatiquement. Une créature avec des blessures mortelles ou une endurance de 0 meurt (sauf si son endurance n'est pas un nombre, comme « * »). Un joueur à 0 PV, à 10 poisons, à 21 blessures d'un même commandant ou qui pioche dans une bibliothèque vide perd la partie : ses cartes quittent la table et les cartes qu'il contrôlait retournent à leur propriétaire. Un planeswalker arrive avec ses marqueurs de loyauté et meurt à 0, une aura tombe quand sa cible part, les marqueurs +1/+1 et -1/-1 s'annulent, la règle des légendes garde le plus récent, et un commandant mis au cimetière ou en exil retourne dans la zone de commandement. Seules les blessures mortelles restent actives quand l'hôte désactive les vérifications ;
  - glisser-déposer les cartes entre la main, le champ de bataille, le cimetière, l'exil, la bibliothèque, la zone de commandement et la pile ; déposer une carte sur le champ de bataille d'un autre joueur lui en donne le contrôle ;
  - **survol** : la carte s'agrandit à côté du curseur après une demi-seconde (et dans le panneau de droite) ;
  - **double-clic** : engager / dégager (sur le champ de bataille), jouer la carte (dans la main) ;
  - **jouer avec les règles** : double-clic sur une carte de ta main (ou sur ton commandant) pour **jouer le terrain** (un par tour, pendant ta phase principale) ou **lancer le sort**. Le coût est payé avec ta réserve, et le moteur engage tout seul les terrains qui manquent (en gardant de préférence les terrains polyvalents). Il vérifie le moment (rituel pendant ta phase principale pile vide, éphémère ou flash quand tu as la priorité), ajoute la taxe de commandant et demande la valeur de X. Pour une carte scindée ou modale, un menu propose chaque face. Glisser une carte de sa main sur son champ de bataille ou sur la pile revient à la jouer, avec les mêmes vérifications : un terrain pendant l'entretien est refusé. Pour un effet que le moteur ne connaît pas (« mets un terrain de ta main sur le champ de bataille »), le menu de la carte propose « Sur le champ de bataille (effet, sans payer) ». L'hôte peut désactiver ces vérifications dans le salon ;
  - **clic droit** sur une carte : marqueurs, face cachée, transformer, déplacer, donner le contrôle, révéler ;
  - **clic sur la bibliothèque** : piocher, mélanger, regarder ou révéler le dessus, meuler, exiler ;
  - points de vie, poison et blessures de commandant avec les boutons − / + (Maj+clic : ±5) ;
  - jetons (recherche Scryfall), dés, mulligan, journal de la partie et discussion ;
  - **mana** : double-clic sur un terrain (ou un permanent comme Sol Ring) pour l'engager et ajouter son mana à ta réserve, avec un menu quand il y a un choix (Command Tower, terrains doubles…). La réserve s'affiche à côté des points de vie : clic pour ajouter du mana à la main, clic droit pour en dépenser. Elle se vide à chaque changement d'étape. Une carte dont le moteur ne reconnaît pas le mana s'engage simplement ;
  - **combat** : à l'étape des attaquants, choisis la cible et clique sur tes créatures, puis **Attaquer** (ou **Pas d'attaque**). Les joueurs attaqués cliquent sur une de leurs créatures puis sur l'attaquant à bloquer, puis **Bloquer** (ou **Pas de blocage**) ; le tour attend leurs blocages. Sans créature capable d'attaquer, la déclaration se fait toute seule et le tour va à la seconde phase principale ; un joueur attaqué sans créature capable de bloquer n'a rien à déclarer. Les blessures sont infligées automatiquement (blessures de commandant comprises) et les créatures mortes vont au cimetière. Mots-clés gérés : vol, portée, vigilance, célérité, initiative, double initiative, contact mortel, lien de vie, piétinement, menace, infection, flétrissure, défenseur, indestructible. Le mal d'invocation est vérifié. La force et l'endurance s'affichent sur les créatures ; le menu propose un **bonus jusqu'à la fin du tour** pour les effets du type Croissance gigantesque ;
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
