import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport, isLegalTarget, parseSpellEffects } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { endTurn, fakeCard, newTestGame } from "./helpers.js";
import deck from "./jodah-oracle.json" with { type: "json" };

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

type OracleCard = { name: string; typeLine: string; oracleText?: string; manaCost?: string };

function real(name: string): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name)!;
  return fakeCard(c.name, { typeLine: c.typeLine, oracleText: c.oracleText ?? "", manaCost: c.manaCost ?? "" });
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

function resolveAll(g: GameState): GameState {
  for (let i = 0; i < 50 && g.priority && g.stack.length > 0; i++) g = act(g, g.priority.playerId, { type: "passPriority" });
  return g;
}

function mana(g: GameState, playerId: string, pool: string): GameState {
  for (const m of pool.match(/[WUBRGC]/g) ?? []) g = act(g, playerId, { type: "adjustMana", mana: m as "B", delta: 1 });
  return g;
}

const toMain = (g: GameState, p = "p1") => act(g, p, { type: "nextStep", to: "main1" });
const bear = (name = "Bear") => fakeCard(name, { typeLine: "Creature — Bear", power: "2", toughness: "2", manaCost: "{1}{G}" });

describe("Mise hors phase et protection du joueur (Teferi's Protection)", () => {
  it("lit tout le texte de Teferi's Protection", () => {
    const tp = real("Teferi's Protection");
    expect(cardSupport(tp).level).toBe("full");
    const fx = parseSpellEffects(tp.oracleText, tp.name);
    expect(fx.exileSelf).toBe(true);
    expect(fx.effects.map((e) => e.type)).toEqual(["playerUntilNextTurn", "phaseOutAll"]);
  });

  it("met mes permanents hors phase, me protège jusqu'à mon prochain tour, puis tout revient", () => {
    let g = toMain(newTestGame(2));
    let mine: string, land: string, gear: string, theirs: string, tp: string;
    [g, mine] = put(g, "p1", bear());
    [g, land] = put(g, "p1", fakeCard("Plains", { typeLine: "Basic Land — Plains", oracleText: "({T}: Add {W}.)" }), 1);
    [g, gear] = put(g, "p1", fakeCard("Sword", { typeLine: "Artifact — Equipment", oracleText: "Equipped creature gets +1/+1.\nEquip {2}" }), 2);
    [g, theirs] = put(g, "p2", bear("Their Bear"));
    g = structuredClone(g);
    g.cards[gear]!.attachedTo = mine;
    g.cards[mine]!.counters["+1/+1"] = 1;
    g.cards[land]!.tapped = true;
    const life = g.players.p1!.life;

    [g, tp] = inHand(g, "p1", real("Teferi's Protection"), 3);
    g = mana(g, "p1", "WWW");
    g = act(g, "p1", { type: "castSpell", cardId: tp });
    g = resolveAll(g);

    // Hors phase : sortis du champ de bataille sans en partir (mêmes objets, marqueurs gardés).
    for (const id of [mine, land, gear]) expect(g.cards[id]!.zone).toBe("phasedOut");
    expect(g.players.p1!.zones.battlefield).toEqual([]);
    expect(g.players.p1!.zones.phasedOut).toEqual(expect.arrayContaining([mine, land, gear]));
    expect(g.cards[gear]!.phasedOutIndirectly).toBe(true);
    expect(g.cards[mine]!.counters["+1/+1"]).toBe(1);
    expect(g.cards[theirs]!.zone).toBe("battlefield");
    // Le sort s'exile lui-même.
    expect(g.cards[tp]!.zone).toBe("exile");
    expect(g.players.p1!.untilNextTurn).toEqual({ lifeCantChange: true, protection: true });

    // Tour de l'adversaire : ni ciblé, ni blessé, ni perte de PV ; ses balayages ignorent mes permanents.
    g = endTurn(g, "p1");
    g = toMain(g, "p2");
    expect(g.cards[mine]!.zone).toBe("phasedOut");
    expect(isLegalTarget(g, { label: "joueur", player: true }, { kind: "player", id: "p1" }, "p2")).toBe(false);
    expect(isLegalTarget(g, { label: "joueur", player: true }, { kind: "player", id: "p1" }, "p1")).toBe(false);
    let s1: string, s2: string, s3: string;
    [g, s1] = inHand(g, "p2", fakeCard("Zap All", { manaCost: "", typeLine: "Sorcery", oracleText: "Zap All deals 3 damage to each opponent." }), 0);
    [g, s2] = inHand(g, "p2", fakeCard("Drain", { manaCost: "", typeLine: "Sorcery", oracleText: "Each opponent loses 2 life." }), 1);
    [g, s3] = inHand(g, "p2", fakeCard("Wrath", { manaCost: "", typeLine: "Sorcery", oracleText: "Destroy all creatures." }), 2);
    for (const s of [s1, s2, s3]) {
      g = act(g, "p2", { type: "castSpell", cardId: s });
      g = resolveAll(g);
    }
    expect(g.players.p1!.life).toBe(life);
    expect(g.cards[theirs]!.zone).toBe("graveyard");
    expect(g.cards[mine]!.zone).toBe("phasedOut");

    // Mon tour suivant : tout revient avant le dégagement, et la protection prend fin.
    g = endTurn(g, "p2");
    expect(g.turn.activePlayerId).toBe("p1");
    for (const id of [mine, land, gear]) expect(g.cards[id]!.zone).toBe("battlefield");
    expect(g.cards[gear]!.attachedTo).toBe(mine);
    expect(g.cards[gear]!.phasedOutIndirectly).toBeUndefined();
    expect(g.cards[mine]!.counters["+1/+1"]).toBe(1);
    expect(g.cards[land]!.tapped).toBe(false);
    expect(g.cards[mine]!.summoningSick).toBeFalsy();
    expect(g.players.p1!.untilNextTurn).toBeUndefined();
    expect(isLegalTarget(g, { label: "joueur", player: true }, { kind: "player", id: "p1" }, "p2")).toBe(true);
  });

  it("refuse de payer des points de vie tant qu'ils ne peuvent pas changer", () => {
    let g = toMain(newTestGame(2));
    g = structuredClone(g);
    g.players.p1!.untilNextTurn = { lifeCantChange: true };
    let src: string;
    [g, src] = put(g, "p1", fakeCard("Altar", { typeLine: "Artifact", oracleText: "Pay 2 life: Draw a card." }));
    const r = applyAction(g, { actorId: "p1", action: { type: "activateAbility", cardId: src, index: 0 } as GameAction });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/points de vie/);
  });

  it("« target creature phases out » : une seule créature, qui revient au tour de son contrôleur", () => {
    let g = toMain(newTestGame(2));
    let mine: string, spell: string;
    [g, mine] = put(g, "p1", bear());
    [g, spell] = inHand(g, "p1", fakeCard("Blink Out", { manaCost: "", typeLine: "Instant", oracleText: "Target creature you control phases out." }), 1);
    g = act(g, "p1", { type: "castSpell", cardId: spell, targets: [{ kind: "card", id: mine }] });
    g = resolveAll(g);
    expect(g.cards[mine]!.zone).toBe("phasedOut");
    expect(g.cards[spell]!.zone).toBe("graveyard");
    g = endTurn(g, "p1");
    expect(g.cards[mine]!.zone).toBe("phasedOut");
    g = endTurn(g, "p2");
    expect(g.cards[mine]!.zone).toBe("battlefield");
  });
});
