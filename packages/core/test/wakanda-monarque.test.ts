import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import { hasKeyword } from "../src/combat.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame } from "./helpers.js";
import deck from "./wakanda-oracle.json" with { type: "json" };

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

/** Une carte du deck Wakanda Forever, avec son texte Oracle exact. */
function real(name: string): CardData {
  const c = (deck as CardData[]).find((d) => d.name === name);
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

const bear = (name: string, extra: Partial<CardData> = {}) =>
  fakeCard(name, { typeLine: "Creature — Bear", manaCost: "{1}{G}", colors: ["G"], power: "2", toughness: "2", ...extra });

const hand = (g: GameState, p = "p1") => g.players[p]!.zones.hand.length;

/** Déclare l'attaque de p1 sur p2 et résout les déclencheurs. */
function attack(g: GameState, attackers: string[], defender = "p2"): GameState {
  g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
  g = act(g, "p1", { type: "declareAttackers", attackers: attackers.map((cardId) => ({ cardId, defender })) });
  return resolveAll(g);
}

const needsTargets = (g: GameState) => g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.needsTargets);

describe("Monarque (deck Wakanda Forever)", () => {
  it("les cartes du monarque sont entièrement gérées", () => {
    for (const name of ["M'Baku, Jabari Chieftain", "Okoye, Mighty and Adored", "Palace Jailer", "The Spear of Bashenga", "Throne of the High City"]) {
      expect(cardSupport(real(name)), name).toEqual({ level: "full", unknown: [] });
    }
    // Le reste de ces cartes relève d'autres familles : seul le monarque est lu ici
    // (la restriction d'attaque de Ramonda vient du fil « restrictions de combat »).
    expect(cardSupport(real("Queen Mother Ramonda")).unknown).not.toContain("When Queen Mother Ramonda enters, you become the monarch.");
    expect(cardSupport(real("Nakia, Wakandan Operative")).unknown).not.toContain("Whenever your commander enters, you become the monarch.");
    expect(cardSupport(real("King Solomon's Frogs")).unknown).not.toContain("{3}, {T}, Exile King Solomon's Frogs: You become the monarch.");
  });

  it("le monarque pioche au début de son étape de fin", () => {
    let g = act(newTestGame(2), "p1", { type: "setMonarch", playerId: "p1" });
    expect(g.monarch).toBe("p1");
    const before = hand(g);
    g = act(g, "p1", { type: "nextStep", to: "end" });
    expect(hand(g)).toBe(before + 1);
    // Pas à l'étape de fin d'un autre joueur.
    g = act(g, "p1", { type: "setMonarch", playerId: "p2" });
    const p2 = hand(g, "p2");
    g = act(g, "p1", { type: "nextStep", to: "cleanup" });
    expect(hand(g, "p2")).toBe(p2);
  });

  it("des blessures de combat au monarque donnent le titre", () => {
    let g = act(newTestGame(2), "p1", { type: "setMonarch", playerId: "p2" });
    let b: string;
    [g, b] = put(g, "p1", bear("Ours"));
    g = attack(g, [b]);
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    expect(g.players.p2!.life).toBe(38);
    expect(g.monarch).toBe("p1");
  });

  it("Palace Jailer : monarque, et exil jusqu'à ce qu'un adversaire devienne le monarque", () => {
    let g = newTestGame(2);
    let victim: string;
    [g, victim] = put(g, "p2", bear("Ours de p2"));
    [g] = put(g, "p1", real("Palace Jailer"));
    g = resolveAll(g);
    expect(g.monarch).toBe("p1");
    expect(g.cards[victim]!.zone).toBe("exile");
    expect(g.cards[victim]!.exiledUntilMonarch).toBe("p1");
    // p1 le redevient : rien ne revient.
    g = act(g, "p1", { type: "setMonarch", playerId: "p1" });
    expect(g.cards[victim]!.zone).toBe("exile");
    g = act(g, "p1", { type: "setMonarch", playerId: "p2" });
    expect(g.cards[victim]!.zone).toBe("battlefield");
    expect(g.cards[victim]!.controllerId).toBe("p2");
    expect(g.cards[victim]!.exiledUntilMonarch).toBeUndefined();
  });

  it("M'Baku : un adversaire ciblé devient le monarque s'il n'y en a pas, puis bonus contre le monarque", () => {
    let g = newTestGame(2);
    let b: string;
    [g] = put(g, "p1", real("M'Baku, Jabari Chieftain"));
    [g, b] = put(g, "p1", bear("Ours"), 0);
    g = act(g, "p1", { type: "nextStep", to: "end" });
    g = resolveAll(g);
    expect(g.monarch).toBe("p2");
    // Déjà un monarque : rien.
    g = act(g, "p1", { type: "setMonarch", playerId: "p1" });
    g = act(g, "p1", { type: "passTurn" });
    expect(g.monarch).toBe("p1");
    // Contre le monarque : +1/+1 et piétinement.
    g = structuredClone(g);
    g.turn.activePlayerId = "p1";
    g.turn.step = "main1";
    g = act(g, "p1", { type: "setMonarch", playerId: "p2" });
    g = attack(g, [b]);
    expect(g.cards[b]!.ptBoost).toEqual({ power: 1, toughness: 1 });
    expect(hasKeyword(g, g.cards[b]!, "Trample")).toBe(true);
  });

  it("M'Baku : pas de bonus contre un adversaire qui n'est pas le monarque", () => {
    let g = newTestGame(3);
    let b: string;
    [g] = put(g, "p1", real("M'Baku, Jabari Chieftain"));
    [g, b] = put(g, "p1", bear("Ours"), 0);
    g = act(g, "p1", { type: "setMonarch", playerId: "p3" });
    g = attack(g, [b]);
    expect(g.cards[b]!.ptBoost).toBeUndefined();
  });

  it("Okoye : monarque en arrivant, puis double initiative contre le monarque", () => {
    let g = newTestGame(2);
    let okoye: string;
    [g, okoye] = put(g, "p1", real("Okoye, Mighty and Adored"));
    g = resolveAll(g);
    expect(g.monarch).toBe("p1");
    g = act(g, "p1", { type: "setMonarch", playerId: "p2" });
    g = act(g, "p1", { type: "nextStep", to: "beginCombat" });
    const trigger = needsTargets(g);
    if (trigger) g = act(g, "p1", { type: "chooseTargets", cardId: trigger.instanceId, targets: [{ kind: "card", id: okoye }] });
    g = resolveAll(g);
    expect(g.cards[okoye]!.counters["+1/+1"]).toBe(1);
    expect(g.cards[okoye]!.grantedTriggers?.[0]).toMatch(/attacks the monarch/);
    g = attack(g, [okoye]);
    expect(hasKeyword(g, g.cards[okoye]!, "Double strike")).toBe(true);
    expect(hasKeyword(g, g.cards[okoye]!, "Trample")).toBe(true);
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    // 4/4 en double initiative.
    expect(g.players.p2!.life).toBe(40 - 8);
    expect(g.monarch).toBe("p1");
  });

  it("The Spear of Bashenga : monarque s'il n'y en a pas, et détruit un permanent engagé du monarque attaqué", () => {
    let g = newTestGame(2);
    let spear: string, b: string, victim: string, land: string;
    [g, spear] = put(g, "p1", real("The Spear of Bashenga"));
    g = resolveAll(g);
    expect(g.monarch).toBe("p1");
    [g, b] = put(g, "p1", bear("Ours"));
    g = structuredClone(g);
    g.cards[spear]!.attachedTo = b;
    [g, victim] = put(g, "p2", bear("Ours de p2"));
    [g, land] = put(g, "p2", fakeCard("Forêt", { typeLine: "Basic Land — Forest" }));
    g = structuredClone(g);
    g.cards[victim]!.tapped = true;
    g.cards[land]!.tapped = true;
    g = act(g, "p1", { type: "setMonarch", playerId: "p2" });
    g = attack(g, [b]);
    expect(g.cards[victim]!.zone).toBe("graveyard");
    expect(g.cards[land]!.zone).toBe("battlefield");
  });

  it("The Spear of Bashenga : rien s'il y a déjà un monarque ou si l'attaqué ne l'est pas", () => {
    let g = act(newTestGame(3), "p1", { type: "setMonarch", playerId: "p3" });
    let spear: string, b: string, victim: string;
    [g, spear] = put(g, "p1", real("The Spear of Bashenga"));
    g = resolveAll(g);
    expect(g.monarch).toBe("p3");
    [g, b] = put(g, "p1", bear("Ours"));
    [g, victim] = put(g, "p2", bear("Ours de p2"));
    g = structuredClone(g);
    g.cards[spear]!.attachedTo = b;
    g.cards[victim]!.tapped = true;
    g = attack(g, [b], "p2");
    expect(g.cards[victim]!.zone).toBe("battlefield");
  });

  it("Queen Mother Ramonda : monarque en arrivant", () => {
    let g = newTestGame(2);
    [g] = put(g, "p2", real("Queen Mother Ramonda"));
    g = resolveAll(g);
    expect(g.monarch).toBe("p2");
  });

  it("Throne of the High City et King Solomon's Frogs : capacités activées", () => {
    let g = act(newTestGame(2), "p1", { type: "nextStep", to: "main1" });
    let throne: string;
    [g, throne] = put(g, "p1", real("Throne of the High City"));
    g = mana(g, "p1", "CCCC");
    g = act(g, "p1", { type: "activateAbility", cardId: throne, index: 0 });
    g = resolveAll(g);
    expect(g.monarch).toBe("p1");
    expect(g.cards[throne]?.zone ?? "graveyard").toBe("graveyard");
    g = act(g, "p1", { type: "setMonarch", playerId: "p2" });
    let frogs: string;
    [g, frogs] = put(g, "p1", real("King Solomon's Frogs"));
    g = resolveAll(g);
    g = mana(g, "p1", "CCC");
    g = act(g, "p1", { type: "activateAbility", cardId: frogs, index: 0 });
    g = resolveAll(g);
    expect(g.monarch).toBe("p1");
    expect(g.cards[frogs]!.zone).toBe("exile");
  });

  it("Nakia : quand votre commandant arrive, vous devenez le monarque", () => {
    let g = newTestGame(2);
    [g] = put(g, "p1", real("Nakia, Wakandan Operative"));
    g = resolveAll(g);
    expect(g.monarch).toBeUndefined();
    // Une autre créature : rien.
    [g] = put(g, "p1", bear("Ours"));
    g = resolveAll(g);
    expect(g.monarch).toBeUndefined();
    const commander = g.players.p1!.zones.command[0]!;
    g = act(g, "p1", { type: "moveCard", cardId: commander, to: "battlefield", force: true });
    g = resolveAll(g);
    expect(g.monarch).toBe("p1");
  });

  it("le monarque qui quitte la partie passe le titre au joueur actif", () => {
    let g = act(newTestGame(3), "p1", { type: "setMonarch", playerId: "p2" });
    g = act(g, "p2", { type: "concede" });
    expect(g.monarch).toBe("p1");
    // Le joueur actif part : le suivant dans l'ordre du tour.
    g = act(g, "p1", { type: "concede" });
    expect(g.monarch).toBe("p3");
  });
});
