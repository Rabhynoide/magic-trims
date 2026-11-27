import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { endTurn, fakeCard, newTestGame } from "./helpers.js";
import deck from "./jodah-oracle.json" with { type: "json" };

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

function real(name: string): CardData {
  const c = (deck as CardData[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, { typeLine: c.typeLine, oracleText: c.oracleText ?? "", manaCost: c.manaCost ?? "", manaValue: c.manaValue, colors: c.colors });
}

function put(g: GameState, playerId: string, card: CardData): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[0]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  return [act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true }), id];
}

const waiting = (g: GameState) =>
  g.stack.some((id) => g.cards[id]!.ability?.awaitingDecision || g.cards[id]!.ability?.needsTargets || g.cards[id]!.cardChoice);

function resolveAll(g: GameState): GameState {
  for (let i = 0; i < 100 && g.priority && g.stack.length > 0 && !waiting(g); i++) g = act(g, g.priority.playerId, { type: "passPriority" });
  return g;
}

function decide(g: GameState, accept: boolean): GameState {
  const card = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.awaitingDecision)!;
  return resolveAll(act(g, card.controllerId, { type: "decideOptional", cardId: card.instanceId, accept }));
}

/** La carte (ses données) : un objet qui va dans la bibliothèque change d'identifiant. */
const data = (g: GameState, id: string) => g.cards[id]!.cardId;
const topData = (g: GameState, n: number) => g.players.p1!.zones.library.slice(0, n).map((id) => data(g, id));
const inHandData = (g: GameState, d: string) => g.players.p1!.zones.hand.some((id) => data(g, id) === d);

const choosing = (g: GameState) => g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice)!;

/** Pose Sylvan Library et va jusqu'à l'étape de pioche suivante de p1 (déclencheur sur la pile). */
function toLibraryTrigger(): GameState {
  let g = newTestGame(2);
  [g] = put(g, "p1", real("Sylvan Library"));
  // Au premier tour, Alice ne pioche pas : on refuse la Bibliothèque.
  g = endTurn(g, "p1");
  expect(g.turn).toMatchObject({ activePlayerId: "p1", step: "draw" });
  g = decide(resolveAll(g), false);
  g = endTurn(g, "p1");
  g = endTurn(g, "p2");
  if (g.turn.step === "upkeep") g = act(g, "p1", { type: "nextStep" });
  expect(g.turn).toMatchObject({ activePlayerId: "p1", step: "draw" });
  return resolveAll(g);
}

describe("Sylvan Library (famille 20)", () => {
  it("est entièrement gérée", () => {
    expect(cardSupport(real("Sylvan Library")).level).toBe("full");
  });

  it("pioche deux de plus, en garde une pour 4 PV et remet l'autre dessus", () => {
    let g = toLibraryTrigger();
    const hand = g.players.p1!.zones.hand.length;
    const ordinary = g.players.p1!.drawnThisTurn!.ids;
    expect(ordinary).toHaveLength(1);
    g = decide(g, true);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 2);
    // Trois cartes piochées ce tour : on en choisit deux.
    let pick = choosing(g);
    expect(pick.cardChoice!.options).toHaveLength(3);
    expect(pick.cardChoice!.min).toBe(2);
    const [a, b] = [pick.cardChoice!.options[1]!, pick.cardChoice!.options[2]!];
    const [da, db] = [data(g, a), data(g, b)];
    // Une carte d'avant ce tour n'est pas proposée.
    expect(pick.cardChoice!.options).not.toContain(g.players.p1!.zones.hand[0]);
    g = act(g, "p1", { type: "chooseCards", cardId: pick.instanceId, cardIds: [a, b] });
    pick = choosing(g);
    expect(pick.cardChoice).toMatchObject({ min: 0, max: 2 });
    g = resolveAll(act(g, "p1", { type: "chooseCards", cardId: pick.instanceId, cardIds: [a] }));
    expect(g.stack).toEqual([]);
    expect(g.players.p1!.life).toBe(36);
    expect(g.cards[a]!.zone).toBe("hand");
    expect(inHandData(g, db)).toBe(false);
    expect(topData(g, 1)).toEqual([db]);
    expect(da).not.toBe(db);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 1);
  });

  it("remet les deux cartes dessus sans payer, la première choisie au-dessus", () => {
    let g = toLibraryTrigger();
    g = decide(g, true);
    let pick = choosing(g);
    const [a, b] = [pick.cardChoice!.options[0]!, pick.cardChoice!.options[2]!];
    const [da, db] = [data(g, a), data(g, b)];
    g = act(g, "p1", { type: "chooseCards", cardId: pick.instanceId, cardIds: [a, b] });
    pick = choosing(g);
    g = resolveAll(act(g, "p1", { type: "chooseCards", cardId: pick.instanceId, cardIds: [] }));
    expect(g.players.p1!.life).toBe(40);
    expect(topData(g, 2)).toEqual([da, db]);
  });

  it("sans assez de points de vie, les cartes reviennent toutes dessus", () => {
    let g = toLibraryTrigger();
    g = structuredClone(g);
    g.players.p1!.life = 3;
    g = decide(g, true);
    const pick = choosing(g);
    const [a, b] = pick.cardChoice!.options.slice(0, 2) as [string, string];
    const [da, db] = [data(g, a), data(g, b)];
    g = resolveAll(act(g, "p1", { type: "chooseCards", cardId: pick.instanceId, cardIds: [a, b] }));
    expect(g.stack).toEqual([]);
    expect(g.players.p1!.life).toBe(3);
    expect(topData(g, 2)).toEqual([da, db]);
  });

  it("refusée, il ne se passe rien", () => {
    let g = toLibraryTrigger();
    const hand = g.players.p1!.zones.hand.length;
    g = decide(g, false);
    expect(g.stack).toEqual([]);
    expect(g.players.p1!.zones.hand.length).toBe(hand);
    expect(g.players.p1!.life).toBe(40);
  });
});
