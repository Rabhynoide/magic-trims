import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { chooseBotAction } from "../src/bot.js";
import { creatureStats, hasKeyword } from "../src/combat.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame, endTurn } from "./helpers.js";
import deck from "./ashling-oracle.json" with { type: "json" };

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

type OracleCard = { name: string; typeLine: string; oracleText?: string; manaCost?: string; power?: string; toughness?: string; loyalty?: string };

/** Une carte du deck Ashling, avec son texte Oracle exact. */
function real(name: string, extra: Partial<CardData> = {}): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, {
    typeLine: c.typeLine,
    oracleText: c.oracleText ?? "",
    manaCost: c.manaCost ?? "",
    ...(c.power ? { power: c.power, toughness: c.toughness } : {}),
    ...(c.loyalty ? { loyalty: c.loyalty } : {}),
    ...extra,
  });
}

/** Met une carte de la main du joueur sur le champ de bataille (sans mal d'invocation). */
function put(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  delete g.cards[id]!.summoningSick;
  return [g, id];
}

/** Donne à une carte de la main les données voulues (elle reste en main). */
function inHand(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  return [g, id];
}

function resolveAll(g: GameState, max = 100): GameState {
  for (let i = 0; i < max && g.priority && g.stack.length > 0; i++) {
    if (g.stack.some((id) => g.cards[id]!.ability?.awaitingDecision || g.cards[id]!.ability?.needsTargets || g.cards[id]!.cardChoice)) break;
    g = act(g, g.priority.playerId, { type: "passPriority" });
  }
  return g;
}

function mana(g: GameState, playerId: string, pool: string): GameState {
  for (const m of pool.match(/[WUBRGC]/g) ?? []) g = act(g, playerId, { type: "adjustMana", mana: m as "B", delta: 1 });
  return g;
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const bear = (name = "Bear") => fakeCard(name, { typeLine: "Creature — Bear", power: "2", toughness: "2", manaCost: "{1}{G}" });


describe("Deck Ashling : évocation", () => {
  it("Mulldrifter évoquée pioche deux cartes puis est sacrifiée", () => {
    let g = toMain(newTestGame(2));
    let drifter: string;
    [g, drifter] = inHand(g, "p1", real("Mulldrifter"));
    g = mana(g, "p1", "UCC");
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "castSpell", cardId: drifter, evoke: true });
    g = resolveAll(g);
    expect(g.players.p1!.zones.graveyard).toContain(drifter);
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1 + 2);
  });

  it("Endurance s'évoque en exilant une carte verte de sa main", () => {
    let g = toMain(newTestGame(2));
    let endurance: string, green: string, red: string;
    [g, endurance] = inHand(g, "p1", real("Endurance"));
    [g, green] = inHand(g, "p1", fakeCard("Ours vert", { typeLine: "Creature — Bear", colors: ["G"], manaCost: "{1}{G}" }), 1);
    [g, red] = inHand(g, "p1", fakeCard("Gobelin", { typeLine: "Creature — Goblin", colors: ["R"], manaCost: "{R}" }), 2);
    expect(refuse(g, "p1", { type: "castSpell", cardId: endurance, evoke: true, evokeExile: red })).toMatch(/verte/);
    g = act(g, "p1", { type: "castSpell", cardId: endurance, evoke: true, evokeExile: green });
    expect(g.players.p1!.zones.exile).toContain(green);
    g = resolveAll(g);
    expect(g.players.p1!.zones.graveyard).toContain(endurance);
  });

  it("Ashling donne l'évocation {4} et copie l'Élémental sacrifié, qui part à la fin du tour sans paiement", () => {
    let g = toMain(newTestGame(2));
    let ashling: string, drifter: string;
    [g, ashling] = put(g, "p1", real("Ashling, the Limitless"));
    [g, drifter] = inHand(g, "p1", real("Mulldrifter"), 1);
    g = mana(g, "p1", "CCCC");
    g = act(g, "p1", { type: "castSpell", cardId: drifter, evoke: "granted" });
    g = resolveAll(g);
    expect(g.players.p1!.zones.graveyard).toContain(drifter);
    const token = g.players.p1!.zones.battlefield.find((id) => g.cards[id]!.isToken);
    expect(token && g.cardData[g.cards[token]!.cardId]!.name).toBe("Mulldrifter");
    expect(hasKeyword(g, g.cards[token!]!, "Haste")).toBe(true);
    g = act(g, "p1", { type: "nextStep", to: "end" });
    g = resolveAll(g);
    const upkeep = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.awaitingDecision);
    expect(upkeep).toBeDefined();
    g = act(g, "p1", { type: "decideOptional", cardId: upkeep!.instanceId, accept: false });
    g = resolveAll(g);
    expect(g.players.p1!.zones.battlefield).not.toContain(token);
    // Le jeton sacrifié n'est pas recopié (« nontoken »).
    expect(g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken)).toHaveLength(0);
    void ashling;
    for (const name of ["Ashling, the Limitless", "Mulldrifter", "Shriekmaw", "Foundation Breaker", "Ingot Chewer"]) {
      expect(cardSupport(real(name)).level, name).not.toBe("manual");
    }
    expect(cardSupport(real("Ashling, the Limitless")).level).toBe("full");
  });
});
