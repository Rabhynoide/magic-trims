import { describe, expect, it } from "vitest";
import { applyAction } from "../src/reducer.js";
import type { GameAction } from "../src/actions.js";
import { manaOptions } from "../src/mana.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame } from "./helpers.js";

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

function refuse(g: GameState, actorId: string, action: GameAction): string {
  const r = applyAction(g, { actorId, action });
  if (r.ok) throw new Error("L'action aurait dû être refusée");
  return r.error;
}

/** Pose la première carte de la main du joueur sur le champ de bataille, avec les données de `card`. */
function put(g: GameState, playerId: string, card: CardData): [GameState, string] {
  const id = g.players[playerId]!.zones.hand[0]!;
  g = structuredClone(g);
  const cardId = g.cards[id]!.cardId;
  g.cardData[cardId] = { ...card, id: cardId };
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield" });
  return [g, id];
}

describe("Capacités de mana reconnues", () => {
  it("terrains de base et terrains à types de base", () => {
    expect(manaOptions("Basic Land — Forest", "({T}: Add {G}.)")).toEqual([["G"]]);
    expect(manaOptions("Land — Forest Island", "({T}: Add {G} or {U}.)")).toEqual([["U"], ["G"]]);
    expect(manaOptions("Basic Land — Wastes", "{T}: Add {C}.")).toEqual([["C"]]);
    expect(manaOptions("Snow Land — Swamp", "")).toEqual([["B"]]);
  });

  it("capacités écrites sur la carte", () => {
    expect(manaOptions("Artifact", "{T}: Add {C}{C}.")).toEqual([["C", "C"]]);
    expect(manaOptions("Land", "{T}: Add {C}.\n{T}: Add {R} or {G}. Karplusan Forest deals 1 damage to you.")).toEqual([
      ["C"],
      ["R"],
      ["G"],
    ]);
    expect(manaOptions("Land", "{T}: Add {W}, {U}, or {B}.")).toEqual([["W"], ["U"], ["B"]]);
    expect(manaOptions("Land", "{T}: Add one mana of any color in your commander's color identity.")).toHaveLength(5);
    expect(manaOptions("Creature — Elf Druid", "{T}: Add {G}.")).toEqual([["G"]]);
  });

  it("ignore ce qui n'est pas une simple capacité {T}", () => {
    expect(manaOptions("Artifact", "{1}, {T}: Add {C}{C}.")).toEqual([]);
    expect(manaOptions("Instant", "Add {R}{R}{R}.")).toEqual([]);
    expect(manaOptions("Creature — Bear", "")).toEqual([]);
  });
});

describe("Réserve de mana", () => {
  const forest = fakeCard("Forest", { typeLine: "Basic Land — Forest", oracleText: "({T}: Add {G}.)" });
  const tower = fakeCard("Command Tower", {
    typeLine: "Land",
    oracleText: "{T}: Add one mana of any color in your commander's color identity.",
  });

  it("engage un terrain pour son mana, une seule fois", () => {
    let g = newTestGame(3);
    let id: string;
    [g, id] = put(g, "p1", forest);
    g = act(g, "p1", { type: "tapForMana", cardId: id });
    expect(g.cards[id]!.tapped).toBe(true);
    expect(g.players.p1!.manaPool.G).toBe(1);
    expect(g.log.at(-1)!.message).toBe("Alice engage Forest pour {G}.");
    expect(refuse(g, "p1", { type: "tapForMana", cardId: id })).toMatch(/déjà engagé/);
    expect(refuse(g, "p2", { type: "tapForMana", cardId: id })).toBeTruthy();
  });

  it("demande quel mana produire quand il y a un choix", () => {
    let g = newTestGame(3);
    let id: string;
    [g, id] = put(g, "p1", tower);
    expect(refuse(g, "p1", { type: "tapForMana", cardId: id })).toMatch(/Choisis/);
    g = act(g, "p1", { type: "tapForMana", cardId: id, choice: 3 });
    expect(g.players.p1!.manaPool.R).toBe(1);
  });

  it("refuse une carte dont le mana est inconnu", () => {
    let g = newTestGame(3);
    let id: string;
    [g, id] = put(g, "p1", fakeCard("Bear", { typeLine: "Creature — Bear" }));
    expect(refuse(g, "p1", { type: "tapForMana", cardId: id })).toMatch(/à la main/);
  });

  it("ajuste la réserve à la main sans descendre sous zéro", () => {
    let g = newTestGame(3);
    g = act(g, "p2", { type: "adjustMana", mana: "U", delta: 2 });
    g = act(g, "p2", { type: "adjustMana", mana: "U", delta: -1 });
    expect(g.players.p2!.manaPool.U).toBe(1);
    expect(refuse(g, "p2", { type: "adjustMana", mana: "U", delta: -2 })).toMatch(/pas assez/);
  });

  it("vide les réserves à chaque changement d'étape", () => {
    let g = newTestGame(3);
    g = act(g, "p1", { type: "adjustMana", mana: "G", delta: 3 });
    g = act(g, "p2", { type: "adjustMana", mana: "B", delta: 1 });
    g = act(g, "p1", { type: "nextStep" });
    expect(g.players.p1!.manaPool.G).toBe(0);
    expect(g.players.p2!.manaPool.B).toBe(0);
  });
});
