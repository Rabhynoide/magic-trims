import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { evaluateOutcome, GAME_MODES, starEnemies } from "../src/modes.js";
import { applyAction } from "../src/reducer.js";
import { createGame, type NewGameOptions } from "../src/setup.js";
import type { GameModeType, GameState } from "../src/types.js";
import { viewFor } from "../src/view.js";
import { fakeCard, fakeDeck } from "./helpers.js";

const NAMES = ["Alice", "Bruno", "Chloé", "David", "Emma"];

function game(mode: GameModeType, count: number, extra: Partial<NewGameOptions> = {}): GameState {
  return createGame({
    id: "t",
    seed: 1,
    mode,
    randomTurnOrder: false,
    players: NAMES.slice(0, count).map((name, i) => ({ id: `p${i + 1}`, name, deck: fakeDeck(name) })),
    ...extra,
  });
}

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

describe("modes de jeu", () => {
  it("vérifie le nombre de joueurs de chaque mode", () => {
    expect(() => game("duel", 3)).toThrow(/Duel se joue à 2 joueurs/);
    expect(() => game("star", 4)).toThrow(/5 joueurs/);
    expect(() => game("twoHeadedGiant", 5)).toThrow();
    expect(() => game("archenemy", 2)).toThrow(/3 à 5/);
    for (const mode of Object.values(GAME_MODES)) {
      expect(() => game(mode.type, mode.maxPlayers)).not.toThrow();
    }
  });

  it("duel : 20 points de vie par défaut, réglable", () => {
    expect(game("duel", 2).players.p1!.life).toBe(20);
    expect(game("duel", 2, { settings: { startingLife: 40 } }).players.p1!.life).toBe(40);
  });

  it("équipes : regroupe par deux et alterne les équipes autour de la table", () => {
    const g = game("teams", 4);
    expect(g.teams).toEqual([["p1", "p2"], ["p3", "p4"]]);
    expect(g.turnOrder).toEqual(["p1", "p3", "p2", "p4"]);
    const five = game("teams", 5);
    expect(five.teams.map((t) => t.length)).toEqual([2, 3]);
  });

  it("équipes : refuse des équipes incohérentes", () => {
    expect(() => game("teams", 4, { teams: [["p1", "p2", "p3", "p4"]] })).toThrow(/deux équipes/);
    expect(() => game("teams", 4, { teams: [["p1", "p2"], ["p3"]] })).toThrow(/une seule équipe/);
  });

  it("chacun pour soi : le dernier joueur en lice gagne", () => {
    let g = game("freeForAll", 3);
    g = act(g, "p1", { type: "adjustLife", playerId: "p2", delta: -40 });
    expect(evaluateOutcome(g)).toEqual({ eliminated: { p2: "points de vie" }, winners: null });
    g = act(g, "p3", { type: "adjustPoison", playerId: "p3", delta: 10 });
    expect(evaluateOutcome(g).winners).toEqual(["p1"]);
  });

  it("élimine par blessures de commandant", () => {
    let g = game("freeForAll", 2);
    const cmd = g.players.p1!.zones.command[0]!;
    g = act(g, "p1", { type: "adjustCommanderDamage", playerId: "p2", commanderId: cmd, delta: 21 });
    expect(evaluateOutcome(g).eliminated.p2).toBe("blessures de commandant");
  });
});

describe("Géant à deux têtes", () => {
  it("partage points de vie, poison et blessures de commandant", () => {
    let g = game("twoHeadedGiant", 4);
    expect(g.turnOrder).toEqual(["p1", "p2", "p3", "p4"]);
    expect(g.players.p3!.life).toBe(60);
    g = act(g, "p1", { type: "adjustLife", playerId: "p3", delta: -7 });
    expect([g.players.p3!.life, g.players.p4!.life]).toEqual([53, 53]);
    expect(g.log.at(-1)!.message).toBe("Chloé et David perdent 7 PV (53).");
    const cmd = g.players.p1!.zones.command[0]!;
    g = act(g, "p1", { type: "adjustCommanderDamage", playerId: "p4", commanderId: cmd, delta: 5 });
    expect(g.players.p3!.commanderDamage[cmd]).toBe(5);
    expect(g.players.p3!.life).toBe(48);
    g = act(g, "p1", { type: "adjustPoison", playerId: "p4", delta: 14 });
    expect(evaluateOutcome(g).winners).toBeNull();
    g = act(g, "p1", { type: "adjustPoison", playerId: "p4", delta: 1 });
    expect(evaluateOutcome(g).winners).toEqual(["p1", "p2"]);
  });

  it("fait jouer les coéquipiers ensemble", () => {
    let g = game("twoHeadedGiant", 4);
    g = act(g, "p2", { type: "passTurn" });
    expect(g.turn.activePlayerId).toBe("p3");
    expect(refuse(g, "p1", { type: "passTurn" })).toMatch(/pas ton tour/);
    g = act(g, "p4", { type: "passTurn" });
    expect(g.turn.activePlayerId).toBe("p1");
    expect(g.log.map((l) => l.message)).toContain("Tour 3 : c'est à Alice et Bruno.");
  });

  it("montre la main du coéquipier, pas celle des adversaires", () => {
    const g = game("twoHeadedGiant", 4);
    const view = viewFor(g, "p1");
    expect(view.players.p2!.zones.hand.every((c) => !c.hidden)).toBe(true);
    expect(view.players.p3!.zones.hand.every((c) => c.hidden)).toBe(true);
  });

  it("fait abandonner toute l'équipe", () => {
    let g = game("twoHeadedGiant", 4);
    g = act(g, "p1", { type: "concede" });
    expect(g.players.p2!.hasConceded).toBe(true);
    expect(g.turn.activePlayerId).toBe("p3");
    expect(evaluateOutcome(g).winners).toEqual(["p3", "p4"]);
  });
});

