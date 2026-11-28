import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { creatureStats, isCreature } from "../src/combat.js";
import { cardSupport } from "../src/effects.js";
import { abilitiesOf } from "../src/triggers.js";
import { applyAction } from "../src/reducer.js";
import { chooseBotAction } from "../src/bot.js";
import type { CardData, GameState } from "../src/types.js";
import { endTurn, fakeCard, newTestGame } from "./helpers.js";
import deck from "./wakanda-oracle.json" with { type: "json" };

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}
function fails(g: GameState, actorId: string, action: GameAction): string {
  const r = applyAction(g, { actorId, action });
  if (r.ok) throw new Error("l'action aurait dû être refusée");
  return r.error;
}

function real(name: string): CardData {
  const c = (deck as CardData[]).find((d) => d.name === name)!;
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

/** Donne à la n-ième carte de la main les données voulues et la met dans la zone voulue. */
function place(g: GameState, card: CardData, to: "battlefield" | "hand", n = 0, sick = false): [GameState, string] {
  g = structuredClone(g);
  const id = g.players.p1!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  if (to !== "hand") g = act(g, "p1", { type: "moveCard", cardId: id, to, force: true });
  if (!sick) delete g.cards[id]!.summoningSick;
  return [g, id];
}

function resolveAll(g: GameState): GameState {
  for (let i = 0; i < 50 && g.priority && g.stack.length > 0; i++) g = act(g, g.priority.playerId, { type: "passPriority" });
  return g;
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const MECH = real("Vibranium Mining Mech");
const MOTHER_SHIP = real("N'Yami-Class Mother Ship");
const TALON = real("Royal Talon Fighter Jet");
const NAKIA = real("Nakia, Wakandan Operative");
const BEAR = fakeCard("Bear", { typeLine: "Creature — Bear", manaCost: "{1}{G}", manaValue: 2, colors: ["G"], power: "2", toughness: "2" });
const CUB = fakeCard("Cub", { typeLine: "Creature — Bear", manaCost: "{G}", manaValue: 1, colors: ["G"], power: "1", toughness: "1" });
const ROCK = fakeCard("Rock", { typeLine: "Artifact", manaCost: "{1}", manaValue: 1, colors: [] });

/** Active « Crew N » du Véhicule en engageant ces créatures. */
function crew(g: GameState, cardId: string, ids: string[]): GameAction {
  const index = abilitiesOf(g.cardData[g.cards[cardId]!.cardId]).activated.findIndex((a) => a.cost.crew !== undefined);
  return { type: "activateAbility", cardId, index, crew: ids };
}

/** Le Mech en jeu, un ours (avec le mal d'invocation) et un ourson. */
function setup(): { g: GameState; mech: string; bear: string; cub: string } {
  let g = toMain(newTestGame(2));
  let mech: string, bear: string, cub: string;
  [g, mech] = place(g, MECH, "battlefield");
  [g, bear] = place(g, BEAR, "battlefield", 0, true);
  [g, cub] = place(g, CUB, "battlefield");
  // Le Mech crée un jeton Vibranium engagé en arrivant.
  return { g: resolveAll(g), mech, bear, cub };
}

describe("Véhicules et équipage", () => {
  it("un Véhicule n'est pas une créature tant qu'il n'est pas piloté", () => {
    const { g, mech } = setup();
    expect(isCreature(g, g.cards[mech]!)).toBe(false);
    const g2 = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    expect(fails(g2, "p1", { type: "declareAttackers", attackers: [{ cardId: mech, defender: "p2" }] })).toMatch(/créature|attaquer/i);
  });

  it("Crew 2 : engager une créature de force 2 (même avec le mal d'invocation) le rend créature jusqu'à la fin du tour", () => {
    let { g, mech, bear } = setup();
    g = act(g, "p1", crew(g, mech, [bear]));
    expect(g.cards[bear]!.tapped).toBe(true);
    expect(g.stack.length).toBe(1);
    g = resolveAll(g);
    const vehicle = g.cards[mech]!;
    expect(vehicle.crewed).toBe(true);
    expect(isCreature(g, vehicle)).toBe(true);
    expect(creatureStats(g, vehicle)).toEqual({ power: 6, toughness: 6 });
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: mech, defender: "p2" }] });
    expect(g.combat?.attackers[mech]).toBe("p2");
    // Il attaque : un autre jeton Vibranium.
    g = resolveAll(g);
    g = endTurn(g, "p1");
    expect(g.cards[mech]!.crewed).toBeUndefined();
    expect(isCreature(g, g.cards[mech]!)).toBe(false);
  });

  it("refuse une force totale trop faible, une créature engagée, ou le Véhicule lui-même", () => {
    const { g, mech, bear, cub } = setup();
    expect(fails(g, "p1", crew(g, mech, [cub]))).toMatch(/force totale 2/);
    expect(fails(g, "p1", crew(g, mech, [mech]))).toMatch(/autres créatures/);
    expect(fails(g, "p1", crew(g, mech, [cub, cub]))).toMatch(/qu'une fois/);
    const tapped = structuredClone(g);
    tapped.cards[bear]!.tapped = true;
    expect(fails(tapped, "p1", crew(g, mech, [bear]))).toMatch(/engagé/);
    // Plusieurs créatures : 1 + 2 ≥ 2.
    const ok = resolveAll(act(g, "p1", crew(g, mech, [bear, cub])));
    expect(ok.cards[mech]!.crewed).toBe(true);
  });

  it("un Véhicule piloté peut piloter un autre Véhicule", () => {
    let { g, mech, bear } = setup();
    let ship: string;
    [g, ship] = place(g, MOTHER_SHIP, "battlefield");
    g = resolveAll(act(g, "p1", crew(g, mech, [bear])));
    expect(fails(g, "p1", crew(g, ship, [bear]))).toMatch(/engagé/);
    g = resolveAll(act(g, "p1", crew(g, ship, [mech])));
    expect(g.cards[ship]!.crewed).toBe(true);
    expect(creatureStats(g, g.cards[ship]!)).toEqual({ power: 5, toughness: 7 });
  });

  it("Nakia cible une créature ou un Véhicule (piloté ou non), pas un autre artefact", () => {
    let { g, mech } = setup();
    let nakia: string, rock: string;
    [g, nakia] = place(g, NAKIA, "battlefield");
    [g, rock] = place(g, ROCK, "battlefield");
    g = act(g, "p1", { type: "adjustMana", mana: "C", delta: 2 });
    expect(fails(g, "p1", { type: "activateAbility", cardId: nakia, index: 0, targets: [{ kind: "card", id: rock }] })).toMatch(/Véhicule/);
    g = resolveAll(act(g, "p1", { type: "activateAbility", cardId: nakia, index: 0, targets: [{ kind: "card", id: mech }] }));
    expect(g.cards[mech]!.counters["+1/+1"]).toBe(2);
  });

  it("Royal Talon Fighter Jet arrive avec X marqueurs +1/+1 et crée autant de Soldats", () => {
    let g = toMain(newTestGame(2));
    let talon: string;
    [g, talon] = place(g, TALON, "hand");
    g = act(g, "p1", { type: "adjustMana", mana: "W", delta: 2 });
    g = act(g, "p1", { type: "adjustMana", mana: "C", delta: 3 });
    g = act(g, "p1", { type: "castSpell", cardId: talon, x: 3 });
    g = resolveAll(g);
    expect(g.cards[talon]!.zone).toBe("battlefield");
    expect(g.cards[talon]!.counters["+1/+1"]).toBe(3);
    g = resolveAll(g);
    const soldiers = g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken);
    expect(soldiers.length).toBe(3);
  });

  it("les cartes de la famille sont reconnues", () => {
    expect(cardSupport(TALON).level).toBe("full");
    expect(cardSupport(MOTHER_SHIP).unknown).not.toContain("Crew 3");
    expect(cardSupport(MECH).unknown).not.toContain("Crew 2");
    expect(cardSupport(MECH).level).toBe("full");
    expect(cardSupport(NAKIA).level).toBe("full");
  });

  it("le bot pilote son Véhicule avec une créature qui ne peut pas attaquer", () => {
    let { g, mech, bear } = setup();
    // Plus rien à jouer depuis la main : seul l'équipage reste à faire avant le combat.
    g = structuredClone(g);
    for (const id of [...g.players.p1!.zones.hand]) g = act(g, "p1", { type: "moveCard", cardId: id, to: "graveyard", force: true });
    const action = chooseBotAction(g, "p1");
    expect(action).toMatchObject({ type: "activateAbility", cardId: mech, crew: [bear] });
  });
});
