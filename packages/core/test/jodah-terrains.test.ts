import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport, parseSpellEffects } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import { parseStaticLine } from "../src/statics.js";
import type { CardData, GameState } from "../src/types.js";
import { endTurn, fakeCard, newTestGame } from "./helpers.js";
import deck from "./jodah-oracle.json" with { type: "json" };

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

type OracleCard = { name: string; typeLine: string; oracleText?: string; manaCost?: string; power?: string; toughness?: string };

/** Une carte du deck Jodah, avec son texte Oracle exact. */
function real(name: string): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, {
    typeLine: c.typeLine,
    oracleText: c.oracleText ?? "",
    manaCost: c.manaCost ?? "",
    ...(c.power ? { power: c.power, toughness: c.toughness } : {}),
  });
}

/** Donne à la n-ième carte de la main les données voulues (elle reste en main). */
function inHand(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  return [g, id];
}

/** Met une carte de la main sur le champ de bataille (sans mal d'invocation). */
function put(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  let id: string;
  [g, id] = inHand(g, playerId, card, n);
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  delete g.cards[id]!.summoningSick;
  g.cards[id]!.tapped = false;
  return [g, id];
}

const waiting = (g: GameState) =>
  g.stack.some((id) => g.cards[id]!.ability?.awaitingDecision || g.cards[id]!.ability?.needsTargets || g.cards[id]!.cardChoice || g.cards[id]!.scry);

function resolveAll(g: GameState, max = 100): GameState {
  for (let i = 0; i < max && g.priority && g.stack.length > 0 && !waiting(g); i++) g = act(g, g.priority.playerId, { type: "passPriority" });
  return g;
}

