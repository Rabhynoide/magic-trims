import { describe, expect, it } from "vitest";
import { applyAction, type ActionResult } from "../src/reducer.js";
import type { GameAction } from "../src/actions.js";
import { createGame } from "../src/setup.js";
import type { GameState } from "../src/types.js";
import { fakeCard, fakeDeck, newTestGame } from "./helpers.js";

function act(state: GameState, actorId: string, action: GameAction): GameState {
  const result: ActionResult = applyAction(state, { actorId, action });
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

function refuse(state: GameState, actorId: string, action: GameAction): string {
  const result = applyAction(state, { actorId, action });
  if (result.ok) throw new Error("L'action aurait dû être refusée");
  return result.error;
}

function nameOf(g: GameState, id: string): string {
  return g.cardData[g.cards[id]!.cardId]!.name;
}

describe("mise en place", () => {
  it("prépare chaque joueur selon les règles Commander", () => {
    const g = newTestGame(5);
    expect(g.turnOrder).toHaveLength(5);
    for (const p of Object.values(g.players)) {
      expect(p.life).toBe(40);
      expect(p.zones.command).toHaveLength(1);
      expect(g.cards[p.zones.command[0]!]!.isCommander).toBe(true);
      expect(p.zones.hand).toHaveLength(7);
      expect(p.zones.library).toHaveLength(92);
    }
    expect(g.turn.activePlayerId).toBe("p1");
  });

  it("refuse plus de 5 joueurs", () => {
    expect(() => newTestGame(6)).toThrow();
  });

  it("donne la même partie pour la même graine", () => {
    const a = newTestGame(3, 7);
    const b = newTestGame(3, 7);
    expect(a.players.p1!.zones.hand.map((id) => nameOf(a, id))).toEqual(
      b.players.p1!.zones.hand.map((id) => nameOf(b, id)),
    );
  });

  it("mélange l'ordre du tour par défaut", () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const g = createGame({
        id: "x",
        seed,
        players: ["a", "b", "c", "d"].map((id) => ({ id, name: id, deck: fakeDeck(id) })),
      });
      orders.add(g.turnOrder.join());
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("actions", () => {
  it("ne modifie jamais l'état d'origine", () => {
    const g = newTestGame();
    const snapshot = JSON.stringify(g);
    act(g, "p1", { type: "draw", count: 2 });
    expect(JSON.stringify(g)).toBe(snapshot);
  });

  it("pioche sans révéler les cartes dans le journal", () => {
    let g = newTestGame();
    const top = g.players.p1!.zones.library[0]!;
    g = act(g, "p1", { type: "draw", count: 1 });
    expect(g.players.p1!.zones.hand).toContain(top);
    expect(g.players.p1!.zones.hand).toHaveLength(8);
    expect(g.log.at(-1)!.message).toBe("Alice pioche 1 carte.");
    expect(g.version).toBe(1);
  });

  it("signale une pioche dans une bibliothèque vide", () => {
    let g = newTestGame(2);
    g = act(g, "p1", { type: "draw", count: 100 });
    expect(g.players.p1!.zones.library).toHaveLength(0);
    expect(g.log.at(-1)!.message).toContain("bibliothèque vide");
  });

  it("nomme une carte jouée et remet à zéro une carte qui quitte le champ de bataille", () => {
    let g = newTestGame();
    const id = g.players.p1!.zones.hand[0]!;
    g = act(g, "p1", { type: "moveCard", cardId: id, to: "battlefield" });
    expect(g.log.at(-1)!.message).toContain(nameOf(g, id));
    g = act(g, "p1", { type: "setTapped", cardIds: [id], tapped: true });
    g = act(g, "p1", { type: "adjustCardCounter", cardId: id, kind: "+1/+1", delta: 2 });
    expect(g.cards[id]!.counters["+1/+1"]).toBe(2);
    g = act(g, "p1", { type: "moveCard", cardId: id, to: "graveyard" });
    expect(g.cards[id]).toMatchObject({ zone: "graveyard", tapped: false, counters: {} });
    expect(g.players.p1!.zones.graveyard.at(-1)).toBe(id);
  });

  it("interdit de toucher aux cartes cachées d'un adversaire", () => {
    const g = newTestGame();
    const id = g.players.p1!.zones.hand[0]!;
    expect(refuse(g, "p2", { type: "moveCard", cardId: id, to: "graveyard" })).toMatch(/cachées/);
  });

  it("permet de détruire un permanent adverse, et la carte va chez son propriétaire", () => {
    let g = newTestGame();
    const id = g.players.p1!.zones.hand[0]!;
    g = act(g, "p1", { type: "moveCard", cardId: id, to: "battlefield" });
    g = act(g, "p2", { type: "changeControl", cardId: id, controllerId: "p2" });
    expect(g.players.p2!.zones.battlefield).toContain(id);
    g = act(g, "p3", { type: "moveCard", cardId: id, to: "graveyard" });
    expect(g.players.p1!.zones.graveyard).toContain(id);
    expect(g.cards[id]!.controllerId).toBe("p1");
    expect(g.log.at(-1)!.message).toMatch(/^Chloé déplace .* d'Alice du champ de bataille au cimetière\.$/);
  });

  it("fait disparaître un jeton qui quitte le champ de bataille", () => {
    let g = newTestGame();
    g = act(g, "p1", { type: "createToken", card: fakeCard("Soldier", { typeLine: "Token Creature" }), count: 3 });
    const tokens = g.players.p1!.zones.battlefield;
    expect(tokens).toHaveLength(3);
    g = act(g, "p1", { type: "moveCard", cardId: tokens[0]!, to: "graveyard" });
    expect(g.players.p1!.zones.battlefield).toHaveLength(2);
    expect(g.players.p1!.zones.graveyard).toHaveLength(0);
    expect(g.cards[tokens[0]!]).toBeUndefined();
  });

  it("compte la taxe de commandant", () => {
    let g = newTestGame();
    const cmd = g.players.p1!.zones.command[0]!;
    g = act(g, "p1", { type: "moveCard", cardId: cmd, to: "stack" });
    g = act(g, "p1", { type: "moveCard", cardId: cmd, to: "battlefield" });
    g = act(g, "p1", { type: "moveCard", cardId: cmd, to: "command" });
    g = act(g, "p1", { type: "moveCard", cardId: cmd, to: "battlefield" });
    expect(g.players.p1!.commanderCasts[cmd]).toBe(2);
  });

  it("compte les blessures de commandant et retire les points de vie", () => {
    let g = newTestGame();
    const cmd = g.players.p1!.zones.command[0]!;
    g = act(g, "p1", { type: "adjustCommanderDamage", playerId: "p2", commanderId: cmd, delta: 5 });
    g = act(g, "p1", { type: "adjustCommanderDamage", playerId: "p2", commanderId: cmd, delta: 4 });
    expect(g.players.p2!.commanderDamage[cmd]).toBe(9);
    expect(g.players.p2!.life).toBe(31);
    expect(refuse(g, "p1", {
      type: "adjustCommanderDamage",
      playerId: "p2",
      commanderId: g.players.p1!.zones.hand[0]!,
      delta: 1,
    })).toMatch(/commandant/);
  });

  it("garde les blessures de commandant quand le commandant change d'identifiant", () => {
    let g = newTestGame();
    const cmd = g.players.p1!.zones.command[0]!;
    g = act(g, "p1", { type: "adjustCommanderDamage", playerId: "p2", commanderId: cmd, delta: 6 });
    g = act(g, "p1", { type: "moveCard", cardId: cmd, to: "library", position: "bottom" });
    const newId = g.players.p1!.zones.library.at(-1)!;
    expect(newId).not.toBe(cmd);
    expect(g.players.p2!.commanderDamage[newId]).toBe(6);
    expect(g.players.p2!.commanderDamage[cmd]).toBeUndefined();
  });

  it("change les identifiants des cartes mélangées pour qu'on ne puisse pas les suivre", () => {
    let g = newTestGame();
    const before = new Set(g.players.p1!.zones.library);
    g = act(g, "p1", { type: "shuffleLibrary" });
    const after = g.players.p1!.zones.library;
    expect(after).toHaveLength(before.size);
    expect(after.some((id) => before.has(id))).toBe(false);
    expect(Object.keys(g.cards)).toHaveLength(4 * 100);
  });

  it("prend un mulligan (le premier est gratuit)", () => {
    let g = newTestGame();
    g = act(g, "p1", { type: "mulligan" });
    expect(g.players.p1!.zones.hand).toHaveLength(7);
    expect(g.players.p1!.zones.library).toHaveLength(92);
    expect(g.log.at(-1)!.message).toContain("gratuit");
    g = act(g, "p1", { type: "mulligan" });
    expect(g.log.at(-1)!.message).toContain("1 carte au-dessous");
    expect(g.players.p1!.mulliganBottom).toBe(1);
  });

  it("oblige à mettre les cartes en trop au-dessous de la bibliothèque après des mulligans", () => {
    let g = newTestGame();
    g = act(g, "p2", { type: "mulligan" });
    g = act(g, "p2", { type: "mulligan" });
    g = act(g, "p2", { type: "mulligan" });
    expect(g.players.p2!.mulliganBottom).toBe(2);
    // La partie n'avance pas tant que ce n'est pas fait.
    expect(refuse(g, "p1", { type: "nextStep" })).toMatch(/Bruno doit d'abord mettre des cartes au-dessous/);
    expect(refuse(g, "p1", { type: "passTurn" })).toMatch(/mulligan/);
    const hand = g.players.p2!.zones.hand;
    expect(refuse(g, "p2", { type: "bottomMulligan", cardIds: [hand[0]!] })).toMatch(/exactement 2 cartes/);
    expect(refuse(g, "p2", { type: "bottomMulligan", cardIds: [hand[0]!, hand[0]!] })).toMatch(/exactement/);
    expect(refuse(g, "p2", { type: "bottomMulligan", cardIds: [hand[0]!, g.players.p1!.zones.hand[0]!] })).toMatch(/ta main/);
    g = act(g, "p2", { type: "bottomMulligan", cardIds: [hand[0]!, hand[1]!] });
    expect(g.players.p2!.zones.hand).toHaveLength(5);
    expect(g.players.p2!.zones.library).toHaveLength(94);
    expect(g.players.p2!.mulliganBottom).toBe(0);
    expect(refuse(g, "p2", { type: "bottomMulligan", cardIds: [] })).toMatch(/pas de cartes/);
    g = act(g, "p1", { type: "nextStep" });
    expect(g.turn.step).toBe("draw");
  });

  it("meule et regarde le dessus de la bibliothèque", () => {
    let g = newTestGame();
    const top3 = g.players.p1!.zones.library.slice(0, 3);
    g = act(g, "p1", { type: "lookAtLibraryTop", count: 2 });
    expect(g.cards[top3[0]!]!.revealedTo).toEqual(["p1"]);
    g = act(g, "p1", { type: "moveTopOfLibrary", count: 3, to: "graveyard" });
    expect(g.players.p1!.zones.graveyard).toEqual(top3);
    expect(g.log.at(-1)!.message).toContain(nameOf(g, top3[0]!));
  });

  it("fait tourner le tour en sautant les joueurs qui ont abandonné", () => {
    let g = newTestGame(3);
    expect(refuse(g, "p2", { type: "passTurn" })).toMatch(/pas ton tour/);
    g = act(g, "p2", { type: "concede" });
    g = act(g, "p1", { type: "passTurn" });
    expect(g.turn).toMatchObject({ number: 2, activePlayerId: "p3" });
    expect(refuse(g, "p2", { type: "draw", count: 1 })).toMatch(/abandonné/);
  });

  it("transforme une carte double face", () => {
    let g = newTestGame();
    const dfc = fakeCard("Delver of Secrets // Insectile Aberration", {
      faces: [
        { name: "Delver of Secrets", manaCost: "{U}", typeLine: "Creature", oracleText: "" },
        { name: "Insectile Aberration", manaCost: "", typeLine: "Creature", oracleText: "Flying" },
      ],
    });
    g = act(g, "p1", { type: "createToken", card: dfc });
    const id = g.players.p1!.zones.battlefield[0]!;
    g = act(g, "p1", { type: "transform", cardId: id });
    expect(g.log.at(-1)!.message).toBe("Alice transforme Delver of Secrets en Insectile Aberration.");
  });

  it("lance un dé de façon reproductible", () => {
    const g = newTestGame();
    const a = act(g, "p1", { type: "rollDie", sides: 20 });
    const b = act(g, "p1", { type: "rollDie", sides: 20 });
    expect(a.log.at(-1)!.message).toBe(b.log.at(-1)!.message);
    expect(a.log.at(-1)!.message).toMatch(/dé à 20 faces : \d+\./);
  });
});
