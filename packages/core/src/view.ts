import { evaluateOutcome, type Outcome } from "./modes.js";
import { canSee, handSizeDiscards } from "./reducer.js";
import {
  HIDDEN_ORDERED_ZONES,
  PLAYER_ZONES,
  type CardData,
  type CardInstance,
  type CardInstanceId,
  type GameState,
  type LogEntry,
  type PlayerId,
  type PlayerState,
  type PlayerZone,
} from "./types.js";

/** Une carte que le joueur voit. */
export interface VisibleCardView extends CardInstance {
  hidden: false;
}

/** Une carte dont le joueur ne connaît pas l'identité. */
export interface HiddenCardView {
  hidden: true;
  /** `null` dans une bibliothèque : on ne doit pas pouvoir suivre une carte cachée. */
  instanceId: CardInstanceId | null;
  ownerId: PlayerId;
  controllerId: PlayerId;
  zone: CardInstance["zone"];
  tapped: boolean;
  faceDown: boolean;
  counters: Record<string, number>;
  attachedTo?: CardInstanceId;
  damage?: number;
}

export type CardView = VisibleCardView | HiddenCardView;

export interface PlayerView extends Omit<PlayerState, "zones"> {
  zones: Record<PlayerZone, CardView[]>;
  /** Cartes à défausser au nettoyage pour revenir à la taille maximale de main. */
  handSizeDiscards?: number;
}

/**
 * Ce qu'un joueur a le droit de voir de la partie. C'est ce que le serveur
 * envoie à chaque client : jamais l'état complet.
 */
export interface GameView {
  id: string;
  version: number;
  viewerId: PlayerId;
  settings: GameState["settings"];
  turnOrder: PlayerId[];
  teams: PlayerId[][];
  archenemyId?: PlayerId;
  turn: GameState["turn"];
  priority: GameState["priority"];
  combat: GameState["combat"];
  players: Record<PlayerId, PlayerView>;
  stack: CardView[];
  /** Variante Planechase. */
  planarDeck: CardView[];
  plane: CardView[];
  /** Joueurs éliminés et vainqueurs éventuels. */
  outcome: Outcome;
  /** Données des seules cartes visibles par ce joueur. */
  cardData: Record<string, CardData>;
  log: LogEntry[];
}

export function viewFor(g: GameState, viewerId: PlayerId): GameView {
  const cardData: Record<string, CardData> = {};

  const viewCard = (id: CardInstanceId): CardView => {
    const card = g.cards[id]!;
    if (canSee(g, card, viewerId)) {
      const data = g.cardData[card.cardId];
      if (data) cardData[data.id] = data;
      return { ...structuredClone(card), hidden: false };
    }
    const hidden: HiddenCardView = {
      hidden: true,
      instanceId: HIDDEN_ORDERED_ZONES.has(card.zone) ? null : card.instanceId,
      ownerId: card.ownerId,
      controllerId: card.controllerId,
      zone: card.zone,
      tapped: card.tapped,
      faceDown: card.faceDown,
      counters: { ...card.counters },
    };
    if (card.damage) hidden.damage = card.damage;
    if (card.attachedTo) hidden.attachedTo = card.attachedTo;
    return hidden;
  };

  const players: Record<PlayerId, PlayerView> = {};
  for (const id of g.turnOrder) {
    const { zones, ...rest } = g.players[id]!;
    const viewZones = {} as Record<PlayerZone, CardView[]>;
    for (const zone of PLAYER_ZONES) viewZones[zone] = (zones[zone] ?? []).map(viewCard);
    players[id] = { ...structuredClone(rest), zones: viewZones };
    const discards = handSizeDiscards(g, id);
    if (discards > 0) players[id].handSizeDiscards = discards;
  }

  const view: GameView = {
    id: g.id,
    version: g.version,
    viewerId,
    settings: { ...g.settings },
    turnOrder: [...g.turnOrder],
    teams: g.teams.map((t) => [...t]),
    turn: { ...g.turn },
    priority: g.priority ? structuredClone(g.priority) : null,
    combat: g.combat ? structuredClone(g.combat) : null,
    players,
    stack: g.stack.map(viewCard),
    planarDeck: g.planarDeck.map(viewCard),
    plane: g.plane.map(viewCard),
    outcome: evaluateOutcome(g),
    cardData,
    log: g.log.map((e) => ({ ...e })),
  };
  if (g.archenemyId) view.archenemyId = g.archenemyId;
  return view;
}

const stateCache = new WeakMap<GameView, GameState>();

/**
 * Une partie minimale reconstruite depuis une vue, pour que l'interface
 * puisse appeler les fonctions du moteur qui ne font que lire (force et
 * endurance, mots-clés donnés par un équipement…). Les cartes cachées y sont
 * des cartes face cachée sans données.
 */
export function stateFromView(view: GameView): GameState {
  const cached = stateCache.get(view);
  if (cached) return cached;
  const cards: Record<CardInstanceId, CardInstance> = {};
  let hidden = 0;
  const add = (c: CardView): CardInstanceId => {
    const id = c.instanceId ?? `hidden-${hidden++}`;
    cards[id] = c.hidden
      ? { ...c, instanceId: id, cardId: "", faceIndex: 0, isToken: false, isCommander: false, revealedTo: [], faceDown: true }
      : (c as CardInstance);
    return id;
  };
  const players: Record<PlayerId, PlayerState> = {};
  for (const [pid, p] of Object.entries(view.players)) {
    const zones = Object.fromEntries(PLAYER_ZONES.map((z) => [z, (p.zones[z] ?? []).map(add)])) as Record<PlayerZone, CardInstanceId[]>;
    players[pid] = { ...p, zones };
  }
  const g = {
    ...view,
    players,
    cards,
    stack: view.stack.map(add),
    planarDeck: view.planarDeck.map(add),
    plane: view.plane.map(add),
    rngState: 0,
  } as unknown as GameState;
  stateCache.set(view, g);
  return g;
}
