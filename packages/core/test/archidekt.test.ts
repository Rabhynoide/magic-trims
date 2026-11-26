import { describe, expect, it } from "vitest";
import { archidektDeckId, archidektToText, fetchArchidektDeck } from "../src/deck/archidekt.js";
import { parseDeckList } from "../src/deck/parse.js";

describe("Archidekt", () => {
  it("lit l'export texte avec ses catégories", () => {
    const deck = parseDeckList(`1x Atraxa, Praetors' Voice (c16) 28 [Commander{top}]
1x Sol Ring (c21) 263 *F* [Ramp]
1x Command Tower (c21) 279 [Land]
1x Swords to Plowshares (sta) 10 [Maybeboard{noDeck}{noPrice},Removal]
1x Path to Exile [Sideboard{noDeck}] ^Have,#37d67a^
1x Arcane Signet (eld) 331 [Ramp] ^Have,#37d67a^
`);
    expect(deck.errors).toEqual([]);
    expect(deck.commanders).toEqual([{ quantity: 1, name: "Atraxa, Praetors' Voice", set: "c16", collectorNumber: "28", line: 1 }]);
    expect(deck.mainboard.map((e) => [e.name, e.set, e.collectorNumber])).toEqual([
      ["Sol Ring", "c21", "263"],
      ["Command Tower", "c21", "279"],
      ["Arcane Signet", "eld", "331"],
    ]);
    expect(deck.other.map((e) => e.name)).toEqual(["Swords to Plowshares", "Path to Exile"]);
  });

  it("reconnaît un lien de deck", () => {
    expect(archidektDeckId("https://archidekt.com/decks/123456/mon_deck")).toBe("123456");
    expect(archidektDeckId("  archidekt.com/decks/42 ")).toBe("42");
    expect(archidektDeckId("1 Sol Ring")).toBeNull();
    expect(archidektDeckId("https://moxfield.com/decks/abc")).toBeNull();
  });

  it("importe un deck depuis l'API", async () => {
    const json = {
      name: "Atraxa +1",
      categories: [
        { name: "Commander", includedInDeck: true, isPremier: true },
        { name: "Ramp", includedInDeck: true },
        { name: "Maybeboard", includedInDeck: false },
      ],
      cards: [
        { quantity: 1, categories: ["Commander"], card: { collectorNumber: "28", edition: { editioncode: "c16" }, oracleCard: { name: "Atraxa, Praetors' Voice" } } },
        { quantity: 1, categories: ["Ramp"], card: { collectorNumber: "263", edition: { editioncode: "c21" }, oracleCard: { name: "Sol Ring" } } },
        { quantity: 1, categories: ["Maybeboard"], card: { oracleCard: { name: "Mana Crypt" } } },
        { quantity: 10, categories: null, card: { collectorNumber: "276", edition: { editioncode: "c21" }, oracleCard: { name: "Forest" } } },
      ],
    };
    const urls: string[] = [];
    const { name, text } = await fetchArchidektDeck("123", async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(json));
    });
    expect(urls).toEqual(["https://archidekt.com/api/decks/123/"]);
    expect(name).toBe("Atraxa +1");
    const deck = parseDeckList(text);
    expect(deck.errors).toEqual([]);
    expect(deck.commanders.map((e) => e.name)).toEqual(["Atraxa, Praetors' Voice"]);
    expect(deck.mainboard.map((e) => [e.name, e.quantity])).toEqual([["Sol Ring", 1], ["Forest", 10]]);
    expect(deck.other.map((e) => e.name)).toEqual(["Mana Crypt"]);
    expect(archidektToText({})).toBe("");
  });

  it("explique un deck privé ou introuvable", async () => {
    await expect(fetchArchidektDeck("9", async () => new Response("{}", { status: 404 }))).rejects.toThrow(/introuvable/);
  });
});
