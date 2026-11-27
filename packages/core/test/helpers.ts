import type { CardData } from "../src/types.js";
import type { ResolvedDeck } from "../src/deck/resolve.js";
import { applyAction, handSizeDiscards } from "../src/reducer.js";
import { createGame, type NewGamePlayer } from "../src/setup.js";
import type { GameState } from "../src/types.js";

export function fakeCard(name: string, extra: Partial<CardData> = {}): CardData {
  return {
    id: `id-${name}`,
    oracleId: `oracle-${name}`,
    name,
    manaCost: "{1}",
    manaValue: 1,
    typeLine: "Artifact",
    oracleText: "",
    colors: [],
    colorIdentity: [],
    keywords: [],
    commanderLegality: "legal",
    set: "tst",
    collectorNumber: "1",
    ...extra,
  };
}

/** Un deck de 100 cartes : un commandant et 99 cartes toutes différentes. */
export function fakeDeck(prefix: string): ResolvedDeck {
  const commander = fakeCard(`${prefix} Commander`, { typeLine: "Legendary Creature — Elf" });
  const cards = Array.from({ length: 99 }, (_, i) => ({ card: fakeCard(`${prefix} Card ${i}`), quantity: 1 }));
  return { commanders: [commander], cards };
}

/**
 * Partie de test. Les joueurs ne s'arrêtent pas pendant le tour des autres
 * (`stops: true` pour garder les arrêts par défaut).
 */
export function newTestGame(playerCount = 4, seed = 42, stops = false): GameState {
  const names = ["Alice", "Bruno", "Chloé", "David", "Emma", "Farid"];
  const players: NewGamePlayer[] = Array.from({ length: playerCount }, (_, i) => ({
    id: `p${i + 1}`,
    name: names[i]!,
    deck: fakeDeck(names[i]!),
    ...(stops ? {} : { priorityStops: [] }),
  }));
  return createGame({ id: "test", players, seed, randomTurnOrder: false });
}

/**
 * Passe le tour du joueur ; s'il a trop de cartes en main au nettoyage, il
 * défausse les dernières cartes de sa main, comme il le choisirait.
 */
export function endTurn(g: GameState, actorId: string): GameState {
  const run = (state: GameState, id: string, action: Parameters<typeof applyAction>[1]["action"]): GameState => {
    const r = applyAction(state, { actorId: id, action });
    if (!r.ok) throw new Error(r.error);
    return r.state;
  };
  g = run(g, actorId, { type: "passTurn" });
  return discardDownToHandSize(g, run);
}

function discardDownToHandSize(
  g: GameState,
  run: (state: GameState, id: string, action: Parameters<typeof applyAction>[1]["action"]) => GameState,
): GameState {
  for (const id of g.turnOrder) {
    const count = handSizeDiscards(g, id);
    if (count > 0) g = run(g, id, { type: "discardToHandSize", cardIds: g.players[id]!.zones.hand.slice(-count) });
  }
  return g;
}
