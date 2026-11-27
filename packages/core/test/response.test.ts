import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { chooseBotAction } from "../src/bot.js";
import { applyAction } from "../src/reducer.js";
import type { GameState } from "../src/types.js";
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

/** Trois joueurs qui s'arrêtent aux étapes clés ; la partie démarre à l'entretien d'Alice. */
function game(): GameState {
  const g = newTestGame(3, 42, true);
  g.turn.step = "upkeep";
  return g;
}

describe("Réponses pendant le tour des autres", () => {
  it("les autres reçoivent la priorité avant que le joueur actif avance, puis le tour avance", () => {
    let g = game();
    g = act(g, "p1", { type: "nextStep" });
    expect(g.turn.step).toBe("upkeep");
    expect(g.priority).toMatchObject({ playerId: "p2", pending: { type: "nextStep", to: "draw" } });
    expect(refuse(g, "p1", { type: "nextStep" })).toMatch(/Bruno peut encore répondre/);
    expect(refuse(g, "p3", { type: "passPriority" })).toMatch(/C'est à Bruno/);
    g = act(g, "p2", { type: "passPriority" });
    expect(g.priority!.playerId).toBe("p3");
    g = act(g, "p3", { type: "passPriority" });
    expect(g.turn.step).toBe("draw");
    expect(g.priority).toBeNull();
  });

  it("ne s'arrête qu'aux étapes choisies par chaque joueur, sans regarder sa main", () => {
    let g = game();
    g = act(g, "p2", { type: "setPriorityStops", stops: ["end"] });
    g = act(g, "p3", { type: "setPriorityStops", stops: [] });
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    expect(g.turn.step).toBe("main2");
    expect(g.priority).toBeNull();
    g = act(g, "p1", { type: "passTurn" });
    // Bruno s'arrête à l'étape de fin, même sans éphémère en main.
    expect(g.turn.step).toBe("end");
    expect(g.priority).toMatchObject({ playerId: "p2", pending: { type: "passTurn" } });
    g = act(g, "p2", { type: "passPriority" });
    // Alice a 8 cartes : le tour s'arrête au nettoyage le temps qu'elle défausse.
    expect(g.turn.step).toBe("cleanup");
    g = act(g, "p1", { type: "discardToHandSize", cardIds: [g.players.p1!.zones.hand[0]!] });
    expect(g.turn.activePlayerId).toBe("p2");
    expect(refuse(g, "p2", { type: "setPriorityStops", stops: ["main1"] })).toMatch(/étapes clés/);
  });

  it("répondre avec un éphémère annule l'avancée : le joueur actif reprend la main", () => {
    let g = game();
    g = act(g, "p1", { type: "nextStep" });
    g = structuredClone(g);
    const id = g.players.p2!.zones.hand[0]!;
    g.cardData[g.cards[id]!.cardId] = { ...fakeCard("Bolt", { typeLine: "Instant", manaCost: "" }), id: g.cards[id]!.cardId };
    g = act(g, "p2", { type: "castSpell", cardId: id });
    expect(g.priority).toEqual({ playerId: "p2", passed: [] });
    for (const p of ["p2", "p3", "p1"]) g = act(g, p, { type: "passPriority" });
    expect(g.stack).toEqual([]);
    expect(g.turn.step).toBe("upkeep");
    expect(g.priority).toBeNull();
    // Alice redemande d'avancer : nouvelle fenêtre.
    g = act(g, "p1", { type: "nextStep" });
    expect(g.priority!.playerId).toBe("p2");
  });

  it("en sautant plusieurs étapes, chaque étape clé traversée laisse répondre", () => {
    let g = newTestGame(2, 42, true);
    g.turn.step = "upkeep";
    g = act(g, "p1", { type: "nextStep", to: "main1" });
    expect(g.turn.step).toBe("upkeep");
    g = act(g, "p2", { type: "passPriority" });
    expect(g.turn.step).toBe("draw");
    expect(g.priority!.playerId).toBe("p2");
    g = act(g, "p2", { type: "passPriority" });
    expect(g.turn.step).toBe("main1");
    expect(g.priority).toBeNull();
  });

  it("sans « faire respecter les règles », personne n'est attendu", () => {
    let g = game();
    g.settings.enforceRules = false;
    g = act(g, "p1", { type: "nextStep" });
    expect(g.turn.step).toBe("draw");
  });

  it("un bot passe la priorité qu'on lui donne et attend les autres", () => {
    let g = game();
    g = act(g, "p1", { type: "nextStep" });
    expect(chooseBotAction(g, "p2")).toEqual({ type: "passPriority" });
    expect(chooseBotAction(g, "p1")).toBeNull();
  });
});
