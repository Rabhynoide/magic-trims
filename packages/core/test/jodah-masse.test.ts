import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { hasKeyword } from "../src/combat.js";
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

type OracleCard = { name: string; typeLine: string; oracleText?: string; manaCost?: string; power?: string; toughness?: string; loyalty?: string };

/** Une carte du deck Jodah, avec son texte Oracle exact. */
function real(name: string): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, {
    typeLine: c.typeLine,
    oracleText: c.oracleText ?? "",
    manaCost: c.manaCost ?? "",
    ...(c.power ? { power: c.power, toughness: c.toughness } : {}),
    ...(c.loyalty ? { loyalty: c.loyalty } : {}),
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
const legend = (name = "Legend") => fakeCard(name, { typeLine: "Legendary Creature — Human", power: "2", toughness: "2", manaCost: "{1}{G}" });
const rock = fakeCard("Rock", { typeLine: "Artifact", manaCost: "{2}" });
const forest = fakeCard("Forest", { typeLine: "Basic Land — Forest" });

describe("Deck Jodah : exil de masse filtré (Urza's Ruinous Blast)", () => {
  it("exile tous les permanents non-terrain non légendaires, de tous les joueurs", () => {
    let g = toMain(newTestGame(2));
    let lg: string, myBear: string, land: string, theirBear: string, theirRock: string, spell: string;
    [g, lg] = put(g, "p1", legend());
    [g, myBear] = put(g, "p1", bear("My Bear"), 1);
    [g, land] = put(g, "p1", forest, 2);
    [g, theirBear] = put(g, "p2", bear("Their Bear"));
    [g, theirRock] = put(g, "p2", rock, 1);
    [g, spell] = inHand(g, "p1", real("Urza's Ruinous Blast"), 3);
    g = mana(g, "p1", "WCCCC");
    g = act(g, "p1", { type: "castSpell", cardId: spell });
    g = resolveAll(g);
    expect(g.cards[myBear]!.zone).toBe("exile");
    expect(g.cards[theirBear]!.zone).toBe("exile");
    expect(g.cards[theirRock]!.zone).toBe("exile");
    expect(g.cards[lg]!.zone).toBe("battlefield");
    expect(g.cards[land]!.zone).toBe("battlefield");
  });
});

describe("Deck Jodah : prendre le contrôle de tout (Dihada −11)", () => {
  it("prend le contrôle de tous les permanents non-terrain, les dégage, leur donne la célérité, puis les rend au nettoyage", () => {
    let g = toMain(newTestGame(3));
    let dihada: string, theirBear: string, theirLegend: string, theirLand: string, otherRock: string;
    [g, dihada] = put(g, "p1", real("Dihada, Binder of Wills"));
    [g, theirBear] = put(g, "p2", bear("Their Bear"));
    [g, theirLegend] = put(g, "p2", legend("Their Legend"), 1);
    [g, theirLand] = put(g, "p2", forest, 2);
    [g, otherRock] = put(g, "p3", rock);
    g.cards[theirBear]!.tapped = true;
    g.cards[dihada]!.counters["loyauté"] = 11;
    g = act(g, "p1", { type: "activateAbility", cardId: dihada, index: 2 });
    g = resolveAll(g);
    for (const id of [theirBear, theirLegend, otherRock]) expect(g.cards[id]!.controllerId).toBe("p1");
    expect(g.players.p1!.zones.battlefield).toContain(theirBear);
    expect(g.cards[theirLand]!.controllerId).toBe("p2");
    expect(g.cards[theirBear]!.tapped).toBe(false);
    expect(hasKeyword(g, g.cards[theirBear]!, "Haste")).toBe(true);
    // Le contrôle revient à la fin du tour.
    g = endTurn(g, "p1");
    expect(g.cards[theirBear]!.controllerId).toBe("p2");
    expect(g.cards[theirLegend]!.controllerId).toBe("p2");
    expect(g.cards[otherRock]!.controllerId).toBe("p3");
    expect(g.players.p2!.zones.battlefield).toContain(theirBear);
    expect(hasKeyword(g, g.cards[theirBear]!, "Haste")).toBe(false);
  });

  it("Act of Treason (même motif, une cible) : contrôle, dégagement et célérité jusqu'à la fin du tour", () => {
    const act2 = fakeCard("Act of Treason", {
      typeLine: "Sorcery",
      manaCost: "{2}{R}",
      colors: ["R"],
      oracleText: "Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn.",
    });
    expect(cardSupport(act2).level).toBe("full");
    const seizing = fakeCard("Word of Seizing", {
      typeLine: "Instant",
      manaCost: "{3}{R}{R}",
      oracleText: "Split second\nUntap target permanent and gain control of it until end of turn. It gains haste until end of turn.",
    });
    expect(cardSupport(seizing).unknown.filter((u) => !/^Split second/i.test(u))).toEqual([]);
    let g = toMain(newTestGame(2));
    let theirBear: string, spell: string;
    [g, theirBear] = put(g, "p2", bear("Their Bear"));
    g.cards[theirBear]!.tapped = true;
    [g, spell] = inHand(g, "p1", act2);
    g = mana(g, "p1", "RCC");
    g = act(g, "p1", { type: "castSpell", cardId: spell, targets: [{ kind: "card", id: theirBear }] });
    g = resolveAll(g);
    expect(g.cards[theirBear]!.controllerId).toBe("p1");
    expect(g.cards[theirBear]!.tapped).toBe(false);
    expect(hasKeyword(g, g.cards[theirBear]!, "Haste")).toBe(true);
    g = endTurn(g, "p1");
    expect(g.cards[theirBear]!.controllerId).toBe("p2");
  });

  it("Urza's Ruinous Blast est entièrement géré ; il ne reste à Dihada que son −3", () => {
    expect(cardSupport(real("Urza's Ruinous Blast")).level).toBe("full");
    const unknown = cardSupport(real("Dihada, Binder of Wills")).unknown;
    expect(unknown.some((u) => u.startsWith("−11"))).toBe(false);
  });
});
