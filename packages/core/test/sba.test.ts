import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { evaluateOutcome } from "../src/modes.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame } from "./helpers.js";

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

/** Met une carte de la main du joueur sur le champ de bataille avec les données voulues. */
function put(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  const cardId = g.cards[id]!.cardId;
  g.cardData[cardId] = { ...card, id: cardId };
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  return [g, id];
}

const messages = (g: GameState) => g.log.map((l) => l.message);
const bear = (name = "Bear", extra: Partial<CardData> = {}) =>
  fakeCard(name, { typeLine: "Creature — Bear", power: "2", toughness: "2", ...extra });

describe("Actions d'état", () => {
  it("un joueur à 0 PV perd : ses cartes quittent la partie et le tour passe", () => {
    let g = newTestGame(3);
    let mine: string;
    [g, mine] = put(g, "p1", bear());
    let stolen: string;
    [g, stolen] = put(g, "p2", bear("Thief"));
    g = act(g, "p2", { type: "changeControl", cardId: stolen, controllerId: "p1" });
    g = act(g, "p2", { type: "adjustLife", playerId: "p1", delta: -40 });
    expect(g.players.p1!.hasConceded).toBe(true);
    expect(g.players.p1!.lostReason).toBe("points de vie");
    expect(messages(g)).toContain("Alice perd la partie (points de vie).");
    expect(g.cards[mine]!.zone).toBe("exile");
    expect(g.players.p1!.zones.hand).toHaveLength(0);
    expect(g.cards[stolen]).toMatchObject({ zone: "battlefield", controllerId: "p2" });
    expect(g.turn.activePlayerId).toBe("p2");
    expect(evaluateOutcome(g).winners).toBeNull();
  });

  it("le dernier joueur en lice gagne quand l'autre perd", () => {
    let g = newTestGame(2);
    g = act(g, "p1", { type: "adjustPoison", playerId: "p2", delta: 10 });
    expect(evaluateOutcome(g)).toMatchObject({ winners: ["p1"] });
    expect(messages(g)).toContain("Bruno perd la partie (poison).");
  });

  it("piocher dans une bibliothèque vide fait perdre", () => {
    let g = newTestGame(3);
    g = act(g, "p2", { type: "draw", count: 200 });
    expect(g.players.p2!.lostReason).toBe("bibliothèque vide");
  });

  it("règle des légendes : on garde le plus récent", () => {
    let g = newTestGame(2);
    const legend = fakeCard("Hero", { typeLine: "Legendary Creature — Human", power: "1", toughness: "1" });
    let first: string, second: string;
    [g, first] = put(g, "p1", legend, 0);
    [g, second] = put(g, "p1", legend, 0);
    expect(g.cards[first]!.zone).toBe("graveyard");
    expect(g.cards[second]!.zone).toBe("battlefield");
    // Un autre joueur peut avoir le même légendaire.
    let theirs: string;
    [g, theirs] = put(g, "p2", legend);
    expect(g.cards[theirs]!.zone).toBe("battlefield");
  });

  it("un planeswalker entre avec sa loyauté et meurt à 0", () => {
    let g = newTestGame(2);
    let pw: string;
    [g, pw] = put(g, "p1", fakeCard("Walker", { typeLine: "Legendary Planeswalker — Test", loyalty: "3" }));
    expect(g.cards[pw]!.counters["loyauté"]).toBe(3);
    g = act(g, "p1", { type: "adjustCardCounter", cardId: pw, kind: "loyauté", delta: -3 });
    expect(g.cards[pw]!.zone).toBe("graveyard");
  });

  it("une aura tombe quand sa cible quitte le champ de bataille", () => {
    let g = newTestGame(2);
    let target: string, aura: string;
    [g, target] = put(g, "p1", bear());
    [g, aura] = put(g, "p1", fakeCard("Aura", { typeLine: "Enchantment — Aura" }));
    g = act(g, "p1", { type: "attach", cardId: aura, targetId: target });
    g = act(g, "p1", { type: "moveCard", cardId: target, to: "hand" });
    expect(g.cards[aura]!.zone).toBe("graveyard");
  });

  it("les marqueurs +1/+1 et -1/-1 s'annulent, l'endurance 0 tue", () => {
    let g = newTestGame(2);
    let id: string;
    [g, id] = put(g, "p1", bear());
    g = act(g, "p1", { type: "adjustCardCounter", cardId: id, kind: "+1/+1", delta: 2 });
    g = act(g, "p1", { type: "adjustCardCounter", cardId: id, kind: "-1/-1", delta: 3 });
    expect(g.cards[id]!.counters).toEqual({ "-1/-1": 1 });
    g = act(g, "p1", { type: "adjustCardCounter", cardId: id, kind: "-1/-1", delta: 1 });
    expect(g.cards[id]!.zone).toBe("graveyard");
  });

  it("ne tue pas une créature à l'endurance inconnue", () => {
    let g = newTestGame(2);
    let id: string;
    [g, id] = put(g, "p1", bear("Goyf", { toughness: "1+*" }));
    expect(g.cards[id]!.zone).toBe("battlefield");
  });

  it("un commandant au cimetière retourne dans la zone de commandement", () => {
    let g = newTestGame(2);
    const cmd = g.players.p1!.zones.command[0]!;
    g = act(g, "p1", { type: "moveCard", cardId: cmd, to: "battlefield", force: true });
    g = act(g, "p1", { type: "moveCard", cardId: cmd, to: "graveyard" });
    expect(g.cards[cmd]!.zone).toBe("command");
  });

  it("sans « faire respecter les règles », seules les blessures mortelles s'appliquent", () => {
    let g = newTestGame(2);
    g.settings.enforceRules = false;
    g = act(g, "p1", { type: "adjustLife", playerId: "p2", delta: -40 });
    expect(g.players.p2!.hasConceded).toBe(false);
    const legend = fakeCard("Hero", { typeLine: "Legendary Creature — Human", power: "1", toughness: "1" });
    let first: string;
    [g, first] = put(g, "p1", legend, 0);
    [g] = put(g, "p1", legend, 0);
    expect(g.cards[first]!.zone).toBe("battlefield");
  });
});
