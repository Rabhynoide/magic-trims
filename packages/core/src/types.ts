/**
 * Données et état d'une partie de Commander.
 *
 * L'état est un objet JSON simple (sérialisable tel quel) : il peut être
 * envoyé sur le réseau, sauvegardé sur disque et rejoué.
 */

import type { CombatState } from "./combat.js";
import type { Target } from "./effects.js";
import type { TriggerEvent } from "./triggers.js";
import type { ManaPool, ManaType } from "./mana.js";
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

/** Ce qu'on retient d'un sort lancé, pour les déclencheurs « Whenever you cast a … spell ». */
export interface CastRecord {
  /** L'objet sur la pile. */
  cardId: CardInstanceId;
  typeLine: string;
  /** Couleurs du sort (de la face lancée). */
  colors: string[];
  manaValue: number;
  fromHand: boolean;
  /** « with {X} in its mana cost ». */
  hasX: boolean;
  /** Changelin : un sort de chaque type de créature (« Whenever you cast an Elemental spell »). */
  changeling?: boolean;
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
  /**
   * Permanents mis hors phase (règle 702.26) : ils restent les mêmes objets (marqueurs,
   * engagement, attachements) mais sont traités comme s'ils n'existaient pas. Ils sont
   * rangés chez leur contrôleur et reviennent avant son dégagement.
   */
  "phasedOut",
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
  "phasedOut",
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
  /** Aura qui enchante un joueur (Paradox Haze). */
  attachedPlayer?: PlayerId;
  /** Carte d'origine quand une aura la transforme (Darksteel Mutation, Witness Protection). */
  originalCardId?: string;
  /** Sa vraie carte quand elle est arrivée en copie d'une autre (Clone, Sakashima) : `cardId` pointe alors vers la copie. */
  copyBaseId?: string;
  /** Joueurs qui ont vu cette carte alors qu'elle était cachée (révélée). */
  revealedTo: PlayerId[];
  /** Arrivée (ou changée de contrôleur) depuis le début du dernier tour de son contrôleur : mal d'invocation. */
  summoningSick?: boolean;
  /** Blessures reçues ce tour (retirées au nettoyage). */
  damage?: number;
  /** Blessée par une source avec contact mortel ce tour. */
  deathtouched?: boolean;
  /** Planeswalker arrivé avec ses marqueurs de loyauté : il meurt quand il n'en a plus. */
  hasLoyalty?: boolean;
  /** Bonus de force et d'endurance jusqu'à la fin du tour (+3/+3 d'une Croissance gigantesque…). */
  ptBoost?: { power: number; toughness: number };
  /** Contrôle pris « until end of turn » (Dihada −11, Threaten) : le joueur qui le récupère au nettoyage. */
  controlReturnsTo?: PlayerId;
  /** Mots-clés gagnés jusqu'à la fin du tour (en minuscules : « lifelink »…). */
  grants?: string[];
  /** Mots-clés gagnés « until your next turn » : ils durent jusqu'au début du prochain tour de `playerId`. */
  grantsUntil?: { playerId: PlayerId; keywords: string[] }[];
  /** Capacités activées « une fois par tour » déjà utilisées (loyauté comprise) : le tour et leurs index. */
  usedAbilities?: { turn: number; indices: number[] };
  /** Capacités déclenchées données jusqu'à la fin du tour (texte « When ~ dies, … »). */
  grantedTriggers?: string[];
  /** Choix de cartes en attente à la résolution (recherche, main révélée) : effet n° `index`. */
  /** `perPlayer` : une carte au plus par joueur (contrôleur) — The Eternal Wanderer. */
  cardChoice?: { index: number; options: CardInstanceId[]; min: number; max: number; label: string; playerId?: PlayerId; perPlayer?: boolean };
  /** Cartes choisies pour chaque effet (par son index). */
  choices?: Record<number, CardInstanceId[]>;
  /** Sort ou capacité modale sur la pile : les modes choisis (absents tant que le contrôleur n'a pas choisi). */
  modes?: { chosen?: number[] };
  /** Akroma's Will : son lanceur contrôlait un commandant en le lançant. */
  castWithCommander?: boolean;
  /** Saga avec lecture anticipée : le chapitre de départ choisi en la lançant. */
  chapter?: number;
  /** Sort lancé pour son coût alternatif (Baleful Mastery). */
  alternative?: boolean;
  /** Lancé depuis la main (Approach of the Second Sun). */
  castFromHand?: boolean;
  /**
   * Peut être lancée depuis l'exil (rebond, cascade) : sans payer son coût si `free`,
   * pendant ce tour (et cette étape si `step`), ou tant que le sort `whileOnStack` est sur la pile.
   */
  castPermission?: {
    free: boolean;
    turn: number;
    step?: TurnStep;
    ignoreTiming?: boolean;
    whileOnStack?: CardInstanceId;
    reason: string;
    /** Les terrains aussi peuvent être joués ainsi (« You may play this card from your graveyard », Kethis). */
    lands?: boolean;
    /** Le joueur qui peut la lancer, s'il n'est pas son propriétaire (Etali). */
    caster?: PlayerId;
    /** Présage : à lancer pour ce coût à un tour ultérieur à `turn` (sans limite de durée). */
    foretell?: string;
  };
  /** Lancé depuis l'exil après avoir été présagé (« If this spell was foretold »). */
  foretold?: boolean;
  /** Palace Jailer : exilée jusqu'à ce qu'un adversaire de ce joueur devienne le monarque. */
  exiledUntilMonarch?: PlayerId;
  /** Hors phase avec le permanent auquel elle est attachée (règle 702.26g) : revient avec lui, pas seule. */
  phasedOutIndirectly?: boolean;
  /** Provoquée par ces joueurs (jusqu'à leur prochain tour) : doit attaquer, et un autre joueur si possible. */
  goadedBy?: PlayerId[];
  /** Cavalier of Gales : la pioche qui précède le choix des cartes à remettre est faite. */
  drewFirst?: boolean;
  /** Rebond : exilée en se résolvant, lançable gratuitement à l'entretien suivant de ce joueur. */
  rebound?: PlayerId;
  /** Lancé pour son coût d'évocation : sacrifié en arrivant. */
  evoked?: boolean;
  /** Type choisi en arrivant (« As ~ enters, choose a creature type »). */
  chosenType?: string;
  /** Sort ou capacité sur la pile qui commence par un regard : `done` une fois les cartes rangées. */
  scry?: { count: number; done?: boolean };
  /**
   * Sort lancé par le moteur (et non posé à la main sur la pile) : ses cibles,
   * dans l'ordre des cibles du texte. Ses effets s'appliquent à la résolution.
   */
  targets?: Target[];
  /** Valeur de X choisie au lancement. */
  xValue?: number;
  /**
   * Capacité déclenchée sur la pile (et non une carte) : elle montre l'image
   * de sa source et disparaît quand elle se résout ou quitte la pile.
   */
  ability?: StackAbility;
}

