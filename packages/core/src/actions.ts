import type { TurnStep } from "./turn.js";
import type { CardData, CardInstanceId, PlayerId, Zone } from "./types.js";

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
    }
  | { type: "setTapped"; cardIds: CardInstanceId[]; tapped: boolean }
  /** Dégage tous les permanents de l'acteur. */
  | { type: "untapAll" }
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
   * Passe la priorité (pile non vide). Quand tous les joueurs ont passé
   * d'affilée, l'objet du dessus de la pile se résout.
   */
  | { type: "passPriority" }
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
