import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { abilityReport, cardSupport, overloadedText, parseSpellEffects } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame, endTurn } from "./helpers.js";
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

/** Une carte du deck Jodah, avec son texte Oracle exact. */
function real(name: string): CardData {
  const c = (deck as CardData[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, { typeLine: c.typeLine, oracleText: c.oracleText ?? "", manaCost: c.manaCost ?? "", manaValue: c.manaValue, colors: c.colors, keywords: c.keywords });
}

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
  for (let i = 0; i < max && g.priority && g.stack.length > 0; i++) g = act(g, g.priority.playerId, { type: "passPriority" });
  return g;
}

function mana(g: GameState, playerId: string, pool: string): GameState {
  for (const m of pool.match(/[WUBRGC]/g) ?? []) g = act(g, playerId, { type: "adjustMana", mana: m as "B", delta: 1 });
  return g;
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const BEAR = fakeCard("Grizzly Bears", { typeLine: "Creature — Bear", manaCost: "{1}{G}", power: "2", toughness: "2" });
const FOREST = fakeCard("Forest", { typeLine: "Basic Land — Forest", oracleText: "({T}: Add {G}.)" });
const RING = fakeCard("Sol Ring", { typeLine: "Artifact", manaCost: "{1}", oracleText: "{T}: Add {C}{C}." });

describe("Surcharge : lecture", () => {
  it("Cyclonic Rift : coût de surcharge, et « target » devient « each »", () => {
    const rift = real("Cyclonic Rift");
    const normal = parseSpellEffects(rift.oracleText, rift.name);
    expect(normal).toMatchObject({ alternativeCost: "{6}{U}", overload: true, effects: [{ type: "bounce", target: 0 }], unknown: [] });
    expect(normal.targets).toHaveLength(1);
    const over = parseSpellEffects(rift.oracleText, rift.name, { alternative: true });
    expect(over.targets).toHaveLength(0);
    expect(over.effects).toEqual([{ type: "bounceAll", filter: { types: [], notTypes: ["land"], controller: "notYou" } }]);
    expect(over.unknown).toEqual([]);
    expect(cardSupport(rift).level).toBe("full");
    expect(abilityReport(rift).map((i) => i.status)).toEqual(["auto", "auto"]);
  });

  it("d'autres sorts à surcharge, lus de façon générale", () => {
    expect(overloadedText("Destroy target artifact you don't control.\nOverload {4}{R}")).toBe("Destroy each artifact you don't control.");
    const vandal = parseSpellEffects("Destroy target artifact you don't control.\nOverload {4}{R} (reminder)", "Vandalblast", { alternative: true });
    expect(vandal).toMatchObject({ alternativeCost: "{4}{R}", targets: [], effects: [{ type: "destroyAll" }], unknown: [] });
  });
});

describe("Surcharge : en jeu", () => {
  it("Cyclonic Rift ciblé renvoie un permanent adverse", () => {
    let g = toMain(newTestGame(3));
    let ring: string, rift: string;
    [g, ring] = put(g, "p2", RING);
    [g, rift] = inHand(g, "p1", real("Cyclonic Rift"));
    g = mana(g, "p1", "UU");
    g = act(g, "p1", { type: "castSpell", cardId: rift, targets: [{ kind: "card", id: ring }] });
    g = resolveAll(g);
    expect(g.players.p2!.zones.hand).toContain(ring);
  });

  it("Cyclonic Rift surchargé : chaque permanent non-terrain des adversaires retourne en main, sans cible", () => {
    let g = toMain(newTestGame(3));
    let bear2: string, land2: string, ring3: string, mine: string, rift: string;
    [g, bear2] = put(g, "p2", BEAR);
    [g, land2] = put(g, "p2", FOREST);
    [g, ring3] = put(g, "p3", RING);
    [g, mine] = put(g, "p1", BEAR);
    [g, rift] = inHand(g, "p1", real("Cyclonic Rift"));
    g = mana(g, "p1", "UU");
    expect(refuse(g, "p1", { type: "castSpell", cardId: rift, alternative: true })).toMatch(/Pas assez de mana/);
    g = mana(g, "p1", "CCCCC");
    g = act(g, "p1", { type: "castSpell", cardId: rift, alternative: true });
    expect(g.log.some((l) => /surcharge/.test(l.message))).toBe(true);
    g = resolveAll(g);
    expect(g.players.p2!.zones.hand).toContain(bear2);
    expect(g.players.p3!.zones.hand).toContain(ring3);
    expect(g.cards[land2]!.zone).toBe("battlefield");
    expect(g.cards[mine]!.zone).toBe("battlefield");
    expect(g.cards[rift]!.zone).toBe("graveyard");
    expect(g.cards[rift]!.alternative).toBeUndefined();
    // Le tour suivant se joue normalement.
    g = endTurn(g, "p1");
    expect(g.turn.activePlayerId).toBe("p2");
  });
});