export interface StackAbility {
  sourceId: CardInstanceId;
  sourceName: string;
  /** Texte de la capacité. */
  text: string;
  /** Index de la capacité parmi celles de la source (pour retrouver ses effets). */
  index: number;
  /** Face de la source (pour retrouver ses effets). */
  faceIndex: number;
  /** Joueur et quantité de l'événement (« that player », « that much »). */
  eventPlayerId?: PlayerId;
  /** Carte de l'événement (« return that card »), et la zone où elle est allée. */
  eventCardId?: CardInstanceId;
  /** Données de la carte de l'événement (Ashling copie l'Élémental sacrifié). */
  eventDataId?: string;
  eventFaceIndex?: number;
  eventZone?: Zone;
  /** Capacité donnée à la source (« that creature gains "When this creature dies, …" ») : son texte. */
  grantedText?: string;
  eventAmount?: number;
  /** Le contrôleur doit encore choisir les cibles. */
  needsTargets?: boolean;
  /** Capacité activée (et non déclenchée) : `index` désigne alors une capacité activée de la source. */
  activated?: boolean;
  /** Capacité facultative (« you may ») : le contrôleur doit dire oui ou non avant qu'elle se résolve. */
  awaitingDecision?: boolean;
  /** Qui doit répondre, si ce n'est pas le contrôleur (« unless that player pays {1} »). */
  decider?: PlayerId;
  /** Le payeur a payé pour empêcher l'effet (`false` : il a refusé). */
  unlessPaid?: boolean;
  /** Entretien cumulatif : le marqueur d'âge est posé. */
  aged?: boolean;
  /** Réponse du contrôleur à une capacité facultative. */
  accepted?: boolean;
  /** Permanent choisi à la résolution (le sacrifice d'Exploit…). */
  choice?: CardInstanceId;
  /** « One or more creatures … deal combat damage » : les créatures de l'événement groupé. */
  batch?: CardInstanceId[];
  /** Couleur choisie pour « Add one mana of any color ». */
  color?: ManaType;
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
  /** Raison de la défaite décidée par le moteur (points de vie, poison…) ; le joueur est alors hors jeu. */
  lostReason?: string;
  /** A tenté de piocher dans une bibliothèque vide (il perd à la prochaine vérification). */
  drewFromEmpty?: boolean;
  /**
   * Cartes que le joueur doit encore mettre au-dessous de sa bibliothèque
   * après ses mulligans (règle 103.5) : la partie n'avance pas avant.
   */
  mulliganBottom: number;
  /**
   * Main de départ : `false` tant que le joueur n'a pas décidé de la garder.
   * Le tour 1 ne commence que quand tous l'ont gardée. Absent (anciennes
   * parties) : la main est gardée.
   */
  handKept?: boolean;
  /** Points de vie perdus ce tour (Wound Reflection). */
  lifeLost?: { turn: number; amount: number };
  /** Cartes piochées ce tour (Gixian Puppeteer). */
  drawsThisTurn?: { turn: number; count: number };
  /** Les cartes piochées ce tour, dans l'ordre (Sylvan Library : « cards in your hand drawn this turn »). */
  drawnThisTurn?: { turn: number; ids: CardInstanceId[] };
  /** Sorts lancés ce tour (Moderation…). */
  spellsCast?: { turn: number; count: number };
  /** Sorts lancés ce tour, dans l'ordre (« your first noncreature spell each turn », Esper Sentinel). */
  castHistory?: { turn: number; spells: CastRecord[] };
  /** Noms des sorts lancés pendant la partie (Approach of the Second Sun). */
  castNames?: string[];
  /**
   * Effets « until your next turn » sur le joueur (Teferi's Protection) : ils prennent fin
   * au début de son prochain tour. `lifeCantChange` : ses points de vie ne changent pas ;
   * `protection` : protection contre tout (ni ciblé, ni blessé).
   */
  untilNextTurn?: { lifeCantChange?: boolean; protection?: boolean };
  /** Terrains joués ce tour (un seul par tour, règle 305.2). */
  landsPlayed: number;
  /** Terrains supplémentaires accordés pour un tour (Explore). */
  extraLands?: { turn: number; count: number };
  /** Réserve de mana ; elle se vide à la fin de chaque étape (règle 500.4). */
  manaPool: ManaPool;
  /** Mana qui ne sert qu'à certains sorts (Primal Beyond : les Élémentaux) ; vidé avec la réserve. */
  restrictedMana?: { mana: ManaType; subtype: string; abilities: boolean }[];
  /** Arrêts pour répondre pendant le tour des autres (toutes les étapes clés par défaut). */
  priorityStops?: PriorityStops;
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
   * au début du tour, piocher à l'étape de pioche, faire défausser jusqu'à la
   * taille maximale de main au nettoyage.
   */
  autoTurnActions: boolean;
  /**
   * Faire respecter les règles pour jouer ses cartes : une carte de la main
   * ou de la zone de commandement ne va sur le champ de bataille ou la pile
   * qu'en étant jouée (terrain) ou lancée (sort). Un déplacement « forcé »
   * reste possible pour les effets que le moteur ne connaît pas.
   */
  enforceRules: boolean;
}

