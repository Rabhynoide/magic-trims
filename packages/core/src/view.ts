import { evaluateOutcome, type Outcome } from "./modes.js";
import { canSee } from "./reducer.js";
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
}

export type CardView = VisibleCardView | HiddenCardView;

export interface PlayerView extends Omit<PlayerState, "zones"> {
  zones: Record<PlayerZone, CardView[]>;
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
    if (card.attachedTo) hidden.attachedTo = card.attachedTo;
    return hidden;
  };

  const players: Record<PlayerId, PlayerView> = {};
  for (const id of g.turnOrder) {
    const { zones, ...rest } = g.players[id]!;
    const viewZones = {} as Record<PlayerZone, CardView[]>;
    for (const zone of PLAYER_ZONES) viewZones[zone] = zones[zone].map(viewCard);
    players[id] = { ...structuredClone(rest), zones: viewZones };
  }

  const view: GameView = {
    id: g.id,
    version: g.version,
    viewerId,
    settings: { ...g.settings },
    turnOrder: [...g.turnOrder],
    teams: g.teams.map((t) => [...t]),
    turn: { ...g.turn },
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
