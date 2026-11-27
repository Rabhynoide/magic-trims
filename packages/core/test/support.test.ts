import { describe, expect, it } from "vitest";
import { deckSupport, deckSupportPercent } from "../src/deck/support.js";
import { cardSupport } from "../src/effects.js";
import { fakeCard } from "./helpers.js";
import ashling from "./ashling-oracle.json" with { type: "json" };

type OracleCard = { name: string; typeLine: string; oracleText?: string; manaCost?: string };

describe("deckSupport", () => {
  it("compte les exemplaires, commandants compris", () => {
    const s = deckSupport({
      commanders: [fakeCard("Sol Ring", { oracleText: "{T}: Add {C}{C}." })],
      cards: [
        { card: fakeCard("Swamp", { typeLine: "Basic Land — Swamp", oracleText: "({T}: Add {B}.)" }), quantity: 30 },
        { card: fakeCard("Échange", { typeLine: "Sorcery", oracleText: "Exchange your hand and your graveyard." }), quantity: 1 },
      ],
    });
    expect(s).toMatchObject({ total: 32, full: 31, partial: 0, manual: 1, manualNames: ["Échange"] });
    expect(deckSupportPercent(s)).toBe(96);
  });

  it("deck vide : pas de pourcentage", () => {
    expect(deckSupportPercent(deckSupport({ commanders: [], cards: [] }))).toBeNull();
  });

  it("deck Ashling : tout est géré", () => {
    const cards = (ashling as OracleCard[]).map((c) => ({
      card: fakeCard(c.name, { typeLine: c.typeLine, oracleText: c.oracleText ?? "", manaCost: c.manaCost ?? "" }),
      quantity: 1,
    }));
    const s = deckSupport({ commanders: [], cards });
    expect(s.full).toBe(s.total);
    expect(deckSupportPercent(s)).toBe(100);
  });
});

describe("capacités de construction de deck", () => {
  const creature = { typeLine: "Legendary Creature — Test" };
  it("« Partner », « Friends forever », « Choose a Background », « Doctor's companion » sont gérées", () => {
    for (const text of [
      "Partner (You can have two commanders if both have partner.)",
      "Partner—Survivors (You can have two commanders if both have this ability.)",
      "Friends forever (You can have two commanders if both have friends forever.)",
      "Choose a Background (You can have a Background as a second commander.)",
      "Doctor's companion (You can have two commanders if the other is the Doctor.)",
    ]) {
      expect(cardSupport(fakeCard("X", { ...creature, oracleText: text })).level, text).toBe("full");
    }
  });

  it("« can be your commander » est gérée", () => {
    const card = fakeCard("Dihada, Binder of Wills", { typeLine: "Legendary Planeswalker — Dihada", oracleText: "Dihada, Binder of Wills can be your commander." });
    expect(cardSupport(card).unknown).toEqual([]);
  });

  it("« Partner with » reste partielle (recherche du partenaire à l'arrivée)", () => {
    const card = fakeCard("Pir", { ...creature, oracleText: "Partner with Toothy, Imaginary Friend (When this creature enters, target player may put Toothy into their hand from their library, then shuffle.)" });
    expect(cardSupport(card).level).toBe("partial");
  });
});
