import { describe, expect, it } from "vitest";
import { parseDeckList } from "../src/deck/parse.js";
import data from "../../app/src/renderer/src/data/precons.json";

/**
 * Liste des préconstruits embarquée dans l'appli (générée par `npm run precons`) :
 * chaque deck doit se lire sans erreur avec l'import habituel.
 */
const file = data as { decks: { id: string; commanders: string[]; cards: string[] }[] };

describe("préconstruits officiels", () => {
  it("contient des decks", () => {
    expect(file.decks.length).toBeGreaterThan(150);
    expect(new Set(file.decks.map((d) => d.id)).size).toBe(file.decks.length);
  });

  it("chaque deck se lit avec l'import (commandant, 100 cartes, édition et numéro)", () => {
    for (const d of file.decks) {
      const parsed = parseDeckList(`Commander\n${d.commanders.join("\n")}\n\nDeck\n${d.cards.join("\n")}\n`);
      expect(parsed.errors, d.id).toEqual([]);
      expect(parsed.commanders.length, d.id).toBeGreaterThanOrEqual(1);
      const total = [...parsed.commanders, ...parsed.mainboard].reduce((n, e) => n + e.quantity, 0);
      expect(total, d.id).toBe(100);
      for (const e of [...parsed.commanders, ...parsed.mainboard]) {
        expect(e.set && e.collectorNumber, `${d.id} : ${e.name}`).toBeTruthy();
      }
    }
  });
});
