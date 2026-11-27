import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { creatureStats } from "../src/combat.js";
import { cardSupport, parseSpellEffects } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
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
function real(name: string, extra: Partial<CardData> = {}): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, {
    typeLine: c.typeLine,
    oracleText: c.oracleText ?? "",
    manaCost: c.manaCost ?? "",
    ...(c.power ? { power: c.power, toughness: c.toughness } : {}),
    ...extra,
  });
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
const creature = (name: string, power: number, toughness: number) =>
  fakeCard(name, { typeLine: "Creature — Beast", power: String(power), toughness: String(toughness), manaCost: "{1}{G}" });
const named = (g: GameState, playerId: string, name: string) => g.players[playerId]!.zones.battlefield.filter((id) => g.cardData[g.cards[id]!.cardId]?.name === name);

describe("Quantités « égal à », « that many », « pour chaque »", () => {
  it("Swords to Plowshares : son contrôleur gagne des PV égaux à la force de la créature exilée (bonus compris)", () => {
    let g = toMain(newTestGame(2));
    let theirs: string, spell: string;
    [g, theirs] = put(g, "p2", creature("Gros", 5, 5));
    g.cards[theirs]!.counters["+1/+1"] = 2;
    [g, spell] = inHand(g, "p1", real("Swords to Plowshares"));
    g = mana(g, "p1", "W");
    g = act(g, "p1", { type: "castSpell", cardId: spell, targets: [{ kind: "card", id: theirs }] });
    g = resolveAll(g);
    expect(g.cards[theirs]!.zone).toBe("exile");
    expect(g.players.p2!.life).toBe(47);
    expect(g.players.p1!.life).toBe(40);
  });

  it("Toxic Deluge : X PV payés en lançant, toutes les créatures ont -X/-X jusqu'à la fin du tour", () => {
    let g = toMain(newTestGame(2));
    let small: string, big: string, spell: string;
    [g, small] = put(g, "p1", creature("Petit", 2, 2));
    [g, big] = put(g, "p2", creature("Grand", 4, 5));
    [g, spell] = inHand(g, "p1", real("Toxic Deluge"), 1);
    g = mana(g, "p1", "BCC");
    expect(refuse(g, "p1", { type: "castSpell", cardId: spell })).toMatch(/Choisis X/);
    expect(refuse(g, "p1", { type: "castSpell", cardId: spell, x: 41 })).toMatch(/40 PV/);
    g = act(g, "p1", { type: "castSpell", cardId: spell, x: 3 });
    expect(g.players.p1!.life).toBe(37);
    g = resolveAll(g);
    expect(g.cards[small]!.zone).toBe("graveyard");
    expect(g.cards[big]!.zone).toBe("battlefield");
    expect(creatureStats(g, g.cards[big]!)).toEqual({ power: 1, toughness: 2 });
    g = endTurn(g, "p1");
    expect(creatureStats(g, g.cards[big]!)).toEqual({ power: 4, toughness: 5 });
  });

  it("Last March of the Ents : pioche égale à la plus grande endurance parmi mes créatures", () => {
    let g = toMain(newTestGame(2));
    let spell: string;
    [g] = put(g, "p1", creature("A", 1, 4));
    [g] = put(g, "p1", creature("B", 3, 2));
    [g] = put(g, "p2", creature("C", 1, 9));
    [g, spell] = inHand(g, "p1", real("Last March of the Ents"));
    g = mana(g, "p1", "GGCCCCCC");
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "castSpell", cardId: spell });
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1 + 4);
  });

  it("Krenko : en attaquant, un marqueur +1/+1 puis autant de Gobelins que sa force", () => {
    let g = toMain(newTestGame(2));
    let krenko: string;
    [g, krenko] = put(g, "p1", real("Krenko, Tin Street Kingpin"));
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: krenko, defender: "p2" }] });
    g = resolveAll(g);
    expect(g.cards[krenko]!.counters["+1/+1"]).toBe(1);
    expect(named(g, "p1", "Goblin").length).toBe(2);
  });

  it("Old Gnawbone : autant de Trésors que de blessures de combat infligées à un joueur", () => {
    let g = toMain(newTestGame(2));
    let attacker: string;
    [g] = put(g, "p1", real("Old Gnawbone"));
    [g, attacker] = put(g, "p1", creature("Frappeur", 3, 3));
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: attacker, defender: "p2" }] });
    g = resolveAll(g);
    g = act(g, "p1", { type: "nextStep", to: "combatDamage" });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(37);
    expect(named(g, "p1", "Treasure").length).toBe(3);
  });

  it("« pour chaque » dans les sorts : piocher, gagner des PV, infliger des blessures", () => {
    const draw = parseSpellEffects("Draw a card for each creature you control.", "Test");
    expect(draw.unknown).toEqual([]);
    expect(draw.effects[0]).toMatchObject({ type: "draw", count: { perPermanent: { controller: "you" } } });
    const life = parseSpellEffects("You gain 2 life for each creature on the battlefield.", "Test");
    expect(life.effects[0]).toMatchObject({ type: "life", amount: { all: true, times: 2 } });
    const war = parseSpellEffects("Draw cards equal to the greatest power among creatures you control.", "Test");
    expect(war.unknown).toEqual([]);

    let g = toMain(newTestGame(2));
    let spell: string;
    [g] = put(g, "p1", creature("A", 1, 1));
    [g] = put(g, "p1", creature("B", 1, 1));
    [g] = put(g, "p2", creature("C", 1, 1));
    [g, spell] = inHand(g, "p1", fakeCard("Pioche", { typeLine: "Sorcery", manaCost: "{G}", oracleText: "Draw a card for each creature you control. You gain 1 life for each creature on the battlefield." }));
    g = mana(g, "p1", "G");
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "castSpell", cardId: spell });
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1 + 2);
    expect(g.players.p1!.life).toBe(43);
  });

  it("ces cartes du deck Jodah sont gérées", () => {
    for (const name of ["Swords to Plowshares", "Toxic Deluge", "Krenko, Tin Street Kingpin", "Old Gnawbone"]) {
      expect(cardSupport(real(name)).level, name).toBe("full");
    }
    // Last March : reste la mise en jeu depuis la main (famille 12) ; Robe : déclencheur d'équipement (famille 3).
    expect(cardSupport(real("Last March of the Ents")).unknown).toEqual(["put any number of creature cards from your hand onto the battlefield."]);
  });
});
