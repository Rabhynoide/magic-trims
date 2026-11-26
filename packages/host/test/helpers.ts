import type { CardData, ResolvedDeck } from "@magic-trims/core";

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

export function fakeDeck(prefix: string): ResolvedDeck {
  return {
    commanders: [fakeCard(`${prefix} Commander`, { typeLine: "Legendary Creature — Elf" })],
    cards: Array.from({ length: 99 }, (_, i) => ({ card: fakeCard(`${prefix} Card ${i}`), quantity: 1 })),
  };
}
