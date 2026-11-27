import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport } from "../src/effects.js";
import { grantedManaAbility, manaOptions, manaTapEffect } from "../src/mana.js";
import { applyAction, cardManaOptions } from "../src/reducer.js";
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

/** Met une carte de la main du joueur sur le champ de bataille (sans mal d'invocation). */
function put(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  delete g.cards[id]!.summoningSick;
  g.cards[id]!.tapped = false;
  return [g, id];
}

function inHand(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  return [g, id];
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const forest = fakeCard("Forest", { typeLine: "Basic Land — Forest", oracleText: "({T}: Add {G}.)" });
const swamp = fakeCard("Swamp", { typeLine: "Basic Land — Swamp", oracleText: "({T}: Add {B}.)" });

describe("Deck Jodah : mana spéciale", () => {
  it("les quatre cartes sont entièrement gérées", () => {
    for (const name of ["Chromatic Lantern", "Abundant Growth", "Mirari's Wake", "Somberwald Sage"]) {
      expect(cardSupport(real(name)), name).toEqual({ level: "full", unknown: [] });
    }
  });

  it("Chromatic Lantern : ses terrains produisent du mana de n'importe quelle couleur, pas ceux des autres", () => {
    let g = toMain(newTestGame(2));
    let mine: string, theirs: string;
    [g, mine] = put(g, "p1", forest);
    [g, theirs] = put(g, "p2", forest);
    expect(cardManaOptions(g, g.cards[mine]!)).toEqual([["G"]]);
    [g] = put(g, "p1", real("Chromatic Lantern"));
    expect(cardManaOptions(g, g.cards[mine]!)).toEqual([["G"], ["W"], ["U"], ["B"], ["R"]]);
    expect(cardManaOptions(g, g.cards[theirs]!)).toEqual([["G"]]);
    expect(refuse(g, "p1", { type: "tapForMana", cardId: mine })).toMatch(/Choisis/);
    g = act(g, "p1", { type: "tapForMana", cardId: mine, choice: 2 });
    expect(g.players.p1!.manaPool.U).toBe(1);
  });

  it("Chromatic Lantern : le paiement automatique engage une Forêt pour du bleu", () => {
    let g = toMain(newTestGame(2));
    let spell: string;
    [g] = put(g, "p1", forest);
    [g] = put(g, "p1", real("Chromatic Lantern"), 0);
    // La Lanterne elle-même est engagée : seule la Forêt peut payer.
    const lantern = g.players.p1!.zones.battlefield.at(-1)!;
    g.cards[lantern]!.tapped = true;
    [g, spell] = inHand(g, "p1", fakeCard("Ours bleu", { typeLine: "Creature — Bear", manaCost: "{U}", power: "1", toughness: "1" }));
    g = act(g, "p1", { type: "castSpell", cardId: spell });
    expect(g.stack).toContain(spell);
  });

  it("Abundant Growth : seul le terrain enchanté gagne la capacité", () => {
    let g = toMain(newTestGame(2));
    let land: string, other: string, aura: string;
    [g, land] = put(g, "p1", swamp);
    [g, other] = put(g, "p1", swamp);
    [g, aura] = put(g, "p1", real("Abundant Growth"));
    g.cards[aura]!.attachedTo = land;
    expect(cardManaOptions(g, g.cards[land]!)).toHaveLength(5);
    expect(cardManaOptions(g, g.cards[other]!)).toEqual([["B"]]);
  });

  it("Mirari's Wake : un mana de plus du même type pour ses terrains seulement", () => {
    let g = toMain(newTestGame(2));
    let mine: string, theirs: string;
    [g, mine] = put(g, "p1", forest);
    [g, theirs] = put(g, "p2", swamp);
    [g] = put(g, "p1", real("Mirari's Wake"));
    g = act(g, "p1", { type: "tapForMana", cardId: mine });
    expect(g.players.p1!.manaPool.G).toBe(2);
    expect(g.log.at(-1)!.message).toBe("Alice engage Forest pour {G}{G}.");
    g = act(g, "p2", { type: "tapForMana", cardId: theirs });
    expect(g.players.p2!.manaPool.B).toBe(1);
  });

  it("Mirari's Wake : pas pour une créature qui produit du mana", () => {
    let g = toMain(newTestGame(2));
    let birds: string;
    [g, birds] = put(g, "p1", real("Birds of Paradise"));
    [g] = put(g, "p1", real("Mirari's Wake"));
    g = act(g, "p1", { type: "tapForMana", cardId: birds, choice: 0 });
    expect(Object.values(g.players.p1!.manaPool).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("Somberwald Sage : trois manas d'une couleur, seulement pour les sorts de créature", () => {
    let g = toMain(newTestGame(2));
    let sage: string, rite: string, giant: string;
    [g, sage] = put(g, "p1", real("Somberwald Sage"));
    expect(cardManaOptions(g, g.cards[sage]!)).toEqual([["W", "W", "W"], ["U", "U", "U"], ["B", "B", "B"], ["R", "R", "R"], ["G", "G", "G"]]);
    [g, rite] = inHand(g, "p1", fakeCard("Rituel", { typeLine: "Sorcery", manaCost: "{G}", oracleText: "Draw a card." }), 0);
    [g, giant] = inHand(g, "p1", fakeCard("Géant", { typeLine: "Creature — Giant", manaCost: "{1}{G}{G}", power: "3", toughness: "3" }), 1);
    g = act(g, "p1", { type: "tapForMana", cardId: sage, choice: 4 });
    expect(g.players.p1!.manaPool.G).toBe(0);
    expect(g.players.p1!.restrictedMana).toHaveLength(3);
    expect(refuse(g, "p1", { type: "castSpell", cardId: rite })).toMatch(/mana/);
    g = act(g, "p1", { type: "castSpell", cardId: giant });
    expect(g.players.p1!.restrictedMana).toEqual([]);
    expect(g.stack).toContain(giant);
  });

  it("le mana réservé et le mana en plus se vident en fin de tour", () => {
    let g = toMain(newTestGame(2));
    let sage: string;
    [g, sage] = put(g, "p1", real("Somberwald Sage"));
    g = act(g, "p1", { type: "tapForMana", cardId: sage, choice: 0 });
    g = endTurn(g, "p1");
    expect(g.players.p1!.restrictedMana ?? []).toEqual([]);
  });
});

describe("Mana spéciale : motifs reconnus", () => {
  it("capacités données", () => {
    expect(grantedManaAbility('Lands you control have "{T}: Add one mana of any color."')).toEqual({ to: "Land", ability: "{T}: Add one mana of any color." });
    expect(grantedManaAbility('Enchanted land has "{T}: Add one mana of any color."')?.to).toBe("enchanted");
    expect(grantedManaAbility('Creatures you control have "{T}: Add one mana of any color."')?.to).toBe("Creature");
    expect(grantedManaAbility('Creatures you control have "{T}: Draw a card."')).toBeNull();
  });

  it("déclencheurs et remplacements de mana", () => {
    expect(manaTapEffect("Whenever you tap a land for mana, add one mana of any type that land produced.")).toEqual({ who: "you", source: "Land", add: { kind: "sameType" } });
    expect(manaTapEffect("Whenever a player taps a land for mana, that player adds one mana of any type that land produced.")?.who).toBe("player");
    expect(manaTapEffect("Whenever you tap a Swamp for mana, add an additional {B}.")).toEqual({ who: "you", source: "Swamp", add: { kind: "mana", mana: "B" } });
    expect(manaTapEffect("If you tap a permanent for mana, it produces twice as much of that mana instead.")?.add).toEqual({ kind: "multiply", factor: 2 });
  });

  it("n mana d'une seule couleur", () => {
    expect(manaOptions("Creature — Elf", "{T}: Add two mana of any one color.")).toHaveLength(5);
  });

  it("Mana Flare double aussi le mana des adversaires, Mana Reflection multiplie", () => {
    let g = toMain(newTestGame(2));
    let theirs: string, mine: string;
    [g, theirs] = put(g, "p2", swamp);
    [g, mine] = put(g, "p1", forest);
    [g] = put(g, "p1", fakeCard("Mana Flare", { typeLine: "Enchantment", oracleText: "Whenever a player taps a land for mana, that player adds one mana of any type that land produced." }));
    [g] = put(g, "p1", fakeCard("Mana Reflection", { typeLine: "Enchantment", oracleText: "If you tap a permanent for mana, it produces twice as much of that mana instead." }));
    g = act(g, "p2", { type: "tapForMana", cardId: theirs });
    expect(g.players.p2!.manaPool.B).toBe(2);
    g = act(g, "p1", { type: "tapForMana", cardId: mine });
    expect(g.players.p1!.manaPool.G).toBe(3);
  });
});