function mana(g: GameState, playerId: string, pool: string): GameState {
  for (const m of pool.match(/[WUBRGC]/g) ?? []) g = act(g, playerId, { type: "adjustMana", mana: m as "B", delta: 1 });
  return g;
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const forest = fakeCard("Forest", { typeLine: "Basic Land — Forest", oracleText: "({T}: Add {G}.)" });
const mountain = fakeCard("Mountain", { typeLine: "Basic Land — Mountain", oracleText: "({T}: Add {R}.)" });
const bear = fakeCard("Bear", { typeLine: "Creature — Bear", oracleText: "", manaCost: "{1}{G}", power: "2", toughness: "2" });

/** Toute la main de p1 devient des Forêts (sauf la première carte, laissée à part). */
function forestsInHand(g: GameState, from = 1): GameState {
  for (let n = from; n < g.players.p1!.zones.hand.length; n++) [g] = inHand(g, "p1", forest, n);
  return g;
}

describe("Deck Jodah : terrains engagés et terrains en plus", () => {
  it("les quatre cartes sont entièrement gérées", () => {
    for (const name of ["Dragonskull Summit", "Explore", "Aesi, Tyrant of Gyre Strait", "Growth Spiral"]) {
      expect(cardSupport(real(name)), name).toEqual({ level: "full", unknown: [] });
    }
  });

  it("lit les variantes « unless you control » des terrains", () => {
    expect(parseStaticLine("~ enters tapped unless you control a Plains or an Island.")).toEqual({ kind: "entersTapped", unlessControl: ["Plains", "Island"] });
    expect(parseStaticLine("~ enters tapped unless you control two or fewer other lands.")).toEqual({ kind: "entersTapped", unlessLandsAtMost: 2 });
    expect(parseStaticLine("~ enters tapped unless you control two or more other lands.")).toEqual({ kind: "entersTapped", unlessLandsAtLeast: 2 });
    expect(parseStaticLine("You may play two additional lands on each of your turns.")).toEqual({ kind: "extraLandPlays", count: 2 });
  });

  it("Dragonskull Summit arrive engagé sans Marais ni Montagne, dégagé sinon", () => {
    let g = toMain(newTestGame(2));
    let id: string;
    [g, id] = inHand(g, "p1", real("Dragonskull Summit"));
    g = act(g, "p1", { type: "playLand", cardId: id });
    expect(g.cards[g.players.p1!.zones.battlefield.at(-1)!]!.tapped).toBe(true);

    g = toMain(endTurn(endTurn(g, "p1"), "p2"));
    [g] = put(g, "p2", mountain); // la Montagne d'un adversaire ne compte pas
    [g, id] = inHand(g, "p1", real("Dragonskull Summit"));
    g = act(g, "p1", { type: "playLand", cardId: id });
    expect(g.cards[g.players.p1!.zones.battlefield.at(-1)!]!.tapped).toBe(true);

    g = toMain(endTurn(endTurn(g, "p1"), "p2"));
    [g] = put(g, "p1", mountain);
    [g, id] = inHand(g, "p1", real("Dragonskull Summit"));
    g = act(g, "p1", { type: "playLand", cardId: id });
    expect(g.cards[g.players.p1!.zones.battlefield.at(-1)!]!.tapped).toBe(false);
  });

  it("Explore : un terrain de plus ce tour seulement, et une carte piochée", () => {
    let g = toMain(newTestGame(2));
    g = forestsInHand(g);
    let id: string;
    [g, id] = inHand(g, "p1", real("Explore"));
    g = mana(g, "p1", "GG");
    const hand = g.players.p1!.zones.hand.length;
    g = resolveAll(act(g, "p1", { type: "castSpell", cardId: id }));
    expect(g.players.p1!.zones.hand.length).toBe(hand); // −Explore +1 pioche
    g = act(g, "p1", { type: "playLand", cardId: g.players.p1!.zones.hand[0]! });
    g = act(g, "p1", { type: "playLand", cardId: g.players.p1!.zones.hand[0]! });
    expect(refuse(g, "p1", { type: "playLand", cardId: g.players.p1!.zones.hand[0]! })).toMatch(/déjà joué 2 terrains/);

    g = toMain(endTurn(endTurn(g, "p1"), "p2"));
    g = forestsInHand(g, 0);
    g = act(g, "p1", { type: "playLand", cardId: g.players.p1!.zones.hand[0]! });
    expect(refuse(g, "p1", { type: "playLand", cardId: g.players.p1!.zones.hand[0]! })).toMatch(/déjà joué un terrain/);
  });

  it("Aesi : un terrain de plus à chacun de vos tours, et pioche sur atterrissage", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Aesi, Tyrant of Gyre Strait"));
    g = forestsInHand(g, 0);
    g = act(g, "p1", { type: "playLand", cardId: g.players.p1!.zones.hand[0]! });
    g = resolveAll(g);
    expect(g.stack.length).toBeGreaterThan(0); // « you may draw a card » attend la décision
  });

  it("Aesi : deux terrains par tour, pas trois", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", fakeCard("Aesi Static", { typeLine: "Creature — Serpent", oracleText: "You may play an additional land on each of your turns.", power: "5", toughness: "5" }));
    g = forestsInHand(g, 0);
    g = act(g, "p1", { type: "playLand", cardId: g.players.p1!.zones.hand[0]! });
    g = act(g, "p1", { type: "playLand", cardId: g.players.p1!.zones.hand[0]! });
    expect(refuse(g, "p1", { type: "playLand", cardId: g.players.p1!.zones.hand[0]! })).toMatch(/déjà joué 2 terrains/);
    g = toMain(endTurn(endTurn(g, "p1"), "p2"));
    g = forestsInHand(g, 0);
    g = act(g, "p1", { type: "playLand", cardId: g.players.p1!.zones.hand[0]! });
    g = act(g, "p1", { type: "playLand", cardId: g.players.p1!.zones.hand[0]! });
    expect(g.players.p1!.landsPlayed).toBe(2);
  });

  it("Growth Spiral : pioche d'abord, puis met un terrain de la main en jeu sans compter le terrain du tour", () => {
    expect(parseSpellEffects(real("Growth Spiral").oracleText, "Growth Spiral").effects).toEqual([{ type: "putFromHand", land: true, drawFirst: 1, haste: false, sacrificeAtEnd: false }]);
    let g = toMain(newTestGame(2));
    for (let n = 1; n < g.players.p1!.zones.hand.length; n++) [g] = inHand(g, "p1", bear, n);
    [g] = inHand(g, "p1", forest, 1);
    let id: string;
    [g, id] = inHand(g, "p1", real("Growth Spiral"));
    g = mana(g, "p1", "GU");
    const lands = g.players.p1!.zones.battlefield.length;
    g = resolveAll(act(g, "p1", { type: "castSpell", cardId: id }));
    const spell = g.cards[g.stack.at(-1)!]!;
    expect(spell.cardChoice?.options.length).toBeGreaterThanOrEqual(1);
    const land = spell.cardChoice!.options.find((o) => g.cardData[g.cards[o]!.cardId]!.name === "Forest")!;
    g = resolveAll(act(g, "p1", { type: "chooseCards", cardId: spell.instanceId, cardIds: [land] }));
    expect(g.players.p1!.zones.battlefield.length).toBe(lands + 1);
    expect(g.players.p1!.landsPlayed).toBe(0);
  });

  it("Growth Spiral : on peut ne mettre aucun terrain", () => {
    let g = toMain(newTestGame(2));
    g = forestsInHand(g);
    let id: string;
    [g, id] = inHand(g, "p1", real("Growth Spiral"));
    g = mana(g, "p1", "GU");
    g = resolveAll(act(g, "p1", { type: "castSpell", cardId: id }));
    const spell = g.cards[g.stack.at(-1)!]!;
    g = resolveAll(act(g, "p1", { type: "chooseCards", cardId: spell.instanceId, cardIds: [] }));
    expect(g.stack.length).toBe(0);
  });
});