describe("Étoile", () => {
  it("désigne les deux ennemis non adjacents et le vainqueur", () => {
    let g = game("star", 5);
    expect(starEnemies(g, "p1")).toEqual(["p3", "p4"]);
    g = act(g, "p1", { type: "concede" });
    g = act(g, "p2", { type: "adjustLife", playerId: "p4", delta: -40 });
    expect(evaluateOutcome(g).winners).toBeNull();
    // p2 a pour ennemis p4 et p5.
    g = act(g, "p2", { type: "adjustLife", playerId: "p5", delta: -40 });
    expect(evaluateOutcome(g).winners).toEqual(["p2"]);
  });
});

describe("Archenemy", () => {
  const schemes = Array.from({ length: 20 }, (_, i) => fakeCard(`Scheme ${i}`, { typeLine: "Scheme" }));

  it("fait jouer l'archenemy en premier contre une équipe", () => {
    let g = game("archenemy", 4, { archenemyId: "p3", players: NAMES.slice(0, 4).map((name, i) => ({
      id: `p${i + 1}`,
      name,
      deck: fakeDeck(name),
      ...(i === 2 ? { schemes } : {}),
    })) });
    expect(g.turnOrder[0]).toBe("p3");
    expect(g.teams).toEqual([["p3"], ["p1", "p2", "p4"]]);
    expect(g.players.p3!.life).toBe(80);
    expect(g.players.p1!.life).toBe(40);
    expect(g.players.p3!.zones.schemes).toHaveLength(20);

    g = act(g, "p3", { type: "setSchemeInMotion" });
    expect(g.players.p3!.zones.command).toHaveLength(2);
    expect(g.log.at(-1)!.message).toMatch(/met en marche la machination Scheme \d+/);
    expect(refuse(g, "p1", { type: "setSchemeInMotion" })).toMatch(/archenemy/);

    g = act(g, "p3", { type: "passTurn" });
    expect(g.turn.activePlayerId).toBe("p1");
    g = act(g, "p4", { type: "passTurn" });
    expect(g.turn.activePlayerId).toBe("p3");

    // La pioche de machinations reste cachée, même pour l'archenemy.
    expect(viewFor(g, "p3").players.p3!.zones.schemes.every((c) => c.hidden && c.instanceId === null)).toBe(true);
  });
});

describe("Planechase", () => {
  const planes = Array.from({ length: 10 }, (_, i) => fakeCard(`Plane ${i}`, { typeLine: "Plane — Test" }));

  it("révèle un premier plan et change de plan", () => {
    let g = game("freeForAll", 3, { planarDeck: planes });
    expect(g.settings.planechase).toBe(true);
    expect(g.plane).toHaveLength(1);
    expect(g.planarDeck).toHaveLength(9);
    const first = g.cards[g.plane[0]!]!.cardId;
    g = act(g, "p2", { type: "planeswalk" });
    expect(g.plane).toHaveLength(1);
    expect(g.cards[g.plane[0]!]!.cardId).not.toBe(first);
    expect(g.cards[g.planarDeck.at(-1)!]!.cardId).toBe(first);
    const view = viewFor(g, "p1");
    expect(view.plane[0]!.hidden).toBe(false);
    // Tout le monde sait que l'ancien plan est au-dessous de la pioche.
    expect(view.planarDeck.slice(0, -1).every((c) => c.hidden)).toBe(true);
    expect(view.planarDeck.at(-1)!.hidden).toBe(false);
  });

  it("lance le dé planaire avec un coût croissant", () => {
    let g = game("freeForAll", 2, { planarDeck: planes });
    const results = new Set<string>();
    for (let i = 0; i < 30; i++) {
      g = act(g, "p1", { type: "rollPlanarDie" });
      const roll = g.log.filter((l) => l.message.includes("dé planaire")).at(-1)!.message;
      results.add(/: (planeswalk|chaos|rien)/.exec(roll)![1]!);
    }
    expect(results).toEqual(new Set(["planeswalk", "chaos", "rien"]));
    expect(g.log.some((l) => l.message.includes("(coût : {29})"))).toBe(true);
    g = act(g, "p1", { type: "passTurn" });
    expect(g.turn.planarDieRolls).toBe(0);
  });

  it("refuse le dé planaire sans la variante", () => {
    expect(refuse(game("freeForAll", 2), "p1", { type: "rollPlanarDie" })).toMatch(/Planechase/);
  });
});
