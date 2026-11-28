import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { hasKeyword } from "../src/combat.js";
import { cardSupport } from "../src/effects.js";
import { manaOptions } from "../src/mana.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame } from "./helpers.js";
import deck from "./wakanda-oracle.json" with { type: "json" };

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

/** Une carte du deck Wakanda Forever, avec son texte Oracle exact. */
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

function resolveAll(g: GameState, max = 100): GameState {
  for (let i = 0; i < max && g.priority && g.stack.length > 0; i++) g = act(g, g.priority.playerId, { type: "passPriority" });
  return g;
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const forest = fakeCard("Forest", { typeLine: "Basic Land — Forest", oracleText: "({T}: Add {G}.)" });
const vibraniums = (g: GameState, p = "p1") => g.players[p]!.zones.battlefield.map((id) => g.cards[id]!).filter((c) => g.cardData[c.cardId]!.name === "Vibranium");

describe("Deck Wakanda Forever : jeton Vibranium", () => {
  it("les cartes de la famille sont reconnues (le Mech garde Crew, une autre famille)", () => {
    for (const name of ["T'Challa, the Black Panther", "Dora Milaje Elite", "The Great Mound"]) {
      expect(cardSupport(real(name)), name).toMatchObject({ level: "full" });
    }
    expect(cardSupport(real("Shuri's Fabricator")).unknown).not.toContain("When this artifact enters, create two tapped Vibranium tokens.");
    expect(cardSupport(real("Vibranium Mining Mech")).unknown).toEqual(["Crew 2"]);
  });

  it("le mana du Vibranium est réservé aux sorts d'artefact", () => {
    expect(manaOptions("Token Artifact — Vibranium", "Indestructible\n{T}: Add {C}. This mana can't be spent to cast a nonartifact spell.")).toEqual([["C"]]);
  });

  it("Shuri's Fabricator crée deux jetons Vibranium engagés et indestructibles", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Shuri's Fabricator"));
    g = resolveAll(g);
    const tokens = vibraniums(g);
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => t.tapped && t.isToken)).toBe(true);
    expect(hasKeyword(g, tokens[0]!, "Indestructible")).toBe(true);
    expect(g.cardData[tokens[0]!.cardId]!.typeLine).toMatch(/Artifact — Vibranium/);
  });

  it("T'Challa crée un jeton en arrivant et en attaquant", () => {
    let g = toMain(newTestGame(2));
    let tchalla: string;
    [g, tchalla] = put(g, "p1", real("T'Challa, the Black Panther"));
    g = resolveAll(g);
    expect(vibraniums(g)).toHaveLength(1);
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: tchalla, defender: "p2" }] } as GameAction);
    g = resolveAll(g);
    expect(vibraniums(g)).toHaveLength(2);
  });

  it("Dora Milaje Elite : un jeton seulement si un adversaire a plus de terrains", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Dora Milaje Elite"));
    g = resolveAll(g);
    expect(vibraniums(g)).toHaveLength(0);
    [g] = put(g, "p2", forest);
    [g] = put(g, "p1", real("Dora Milaje Elite"));
    g = resolveAll(g);
    expect(vibraniums(g)).toHaveLength(1);
  });

  it("The Great Mound : {3}, {T} crée un jeton Vibranium engagé", () => {
    let g = toMain(newTestGame(2));
    let mound: string;
    [g, mound] = put(g, "p1", real("The Great Mound"));
    for (let i = 0; i < 3; i++) [g] = put(g, "p1", forest);
    g = act(g, "p1", { type: "activateAbility", cardId: mound, index: 0 });
    g = resolveAll(g);
    const tokens = vibraniums(g);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.tapped).toBe(true);
  });

  it("le mana du Vibranium paie un sort d'artefact ou une capacité, pas un autre sort", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Shuri's Fabricator"));
    g = resolveAll(g);
    for (const t of vibraniums(g)) g.cards[t.instanceId]!.tapped = false;
    // Un sort de créature à {2} : les deux Vibranium ne suffisent pas.
    let bear: string;
    [g, bear] = inHand(g, "p1", fakeCard("Bear", { typeLine: "Creature — Bear", manaCost: "{2}", power: "2", toughness: "2" }));
    expect(refuse(g, "p1", { type: "castSpell", cardId: bear })).toMatch(/mana/);
    // Mana engagé à la main : réservé, il ne paie pas non plus le sort de créature.
    g = act(g, "p1", { type: "tapForMana", cardId: vibraniums(g)[0]!.instanceId });
    expect(g.players.p1!.manaPool.C).toBe(0);
    expect(g.players.p1!.restrictedMana).toHaveLength(1);
    expect(refuse(g, "p1", { type: "castSpell", cardId: bear })).toMatch(/mana/);
    // Un artefact à {2} : payé par les deux Vibranium.
    let ring: string;
    [g, ring] = inHand(g, "p1", fakeCard("Ring", { typeLine: "Artifact", manaCost: "{2}", manaValue: 2 }), 1);
    g = act(g, "p1", { type: "castSpell", cardId: ring });
    expect(vibraniums(g).every((t) => t.tapped)).toBe(true);
    expect(g.players.p1!.restrictedMana ?? []).toHaveLength(0);
  });

  it("le mana du Vibranium paie la capacité d'une créature (pas seulement d'un artefact)", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Shuri's Fabricator"));
    g = resolveAll(g);
    for (const t of vibraniums(g)) g.cards[t.instanceId]!.tapped = false;
    let pumper: string;
    [g, pumper] = put(g, "p1", fakeCard("Pumper", { typeLine: "Creature — Elf", oracleText: "{2}: This creature gets +1/+0 until end of turn.", power: "1", toughness: "1" }));
    g = act(g, "p1", { type: "activateAbility", cardId: pumper, index: 0 });
    expect(vibraniums(g).every((t) => t.tapped)).toBe(true);
  });
});
