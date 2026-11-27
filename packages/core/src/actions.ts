import type { ManaType } from "./mana.js";
import type { TurnStep } from "./turn.js";
import type { Target } from "./effects.js";
import type { CardData, CardInstanceId, PlayerId, PriorityStops, Zone } from "./types.js";

/**
 * Toutes les modifications d'une partie passent par une action.
 *
 * C'est le point d'entrée unique de la logique de jeu : le serveur reçoit des
 * actions, les valide, les applique et diffuse le résultat. Un moteur de règles
 * pourra plus tard s'insérer ici (valider, refuser, déclencher des effets)
 * sans toucher à l'interface.
 */
export type GameAction =
  // Bibliothèque et main
  | { type: "draw"; count: number }
  | { type: "shuffleLibrary" }
  | { type: "mulligan" }
  /** Après un mulligan : met les cartes choisies de la main au-dessous de la bibliothèque (dans cet ordre). */
  | { type: "bottomMulligan"; cardIds: CardInstanceId[] }
  /** Étape de nettoyage : défausse les cartes choisies pour revenir à la taille maximale de main (règle 514.1). */
  | { type: "discardToHandSize"; cardIds: CardInstanceId[] }
  /** Déplace les N cartes du dessus de la bibliothèque (meule, exil…). */
  | { type: "moveTopOfLibrary"; count: number; to: Zone; faceDown?: boolean }
  /** Regarde les N cartes du dessus (regard, surveillance…). */
  | { type: "lookAtLibraryTop"; count: number }
  /** Révèle les N cartes du dessus à toute la table. */
  | { type: "revealLibraryTop"; count: number }
  // Cartes
  | {
      type: "moveCard";
      cardId: CardInstanceId;
      to: Zone;
      /**
       * Pour le champ de bataille : le joueur qui en prend le contrôle
       * (par défaut le propriétaire). Ignoré pour les autres zones, où une
       * carte va toujours chez son propriétaire.
       */
      controllerId?: PlayerId;
      /** "top" (par défaut), "bottom" ou un index (0 = dessus). */
      position?: "top" | "bottom" | number;
      tapped?: boolean;
      faceDown?: boolean;
      /**
       * Contourne les règles (effet qui met une carte en jeu, coût alternatif…) :
       * sans lui, une carte de sa main ou de sa zone de commandement ne va
       * pas directement sur le champ de bataille ou la pile.
       */
      force?: boolean;
    }
  | { type: "setTapped"; cardIds: CardInstanceId[]; tapped: boolean }
  /** Dégage tous les permanents de l'acteur. */
  | { type: "untapAll" }
  /**
   * Engage un permanent pour son mana. `choice` : index du choix dans
   * `manaOptions` quand la carte peut produire plusieurs sortes de mana.
   */
  | { type: "tapForMana"; cardId: CardInstanceId; choice?: number }
  /**
   * Joue un terrain depuis la main (un par tour, pendant sa phase principale,
   * pile vide). `face` : 1 pour jouer le verso d'une carte modale.
   */
  /** `chosenType` : « As ~ enters, choose a creature type » (Secluded Courtyard). */
  /** `untap` : révéler la carte ou payer les PV demandés pour que le terrain arrive dégagé. */
  | { type: "playLand"; cardId: CardInstanceId; face?: number; chosenType?: string; untap?: boolean }
  /**
   * Lance un sort depuis la main (ou son commandant depuis la zone de
   * commandement) en payant son coût avec la réserve ; les terrains qui
   * manquent sont engagés automatiquement. `face` : la moitié lancée (cartes
   * scindées ou modales), `x` : la valeur de X.
   */
  | {
      type: "castSpell";
      cardId: CardInstanceId;
      face?: number;
      x?: number;
      targets?: Target[];
      /** Le permanent sacrifié pour un coût supplémentaire (« As an additional cost… sacrifice a creature »). */
      sacrifice?: CardInstanceId;
      /** Saga avec lecture anticipée (« Read ahead ») : le chapitre de départ. */
      chapter?: number;
      /** Payer le coût alternatif du sort (« You may pay {1}{B} rather than pay this spell's mana cost »). */
      alternative?: boolean;
      /** Lancer pour son coût d'évocation : `true` celui de la carte, `"granted"` celui donné par un permanent (Ashling). */
      evoke?: boolean | "granted";
      /** Évocation « Exile a green card from your hand » : la carte exilée. */
      evokeExile?: CardInstanceId;
      /** « As ~ enters, choose a creature type » : le type choisi (Herald's Horn, Morophon). */
      chosenType?: string;
      /** Sort modal dont des modes ont des cibles : les modes choisis (les cibles suivent dans `targets`). */
      modes?: number[];
    }
  /** Présage : payer {2} pendant son tour pour exiler la carte de sa main face cachée. */
  | { type: "foretell"; cardId: CardInstanceId }
  /**
   * Active la capacité n° `index` (parmi les capacités activées reconnues de
   * la face visible) d'un permanent, ou d'une carte de son cimetière.
   */
  | {
      type: "activateAbility";
      cardId: CardInstanceId;
      index: number;
      targets?: Target[];
      /** Le permanent sacrifié pour le coût (« Sacrifice a creature »). */
      sacrifice?: CardInstanceId;
      /** La couleur pour « Add one mana of any color ». */
      color?: ManaType;
    }
  /** Répond à une capacité facultative (« you may ») sur la pile ; `choice` : le permanent choisi (sacrifice). */
  /** `x` : la valeur payée pour « you may pay {X} » (Well of Lost Dreams). */
  | { type: "decideOptional"; cardId: CardInstanceId; accept: boolean; choice?: CardInstanceId; x?: number }
  /** Les cartes choisies dans la fenêtre de choix (recherche, main révélée). */
  | { type: "chooseCards"; cardId: CardInstanceId; cardIds: CardInstanceId[] }
  /** Les modes choisis d'un sort ou d'une capacité modale (index dans l'ordre imprimé). */
  | { type: "chooseModes"; cardId: CardInstanceId; modes: number[] }
  /** Regard : les cartes gardées au-dessus (dans l'ordre, la première en haut) et celles mises au-dessous. */
  | { type: "scry"; cardId: CardInstanceId; top: CardInstanceId[]; bottom: CardInstanceId[] }
  /** Choisit les cibles d'une capacité déclenchée qu'on contrôle, sur la pile. */
  | { type: "chooseTargets"; cardId: CardInstanceId; targets: Target[] }
  /** Déclare les attaquants (étape des attaquants), chacun vers un joueur adverse. Une liste vide : pas d'attaque. */
  | { type: "declareAttackers"; attackers: { cardId: CardInstanceId; defender: PlayerId }[] }
  /** Déclare ses bloqueurs (étape des bloqueurs), chacun contre un attaquant. Une liste vide : pas de blocage. */
  | { type: "declareBlockers"; blocks: { cardId: CardInstanceId; attackerId: CardInstanceId }[] }
  /** Bonus de force/endurance jusqu'à la fin du tour, à la main (Croissance gigantesque…). */
  | { type: "boostCreature"; cardId: CardInstanceId; power: number; toughness: number }
  /** Ajoute (ou retire, si négatif) du mana dans la réserve de l'acteur, à la main. */
  | { type: "adjustMana"; mana: ManaType; delta: number }
  | { type: "setFaceDown"; cardId: CardInstanceId; faceDown: boolean }
  /** Passe à la face suivante d'une carte double face. */
  | { type: "transform"; cardId: CardInstanceId }
  | { type: "adjustCardCounter"; cardId: CardInstanceId; kind: string; delta: number }
  | { type: "attach"; cardId: CardInstanceId; targetId: CardInstanceId | null }
  | { type: "changeControl"; cardId: CardInstanceId; controllerId: PlayerId }
  | { type: "revealCards"; cardIds: CardInstanceId[]; to: PlayerId[] | "all" }
  | { type: "createToken"; card: CardData; count?: number; tapped?: boolean }
  // Joueurs
  | { type: "adjustLife"; playerId: PlayerId; delta: number }
  | { type: "adjustPoison"; playerId: PlayerId; delta: number }
  | {
      type: "adjustCommanderDamage";
      playerId: PlayerId;
      commanderId: CardInstanceId;
      delta: number;
      /** Retire aussi les points de vie (vrai par défaut). */
      affectLife?: boolean;
    }
  | { type: "adjustPlayerCounter"; playerId: PlayerId; kind: string; delta: number }
  // Tour et table
  /**
   * Passe à l'étape suivante du tour, ou jusqu'à l'étape `to` (plus loin dans
   * le même tour) en faisant les actions obligatoires des étapes traversées.
   */
  | { type: "nextStep"; to?: TurnStep }
  /**
   * Passe la priorité. Pile non vide : quand tous les joueurs ont passé
   * d'affilée, l'objet du dessus de la pile se résout. Pile vide (le joueur
   * actif veut avancer) : quand tous ont passé, le tour avance.
   */
  | { type: "passPriority" }
  /** Choisit les étapes du tour des autres où s'arrêter pour pouvoir répondre. */
  | { type: "setPriorityStops"; stops: PriorityStops }
  /** Finit le tour (étapes restantes comprises) et donne la main au joueur suivant. */
  | { type: "passTurn" }
  | { type: "rollDie"; sides: number }
  // Variantes
  /** Archenemy : met en marche la machination du dessus. */
  | { type: "setSchemeInMotion" }
  /** Planechase : change de plan. */
  | { type: "planeswalk" }
  /** Planechase : lance le dé planaire (planeswalk, chaos ou rien). */
  | { type: "rollPlanarDie" }
  | { type: "concede" };

export interface ActionEnvelope {
  /** Le joueur qui fait l'action. */
  actorId: PlayerId;
  action: GameAction;
}

export type ActionType = GameAction["type"];
