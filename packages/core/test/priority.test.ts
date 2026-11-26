import { describe, expect, it } from "vitest";
import { applyAction } from "../src/reducer.js";
import type { GameAction } from "../src/actions.js";
import { createGame } from "../src/setup.js";
import { viewFor } from "../src/view.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, fakeDeck, newTestGame } from "./helpers.js";

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

/** Lance la première carte de la main du joueur, en lui donnant les données de `card`. */
function cast(g: GameState, playerId: string, card: CardData): [GameState, string] {
  const id = g.players[playerId]!.zones.hand[0]!;
  g = structuredClone(g);
  const cardId = g.cards[id]!.cardId;
  g.cardData[cardId] = { ...card, id: cardId };
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "stack", force: true });
  return [g, id];
}

const bolt = fakeCard("Lightning Bolt", { typeLine: "Instant" });
const bear = fakeCard("Grizzly Bears", { typeLine: "Creature — Bear" });

describe("Priorité et pile", () => {
  it("personne n'a la priorité quand la pile est vide", () => {
    const g = newTestGame(3);
    expect(g.priority).toBeNull();
    expect(refuse(g, "p1", { type: "passPriority" })).toMatch(/pile est vide/);
  });

  it("le lanceur reçoit la priorité, puis elle tourne ; la pile se résout quand tout le monde a passé", () => {
    let g = newTestGame(3);
    g = act(g, "p1", { type: "nextStep", to: "main1" });
    let bearId: string;
    [g, bearId] = cast(g, "p1", bear);
    expect(g.priority).toEqual({ playerId: "p1", passed: [] });
    expect(refuse(g, "p1", { type: "nextStep" })).toMatch(/pile n'est pas vide/);
    expect(refuse(g, "p2", { type: "passPriority" })).toMatch(/C'est à Alice/);
    g = act(g, "p1", { type: "passPriority" });
    expect(g.priority!.playerId).toBe("p2");
    g = act(g, "p2", { type: "passPriority" });
    g = act(g, "p3", { type: "passPriority" });
    expect(g.stack).toEqual([]);
    expect(g.priority).toBeNull();
    expect(g.players.p1!.zones.battlefield).toContain(bearId);
    expect(g.log.at(-1)!.message).toMatch(/Grizzly Bears se résout et arrive sur le champ de bataille/);
  });

  it("une réponse redonne la priorité à son lanceur et la pile se résout dans l'ordre", () => {
    let g = newTestGame(3);
    let bearId: string, boltId: string;
    [g, bearId] = cast(g, "p1", bear);
    g = act(g, "p1", { type: "passPriority" });
    [g, boltId] = cast(g, "p2", bolt);
    expect(g.stack).toEqual([bearId, boltId]);
    expect(g.priority).toEqual({ playerId: "p2", passed: [] });
    g = act(g, "p2", { type: "passPriority" });
    g = act(g, "p3", { type: "passPriority" });
    g = act(g, "p1", { type: "passPriority" });
    // L'éclair se résout en premier ; la priorité revient au joueur actif.
    expect(g.stack).toEqual([bearId]);
    expect(g.players.p2!.zones.graveyard).toContain(boltId);
    expect(g.priority).toEqual({ playerId: "p1", passed: [] });
  });

  it("retirer une carte de la pile à la main (contresort) redonne la priorité au joueur actif", () => {
    let g = newTestGame(3);
    let bearId: string;
    [g, bearId] = cast(g, "p1", bear);
    g = act(g, "p1", { type: "passPriority" });
    [g] = cast(g, "p2", bolt);
    g = act(g, "p2", { type: "moveCard", cardId: bearId, to: "graveyard" });
    expect(g.priority).toEqual({ playerId: "p1", passed: [] });
  });

  it("en tours partagés, l'équipe passe la priorité en bloc", () => {
    const names = ["Alice", "Bruno", "Chloé", "David"];
    let g = createGame({
      id: "t",
      seed: 1,
      mode: "twoHeadedGiant",
      randomTurnOrder: false,
      players: names.map((name, i) => ({ id: `p${i + 1}`, name, deck: fakeDeck(name), priorityStops: [] })),
    });
    const [a, b] = g.teams[0]!;
    const [c] = g.teams[1]!;
    [g] = cast(g, a!, bear);
    g = act(g, b!, { type: "passPriority" });
    expect(g.teams[1]).toContain(g.priority!.playerId);
    g = act(g, c!, { type: "passPriority" });
    expect(g.stack).toEqual([]);
  });

  it("un joueur qui abandonne ne bloque pas la pile", () => {
    let g = newTestGame(3);
    [g] = cast(g, "p1", bear);
    g = act(g, "p1", { type: "passPriority" });
    g = act(g, "p2", { type: "concede" });
    expect(g.priority!.playerId).not.toBe("p2");
    g = act(g, g.priority!.playerId, { type: "passPriority" });
    expect(g.stack).toEqual([]);
  });

  it("la vue indique qui a la priorité", () => {
    let g = newTestGame(3);
    [g] = cast(g, "p1", bear);
    expect(viewFor(g, "p2").priority).toEqual({ playerId: "p1", passed: [] });
  });
});
