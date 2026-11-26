import { describe, expect, it } from "vitest";
import { applyAction } from "../src/reducer.js";
import type { GameAction } from "../src/actions.js";
import { createGame, upgradeGame } from "../src/setup.js";
import type { GameModeType, GameState } from "../src/types.js";
import { fakeDeck, newTestGame } from "./helpers.js";

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

function game(mode: GameModeType, count: number): GameState {
  const names = ["Alice", "Bruno", "Chloé", "David"];
  return createGame({
    id: "t",
    seed: 1,
    mode,
    randomTurnOrder: false,
    players: names.slice(0, count).map((name, i) => ({ id: `p${i + 1}`, name, deck: fakeDeck(name), priorityStops: [] })),
  });
}

describe("Tours et phases", () => {
  it("commence à l'entretien du premier joueur", () => {
    const g = newTestGame();
    expect(g.turn).toMatchObject({ number: 1, activePlayerId: "p1", step: "upkeep" });
  });

  it("pioche automatiquement à l'étape de pioche, et tout le monde pioche au premier tour en multijoueur", () => {
    let g = newTestGame();
    const top = g.players.p1!.zones.library[0]!;
    g = act(g, "p1", { type: "nextStep" });
    expect(g.turn.step).toBe("draw");
    expect(g.players.p1!.zones.hand).toHaveLength(8);
    expect(g.players.p1!.zones.hand).toContain(top);
    g = act(g, "p1", { type: "nextStep" });
    expect(g.turn.step).toBe("main1");
    expect(g.players.p1!.zones.hand).toHaveLength(8);
  });

  it("le premier joueur ne pioche pas au premier tour d'un duel", () => {
    let g = game("duel", 2);
    g = act(g, "p1", { type: "nextStep" });
    expect(g.players.p1!.zones.hand).toHaveLength(7);
    expect(g.log.map((l) => l.message).join("\n")).toMatch(/ne pioche pas au premier tour/);
    g = act(g, "p1", { type: "passTurn" });
    expect(g.turn).toMatchObject({ number: 2, activePlayerId: "p2", step: "upkeep" });
    g = act(g, "p2", { type: "nextStep" });
    expect(g.players.p2!.zones.hand).toHaveLength(8);
  });

  it("saute plusieurs étapes en faisant les actions obligatoires", () => {
    let g = newTestGame();
    g = act(g, "p1", { type: "nextStep", to: "beginCombat" });
    expect(g.turn.step).toBe("beginCombat");
    expect(g.players.p1!.zones.hand).toHaveLength(8);
    expect(refuse(g, "p1", { type: "nextStep", to: "main1" })).toMatch(/arrière/);
    expect(refuse(g, "p2", { type: "nextStep" })).toMatch(/pas ton tour/);
  });

  it("dégage les permanents du joueur suivant au début de son tour", () => {
    let g = newTestGame();
    g = act(g, "p2", { type: "moveCard", cardId: g.players.p2!.zones.hand[0]!, to: "battlefield", force: true, tapped: true });
    g = act(g, "p1", { type: "moveCard", cardId: g.players.p1!.zones.hand[0]!, to: "battlefield", force: true, tapped: true });
    const mine = g.players.p1!.zones.battlefield[0]!;
    const theirs = g.players.p2!.zones.battlefield[0]!;
    g = act(g, "p1", { type: "passTurn" });
    expect(g.turn).toMatchObject({ number: 2, activePlayerId: "p2", step: "upkeep" });
    expect(g.cards[theirs]!.tapped).toBe(false);
    expect(g.cards[mine]!.tapped).toBe(true);
  });

  it("passe au joueur suivant après le nettoyage, et rappelle la taille maximale de main", () => {
    let g = newTestGame();
    g = act(g, "p1", { type: "nextStep", to: "cleanup" });
    expect(g.log.map((l) => l.message).join("\n")).toMatch(/Alice a 8 cartes en main et doit en défausser 1/);
    g = act(g, "p1", { type: "nextStep" });
    expect(g.turn).toMatchObject({ number: 2, activePlayerId: "p2", step: "upkeep" });
  });

  it("en Géant à deux têtes, l'équipe qui commence ne pioche pas et les coéquipiers piochent ensemble ensuite", () => {
    let g = game("twoHeadedGiant", 4);
    const [a, b] = g.teams[0]!;
    g = act(g, b!, { type: "nextStep" });
    expect(g.players[a!]!.zones.hand).toHaveLength(7);
    g = act(g, a!, { type: "passTurn" });
    const [c, d] = g.teams.find((t) => t.includes(g.turn.activePlayerId))!;
    g = act(g, c!, { type: "nextStep" });
    expect(g.players[c!]!.zones.hand).toHaveLength(8);
    expect(g.players[d!]!.zones.hand).toHaveLength(8);
  });

  it("sans automatismes, le tour avance sans piocher ni dégager", () => {
    let g = createGame({
      id: "t",
      seed: 1,
      randomTurnOrder: false,
      settings: { autoTurnActions: false },
      players: ["A", "B", "C"].map((name, i) => ({ id: `p${i + 1}`, name, deck: fakeDeck(name), priorityStops: [] })),
    });
    g = act(g, "p1", { type: "nextStep" });
    expect(g.players.p1!.zones.hand).toHaveLength(7);
  });

  it("met à niveau une partie sauvegardée sans étapes", () => {
    const g = newTestGame() as GameState & { turn: { step?: string } };
    delete (g.turn as { step?: string }).step;
    delete (g.settings as { autoTurnActions?: boolean }).autoTurnActions;
    const up = upgradeGame(g);
    expect(up.turn.step).toBe("main1");
    expect(up.settings.autoTurnActions).toBe(true);
  });
});