export interface PriorityState {
  /** Le joueur qui a la priorité (en tours partagés : un membre de l'équipe, qui la tient pour tous). */
  playerId: PlayerId;
  /** Joueurs ayant passé la priorité d'affilée depuis le dernier changement de la pile. */
  passed: PlayerId[];
  /**
   * Pile vide : le joueur actif veut avancer, et les autres peuvent d'abord
   * répondre (éphémères, flash). Quand tous ont passé, l'avancée a lieu.
   */
  pending?: PendingAdvance;
}

/** Avancée du tour demandée par le joueur actif, en attente des réponses. */
export type PendingAdvance = { type: "nextStep"; to?: TurnStep } | { type: "passTurn" };

/**
 * Étapes du tour des autres où le joueur s'arrête pour pouvoir répondre.
 * Choisies à l'avance et jamais déduites de sa main : s'arrêter ne trahit
 * pas qu'il a un éphémère.
 */
export type PriorityStops = TurnStep[];

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
  /** Mana en plus quand on engage un terrain de ce type, jusqu'à la fin du tour (Bubbling Muck). */
  manaBonuses?: { turn: number; subtype: string; mana: ManaType }[];
  /** Cartes exilées à rendre au début de la prochaine étape de fin d'un joueur (The Eternal Wanderer). */
  delayedReturns?: { cardId: CardInstanceId; playerId: PlayerId }[];
  /** Myriade : les jetons exilés à la fin du combat. */
  endOfCombatExile?: CardInstanceId[];
  /**
   * Le monarque (règle 724) : il pioche une carte au début de son étape de fin, et le
   * joueur dont une créature lui inflige des blessures de combat le devient. Absent : personne.
   */
  monarch?: PlayerId;
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
  /** Événements de l'action en cours, en attente de déclencher des capacités (vidé après chaque action). */
  events?: TriggerEvent[];
  priority: PriorityState | null;
  /** Combat en cours (de l'étape de début de combat à la fin du combat). */
  combat: CombatState | null;
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
    /** Étapes d'entretien supplémentaires à venir (Paradox Haze), et entretiens déjà commencés ce tour. */
    extraUpkeeps?: number;
    upkeeps?: number;
  };
  /** État du générateur aléatoire (mélanges), pour des parties rejouables. */
  rngState: number;
  log: LogEntry[];
}
