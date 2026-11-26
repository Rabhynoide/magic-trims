import type { ResolvedDeck } from "./deck/resolve.js";
import { log, moveCardTo, newInstance } from "./reducer.js";
import { randomSeed, shuffleInPlace } from "./rng.js";
import type { GameSettings, GameState, PlayerId, PlayerState } from "./types.js";

export const DEFAULT_SETTINGS: GameSettings = {
  startingLife: 40,
  commanderDamageLimit: 21,
  poisonLimit: 10,
  freeFirstMulligan: true,
};

export const MAX_PLAYERS = 5;
export const OPENING_HAND_SIZE = 7;

export interface NewGamePlayer {
  id: PlayerId;
  name: string;
  deck: ResolvedDeck;
}

export interface NewGameOptions {
  id: string;
  players: NewGamePlayer[];
  settings?: Partial<GameSettings>;
  /** Graine des mélanges ; aléatoire par défaut. */
  seed?: number;
  /** Mélanger l'ordre du tour (vrai par défaut). */
  randomTurnOrder?: boolean;
}

/**
 * Met en place une partie : commandants dans la zone de commandement,
 * bibliothèques mélangées, mains de départ piochées.
 */
export function createGame(options: NewGameOptions): GameState {
  const { players } = options;
  if (players.length < 1 || players.length > MAX_PLAYERS) {
    throw new Error(`Une partie se joue de 1 à ${MAX_PLAYERS} joueurs.`);
  }
  if (new Set(players.map((p) => p.id)).size !== players.length) {
    throw new Error("Deux joueurs ont le même identifiant.");
  }

  const settings: GameSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const turnOrder = players.map((p) => p.id);
  let rngState = options.seed ?? randomSeed();
  if (options.randomTurnOrder ?? true) rngState = shuffleInPlace(turnOrder, rngState);

  const g: GameState = {
    id: options.id,
    version: 0,
    settings,
    turnOrder,
    players: {},
    cards: {},
    cardData: {},
    stack: [],
    turn: { number: 1, activePlayerId: turnOrder[0]! },
    rngState,
    log: [],
  };

  for (const p of players) {
    const player: PlayerState = {
      id: p.id,
      name: p.name,
      life: settings.startingLife,
      poison: 0,
      commanderDamage: {},
      counters: {},
      zones: { library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [] },
      commanderCasts: {},
      mulligans: 0,
      hasConceded: false,
    };
    g.players[p.id] = player;

    for (const commander of p.deck.commanders) {
      g.cardData[commander.id] ??= commander;
      const instance = newInstance(g, commander.id, p.id, "command");
      instance.isCommander = true;
      instance.revealedTo = [...turnOrder];
      player.zones.command.push(instance.instanceId);
    }
    for (const { card, quantity } of p.deck.cards) {
      g.cardData[card.id] ??= card;
      for (let i = 0; i < quantity; i++) {
        player.zones.library.push(newInstance(g, card.id, p.id, "library").instanceId);
      }
    }
  }

  for (const id of turnOrder) {
    const player = g.players[id]!;
    g.rngState = shuffleInPlace(player.zones.library, g.rngState);
    for (let i = 0; i < OPENING_HAND_SIZE && player.zones.library.length > 0; i++) {
      moveCardTo(g, player.zones.library[0]!, "hand", "top");
    }
  }

  log(g, null, `La partie commence. ${g.players[turnOrder[0]!]!.name} joue en premier.`);
  return g;
}
