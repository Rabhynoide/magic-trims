import { describe, expect, it } from "vitest";
import { deckSupport, deckSupportPercent } from "../src/deck/support.js";
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
