/**
 * Données et état d'une partie de Commander.
 *
 * L'état est un objet JSON simple (sérialisable tel quel) : il peut être
 * envoyé sur le réseau, sauvegardé sur disque et rejoué.
 */

import type { ManaPool } from "./mana.js";
import type { TurnStep } from "./turn.js";

/** Données d'une carte, issues de Scryfall (sous-ensemble utile au jeu). */
export interface CardData {
  /** Identifiant Scryfall de l'impression. */
  id: string;
  /** Identifiant Oracle (identique pour toutes les impressions d'une carte). */
  oracleId: string;
  name: string;
  /** Nom imprimé dans la langue de l'impression, si différent. */
  printedName?: string;
  manaCost: string;
  manaValue: number;
  typeLine: string;
  oracleText: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors: string[];
  colorIdentity: string[];
  keywords: string[];
  /** Légalité en Commander d'après Scryfall ("legal", "banned", "not_legal"…). */
  commanderLegality: string;
  /** Légalité en Duel Commander (liste de bannies différente). */
  duelLegality?: string;
  set: string;
  collectorNumber: string;
  image?: CardImages;
  /** Faces des cartes double face, scindées, à aventure… */
  faces?: CardFace[];
  /**
   * Traduction choisie par le joueur qui regarde (ajoutée par son appli,
   * jamais envoyée par l'hôte). Les champs anglais restent la référence.
   */
  localized?: LocalizedCard;
}

export interface CardFace {
  name: string;
  manaCost: string;
  typeLine: string;
  oracleText: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  image?: CardImages;
}

export interface CardImages {
  small: string;
  normal: string;
  large: string;
  artCrop?: string;
}

/**
 * Langues dans lesquelles Scryfall propose des cartes imprimées.
 * Le code est celui de Scryfall (« lang:fr »).
 */
export const CARD_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "ru", label: "Русский" },
  { code: "zhs", label: "简体中文" },
  { code: "zht", label: "繁體中文" },
] as const;

export type CardLanguage = (typeof CARD_LANGUAGES)[number]["code"];

/** Texte et images d'une carte imprimée dans une autre langue. */
export interface LocalizedCard {
  lang: string;
  name: string;
  typeLine?: string;
  oracleText?: string;
  image?: CardImages;
  faces?: { name: string; typeLine?: string; oracleText?: string; image?: CardImages }[];
}

export type PlayerId = string;
export type CardInstanceId = string;

/** Zones propres à chaque joueur. */
export const PLAYER_ZONES = [
  "library",
  "hand",
  "battlefield",
  "graveyard",
  "exile",
  "command",
  /** Pioche de machinations de l'archenemy (variante Archenemy). */
  "schemes",
] as const;
export type PlayerZone = (typeof PLAYER_ZONES)[number];

/** Zones partagées par toute la table. */
export const SHARED_ZONES = [
  "stack",
  /** Pioche de plans (variante Planechase). */
  "planarDeck",
  /** Plan(s) actif(s) (variante Planechase). */
  "plane",
] as const;
export type SharedZone = (typeof SHARED_ZONES)[number];

export type Zone = PlayerZone | SharedZone;

/**
 * Zones cachées dont l'ordre compte (comme une bibliothèque) : le dessus est
 * l'index 0 et une carte qui y entre devient un nouvel objet inconnu.
 */
export const HIDDEN_ORDERED_ZONES: ReadonlySet<Zone> = new Set<Zone>(["library", "schemes", "planarDeck"]);

/** Zones dont le contenu est visible par tous les joueurs. */
export const PUBLIC_ZONES: ReadonlySet<Zone> = new Set<Zone>([
  "battlefield",
  "graveyard",
  "exile",
  "command",
  "stack",
  "plane",
]);

