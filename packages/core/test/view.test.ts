import { describe, expect, it } from "vitest";
import { applyAction } from "../src/reducer.js";
import { viewFor } from "../src/view.js";
import { newTestGame } from "./helpers.js";

describe("vue d'un joueur", () => {
  it("montre sa main au joueur et la cache aux autres", () => {
    const g = newTestGame();
    const own = viewFor(g, "p1");
    const other = viewFor(g, "p2");
    expect(own.players.p1!.zones.hand.every((c) => !c.hidden)).toBe(true);
    expect(other.players.p1!.zones.hand.every((c) => c.hidden)).toBe(true);
    expect(other.players.p1!.zones.hand).toHaveLength(7);
  });

  it("ne transmet ni l'ordre de la bibliothèque, ni les données des cartes cachées, ni l'aléatoire", () => {
    const g = newTestGame();
    const view = viewFor(g, "p2");
    const library = view.players.p1!.zones.library;
    expect(library).toHaveLength(92);
    expect(library.every((c) => c.hidden && c.instanceId === null)).toBe(true);
    // Le joueur 2 ne connaît que ses cartes en main et les commandants.
    expect(Object.keys(view.cardData)).toHaveLength(7 + 4);
    const json = JSON.stringify(view);
    expect(json).not.toContain("rngState");
    for (const id of g.players.p1!.zones.hand) {
      expect(json).not.toContain(g.cards[id]!.cardId);
    }
  });

  it("montre les cartes regardées sur le dessus de sa bibliothèque", () => {
    const g = newTestGame();
    const result = applyAction(g, { actorId: "p1", action: { type: "lookAtLibraryTop", count: 2 } });
    if (!result.ok) throw new Error(result.error);
    const library = viewFor(result.state, "p1").players.p1!.zones.library;
    expect(library.slice(0, 2).every((c) => !c.hidden)).toBe(true);
    expect(library[2]!.hidden).toBe(true);
    expect(viewFor(result.state, "p2").players.p1!.zones.library[0]!.hidden).toBe(true);
  });

  it("cache une carte face cachée aux adversaires", () => {
    let g = newTestGame();
    const id = g.players.p1!.zones.hand[0]!;
    const result = applyAction(g, {
      actorId: "p1",
      action: { type: "moveCard", cardId: id, to: "battlefield", faceDown: true },
    });
    if (!result.ok) throw new Error(result.error);
    g = result.state;
    expect(viewFor(g, "p1").players.p1!.zones.battlefield[0]!.hidden).toBe(false);
    expect(viewFor(g, "p2").players.p1!.zones.battlefield[0]!.hidden).toBe(true);
    expect(g.log.at(-1)!.message).toContain("une carte");
  });
});
