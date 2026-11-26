import type { CardData } from "../src/types.js";
import type { ResolvedDeck } from "../src/deck/resolve.js";
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

export function newTestGame(playerCount = 4, seed = 42): GameState {
  const names = ["Alice", "Bruno", "Chloé", "David", "Emma", "Farid"];
  const players: NewGamePlayer[] = Array.from({ length: playerCount }, (_, i) => ({
    id: `p${i + 1}`,
    name: names[i]!,
    deck: fakeDeck(names[i]!),
  }));
  return createGame({ id: "test", players, seed, randomTurnOrder: false });
}