/** Un exemplaire physique d'une carte dans la partie. */
export interface CardInstance {
  instanceId: CardInstanceId;
  /** Référence vers `GameState.cardData`. */
  cardId: string;
  ownerId: PlayerId;
  controllerId: PlayerId;
  /** Zone actuelle (redondant avec les listes de zones, pratique pour l'interface). */
  zone: Zone;
  tapped: boolean;
  faceDown: boolean;
  /** Index de la face visible pour les cartes double face (0 = recto). */
  faceIndex: number;
  counters: Record<string, number>;
  isToken: boolean;
  isCommander: boolean;
  /** Carte à laquelle celle-ci est attachée (aura, équipement). */
  attachedTo?: CardInstanceId;
  /** Joueurs qui ont vu cette carte alors qu'elle était cachée (révélée). */
  revealedTo: PlayerId[];
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  life: number;
  poison: number;
  /** Blessures reçues de chaque commandant adverse (clé : instanceId du commandant). */
  commanderDamage: Record<CardInstanceId, number>;
  /** Autres marqueurs de joueur (énergie, expérience…). */
  counters: Record<string, number>;
  zones: Record<PlayerZone, CardInstanceId[]>;
  /** Nombre de fois où chaque commandant a été lancé depuis la zone de commandement. */
  commanderCasts: Record<CardInstanceId, number>;
  /** Mulligans pris pendant la mise en place. */
  mulligans: number;
  /**
   * Cartes que le joueur doit encore mettre au-dessous de sa bibliothèque
   * après ses mulligans (règle 103.5) : la partie n'avance pas avant.
   */
  mulliganBottom: number;
  /** Terrains joués ce tour (un seul par tour, règle 305.2). */
  landsPlayed: number;
  /** Réserve de mana ; elle se vide à la fin de chaque étape (règle 500.4). */
  manaPool: ManaPool;
  hasConceded: boolean;
}

export interface LogEntry {
  seq: number;
  actorId: PlayerId | null;
  /** Texte en français, déjà expurgé des informations cachées. */
  message: string;
}

export type GameModeType = "freeForAll" | "duel" | "teams" | "twoHeadedGiant" | "star" | "archenemy";

export interface GameSettings {
  mode: GameModeType;
  startingLife: number;
  /** Points de vie de départ de l'archenemy (mode Archenemy). */
  archenemyLife: number;
  /** Blessures de commandant mortelles. */
  commanderDamageLimit: number;
  poisonLimit: number;
  /** Le premier mulligan est gratuit en Commander multijoueur. */
  freeFirstMulligan: boolean;
  /** Les coéquipiers partagent points de vie, poison et blessures de commandant (Géant à deux têtes). */
  sharedTeamLife: boolean;
  /** Les coéquipiers jouent leur tour en même temps (Géant à deux têtes, Archenemy). */
  sharedTurns: boolean;
  /** Les coéquipiers voient la main les uns des autres. */
  teammatesSeeHands: boolean;
  /** Variante Planechase : pioche de plans partagée et dé planaire. */
  planechase: boolean;
  /**
   * Le moteur fait les actions obligatoires du tour : dégager les permanents
   * au début du tour, piocher à l'étape de pioche, rappeler la taille maximale
   * de main au nettoyage.
   */
  autoTurnActions: boolean;
}

export interface PriorityState {
  /** Le joueur qui a la priorité (en tours partagés : un membre de l'équipe, qui la tient pour tous). */
  playerId: PlayerId;
  /** Joueurs ayant passé la priorité d'affilée depuis le dernier changement de la pile. */
  passed: PlayerId[];
}

export interface GameState {
  id: string;
  /** Incrémenté à chaque action appliquée. */
  version: number;
  settings: GameSettings;
  /** Ordre du tour. */
  turnOrder: PlayerId[];
  players: Record<PlayerId, PlayerState>;
  cards: Record<CardInstanceId, CardInstance>;
  /** Données Scryfall des cartes présentes, indexées par `CardData.id`. */
  cardData: Record<string, CardData>;
  /**
   * Équipes. En chacun pour soi, chaque joueur est seul dans son équipe.
   * L'ordre des joueurs à l'intérieur d'une équipe suit l'ordre du tour.
   */
  teams: PlayerId[][];
  /** Le joueur archenemy (mode Archenemy). */
  archenemyId?: PlayerId;
  /** La pile : le dernier élément est le dessus. */
  stack: CardInstanceId[];
  /**
   * Priorité, tant que la pile n'est pas vide (`null` sinon : le joueur actif
   * avance alors librement dans le tour).
   */
  priority: PriorityState | null;
  planarDeck: CardInstanceId[];
  plane: CardInstanceId[];
  turn: {
    number: number;
    /** Joueur actif (en tours partagés : le premier joueur actif de l'équipe). */
    activePlayerId: PlayerId;
    /** Étape en cours du tour. */
    step: TurnStep;
    /** Jets de dé planaire déjà faits ce tour (le suivant coûte autant de mana générique). */
    planarDieRolls: number;
  };
  /** État du générateur aléatoire (mélanges), pour des parties rejouables. */
  rngState: number;
  log: LogEntry[];
}
