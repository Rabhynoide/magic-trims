import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import { parsePermanentAbilities } from "../src/triggers.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame } from "./helpers.js";
import deck from "./jodah-oracle.json" with { type: "json" };

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

type OracleCard = CardData;

/** Une carte du deck Jodah, avec son texte Oracle exact. */
function real(name: string): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, {
    typeLine: c.typeLine,
    oracleText: c.oracleText ?? "",
    manaCost: c.manaCost ?? "",
    manaValue: c.manaValue,
    colors: c.colors,
    keywords: c.keywords,
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
  return [g, id];
}

/** Donne à une carte de la main les données voulues (elle reste en main). */
function inHand(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
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

const toMain = (g: GameState) => act(g, g.turn.activePlayerId, { type: "nextStep", to: "main1" });

/** Lance une carte de la main de p1 avec les données voulues, puis résout la pile. */
function cast(g: GameState, card: CardData, pool: string, playerId = "p1"): GameState {
  let id: string;
  [g, id] = inHand(g, playerId, card);
  g = mana(g, playerId, pool);
  g = act(g, playerId, { type: "castSpell", cardId: id });
  return resolveAll(g);
}

const bear = (name: string, extra: Partial<CardData> = {}) =>
  fakeCard(name, { typeLine: "Creature — Bear", manaCost: "{1}{G}", colors: ["G"], power: "2", toughness: "2", ...extra });

/** Pioche-t-on ? Nombre de cartes en main de p1. */

/** Nombre de cartes en main de p1. */
const hand = (g: GameState) => g.players.p1!.zones.hand.length;

/** Déclare l'attaque de p1 sur p2 et résout les déclencheurs (sans accepter les « may »). */
function attack(g: GameState, attackers: string[]): GameState {
  g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
  g = act(g, "p1", { type: "declareAttackers", attackers: attackers.map((cardId) => ({ cardId, defender: "p2" })) });
  return resolveAll(g);
}

const choosing = (g: GameState) => g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice);
const deciding = (g: GameState) => g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.awaitingDecision);

describe("Famille 12 : mettre en jeu attaquant ou depuis la main", () => {
  it("les trois cartes sont entièrement gérées", () => {
    for (const name of ["Kari Zev, Skyship Raider", "Shadowfax, Lord of Horses", "Last March of the Ents"]) {
      expect(cardSupport(real(name)), name).toEqual({ level: "full", unknown: [] });
    }
  });

  it("Kari Zev crée Ragavan, légendaire, engagé et attaquant, exilé à la fin du combat", () => {
    let g = newTestGame(2);
    let kari: string;
    [g, kari] = put(g, "p1", real("Kari Zev, Skyship Raider"));
    g = attack(g, [kari]);
    const ragavan = g.players.p1!.zones.battlefield.map((id) => g.cards[id]!).find((c) => g.cardData[c.cardId]!.name === "Ragavan");
    expect(ragavan).toBeDefined();
    expect(ragavan!.tapped).toBe(true);
    expect(ragavan!.isToken).toBe(true);
    expect(g.cardData[ragavan!.cardId]!.typeLine).toMatch(/^Legendary .*Creature — Monkey$/);
    expect(g.cardData[ragavan!.cardId]!.power).toBe("2");
    expect(g.combat!.attackers[ragavan!.instanceId]).toBe("p2");
    // Pas de bloqueur : Kari Zev (1) et Ragavan (2) blessent p2.
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    expect(g.players.p2!.life).toBe(37);
    expect(g.cards[ragavan!.instanceId]?.zone ?? "exile").not.toBe("battlefield");
    expect(g.players.p1!.zones.battlefield).not.toContain(ragavan!.instanceId);
  });

  it("Shadowfax met une créature de force inférieure de la main, engagée et attaquante", () => {
    let g = newTestGame(2);
    let shadowfax: string;
    [g, shadowfax] = put(g, "p1", real("Shadowfax, Lord of Horses"));
    let small: string, big: string;
    [g, small] = inHand(g, "p1", bear("Petit ours"));
    [g, big] = inHand(g, "p1", bear("Gros ours", { power: "5", toughness: "5" }), 1);
    g = attack(g, [shadowfax]);
    const decide = deciding(g);
    expect(decide).toBeDefined();
    g = act(g, "p1", { type: "decideOptional", cardId: decide!.instanceId, accept: true });
    g = resolveAll(g);
    const choice = choosing(g);
    expect(choice).toBeDefined();
    expect(choice!.cardChoice!.options).toContain(small);
    expect(choice!.cardChoice!.options).not.toContain(big);
    g = act(g, "p1", { type: "chooseCards", cardId: choice!.instanceId, cardIds: [small] });
    g = resolveAll(g);
    expect(g.cards[small]!.zone).toBe("battlefield");
    expect(g.cards[small]!.tapped).toBe(true);
    expect(g.combat!.attackers[small]).toBe("p2");
    expect(g.cards[big]!.zone).toBe("hand");
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    expect(g.players.p2!.life).toBe(40 - 4 - 2);
  });

  it("Last March of the Ents pioche selon la plus grande endurance puis met autant de créatures que voulu", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", bear("Mur", { power: "0", toughness: "3" }));
    let a: string, b: string;
    [g, a] = inHand(g, "p1", bear("Ours A"), 1);
    [g, b] = inHand(g, "p1", bear("Ours B"), 2);
    const before = hand(g);
    let march: string;
    [g, march] = inHand(g, "p1", real("Last March of the Ents"));
    g = mana(g, "p1", "GGGGGGGG");
    g = act(g, "p1", { type: "castSpell", cardId: march });
    g = resolveAll(g);
    const choice = choosing(g);
    expect(choice).toBeDefined();
    // Main : avant − le sort + 3 cartes piochées.
    expect(hand(g)).toBe(before - 1 + 3);
    expect(choice!.cardChoice!.max).toBe(choice!.cardChoice!.options.length);
    g = act(g, "p1", { type: "chooseCards", cardId: choice!.instanceId, cardIds: [a, b] });
    g = resolveAll(g);
    expect(g.cards[a]!.zone).toBe("battlefield");
    expect(g.cards[b]!.zone).toBe("battlefield");
    expect(g.cards[a]!.tapped).toBeFalsy();
  });

  it("jeton générique « that's tapped and attacking »", () => {
    let g = newTestGame(2);
    let knight: string;
    [g, knight] = put(g, "p1", bear("Chevalier", { oracleText: "Whenever Chevalier attacks, create a 1/1 white Soldier creature token that's tapped and attacking." }));
    expect(cardSupport(g.cardData[g.cards[knight]!.cardId]!).level).toBe("full");
    g = attack(g, [knight]);
    const soldier = g.players.p1!.zones.battlefield.find((id) => /Soldier/.test(g.cardData[g.cards[id]!.cardId]!.typeLine));
    expect(soldier).toBeDefined();
    expect(g.cards[soldier!]!.tapped).toBe(true);
    expect(g.combat!.attackers[soldier!]).toBe("p2");
  });

  it("le déclencheur d'Incandescent Soulstoke reste lu (sous-type)", () => {
    const r = parsePermanentAbilities("{1}{R}, {T}: You may put an Elemental creature card from your hand onto the battlefield. That creature gains haste until end of turn. Sacrifice it at the beginning of the next end step.", "Soulstoke");
    expect(r.activated[0]?.effects.effects[0]).toMatchObject({ type: "putFromHand", subtype: "Elemental", haste: true, sacrificeAtEnd: true });
  });
});
