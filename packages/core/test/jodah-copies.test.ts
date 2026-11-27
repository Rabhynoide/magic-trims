import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport, parseCopyExcept } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import { parseStaticLine } from "../src/statics.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame, endTurn } from "./helpers.js";
import deck from "./jodah-oracle.json" with { type: "json" };

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

/** Une carte du deck Jodah, avec son texte Oracle exact. */
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

function decide(g: GameState, accept = true): GameState {
  const card = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.awaitingDecision);
  if (!card) throw new Error("Aucune décision en attente");
  return resolveAll(act(g, card.controllerId, { type: "decideOptional", cardId: card.instanceId, accept }));
}

const toMain = (g: GameState) => act(g, g.turn.activePlayerId, { type: "nextStep", to: "main1" });

const bear = (name: string, extra: Partial<CardData> = {}) =>
  fakeCard(name, { typeLine: "Creature — Bear", manaCost: "{1}{G}", colors: ["G"], power: "2", toughness: "2", ...extra });
const LEGEND = bear("Grizzly Legend", { typeLine: "Legendary Creature — Bear", oracleText: "Whenever Grizzly Legend attacks, you gain 1 life." });

const data = (g: GameState, id: string) => g.cardData[g.cards[id]!.cardId]!;
const named = (g: GameState, player: string, name: string) => g.players[player]!.zones.battlefield.filter((id) => data(g, id).name === name);

describe("Famille 10 : lecture", () => {
  it("règle des légendes, entrer en copie, « except » des copies", () => {
    expect(parseStaticLine(`The "legend rule" doesn't apply to permanents you control.`)).toEqual({ kind: "noLegendRule", tokensOnly: false });
    expect(parseStaticLine(`The "legend rule" doesn't apply to tokens you control.`)).toEqual({ kind: "noLegendRule", tokensOnly: true });
    expect(parseStaticLine("You may have Sakashima enter as a copy of another creature you control, except it has Sakashima's other abilities.")).toEqual({ kind: "enterAsCopy", yours: true, keepOthers: true });
    expect(parseStaticLine("You may have ~ enter as a copy of any creature on the battlefield.")).toEqual({ kind: "enterAsCopy", yours: false, keepOthers: false });
    expect(parseCopyExcept("it's not legendary and it's a 2/2 black Zombie in addition to its other colors and types")).toEqual({
      nonLegendary: true,
      power: "2",
      toughness: "2",
      colors: ["B"],
      subtypes: ["Zombie"],
    });
    expect(parseCopyExcept("it's an artifact in addition to its other types")).toEqual({ types: ["Artifact"] });
    expect(parseCopyExcept("it can fly")).toBeNull();
  });

  it("Sakashima et Cadric : entièrement gérées ; Ratadrabik : seule la protection reste", () => {
    expect(cardSupport(real("Sakashima of a Thousand Faces")).level).toBe("full");
    expect(cardSupport(real("Cadric, Soul Kindler")).level).toBe("full");
    expect(cardSupport(real("Ratadrabik of Urborg")).unknown).toEqual(["Vigilance, ward {2}"]);
  });
});

describe("Règle des légendes", () => {
  it("Cadric : la copie jeton d'une légende reste, avec la célérité, puis est sacrifiée à la fin du tour", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Cadric, Soul Kindler"));
    [g] = put(g, "p1", LEGEND);
    g = resolveAll(g);
    g = mana(g, "p1", "R");
    g = decide(g);
    const legends = named(g, "p1", "Grizzly Legend");
    expect(legends).toHaveLength(2);
    const token = legends.find((id) => g.cards[id]!.isToken)!;
    expect(g.cards[token]!.grants).toContain("haste");
    g = endTurn(g, "p1");
    g = resolveAll(g);
    expect(named(g, "p1", "Grizzly Legend").filter((id) => g.cards[id]!.isToken)).toHaveLength(0);
    expect(named(g, "p1", "Grizzly Legend")).toHaveLength(1);
  });

  it("Cadric ne protège que les jetons : deux cartes légendaires du même nom, la plus ancienne part", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Cadric, Soul Kindler"));
    let first: string;
    [g, first] = put(g, "p1", LEGEND);
    g = resolveAll(g);
    g = decide(g, false);
    [g] = put(g, "p1", LEGEND);
    g = resolveAll(g);
    g = decide(g, false);
    expect(named(g, "p1", "Grizzly Legend")).toHaveLength(1);
    expect(g.cards[first]!.zone).toBe("graveyard");
  });

  it("Sakashima : la règle ne s'applique à aucun de ses permanents, mais toujours chez l'adversaire", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Sakashima of a Thousand Faces"));
    [g] = put(g, "p1", LEGEND);
    [g] = put(g, "p1", LEGEND);
    expect(named(g, "p1", "Grizzly Legend")).toHaveLength(2);
    [g] = put(g, "p2", LEGEND);
    [g] = put(g, "p2", LEGEND);
    expect(named(g, "p2", "Grizzly Legend")).toHaveLength(1);
  });
});

describe("Sakashima : arriver en copie", () => {
  it("lancée, elle copie une créature choisie et garde ses autres capacités", () => {
    let g = toMain(newTestGame(2));
    let legend: string;
    [g, legend] = put(g, "p1", LEGEND);
    let saka: string;
    [g, saka] = inHand(g, "p1", real("Sakashima of a Thousand Faces"));
    g = mana(g, "p1", "UUUU");
    g = act(g, "p1", { type: "castSpell", cardId: saka });
    g = resolveAll(g);
    const choice = g.cards[saka]!.cardChoice!;
    expect(choice.options).toEqual([legend]);
    expect(choice.min).toBe(0);
    g = act(g, "p1", { type: "chooseCards", cardId: saka, cardIds: [legend] });
    g = resolveAll(g);
    expect(g.cards[saka]!.zone).toBe("battlefield");
    const d = data(g, saka);
    expect(d.name).toBe("Grizzly Legend");
    expect(d.power).toBe("2");
    expect(d.typeLine).toBe("Legendary Creature — Bear");
    expect(d.oracleText).toContain(`The "legend rule" doesn't apply to permanents you control.`);
    expect(d.oracleText).not.toContain("enter as a copy");
    // Deux « Grizzly Legend » : la règle des légendes ne s'applique pas (capacité gardée par la copie).
    expect(named(g, "p1", "Grizzly Legend")).toHaveLength(2);
    // Hors du champ de bataille, elle redevient Sakashima.
    g = act(g, "p1", { type: "moveCard", cardId: saka, to: "hand" });
    expect(data(g, g.players.p1!.zones.hand.at(-1)!).name).toBe("Sakashima of a Thousand Faces");
    // Sans Sakashima, la règle des légendes s'applique de nouveau… et il n'en reste qu'une.
    expect(named(g, "p1", "Grizzly Legend")).toHaveLength(1);
  });

  it("sans rien choisir, elle arrive en Sakashima", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", bear("Ours"));
    let saka: string;
    [g, saka] = inHand(g, "p1", real("Sakashima of a Thousand Faces"));
    g = mana(g, "p1", "UUUU");
    g = act(g, "p1", { type: "castSpell", cardId: saka });
    g = resolveAll(g);
    g = act(g, "p1", { type: "chooseCards", cardId: saka, cardIds: [] });
    g = resolveAll(g);
    expect(data(g, saka).name).toBe("Sakashima of a Thousand Faces");
  });

  it("Clone : copie une créature adverse, sans rien garder", () => {
    let g = toMain(newTestGame(2));
    let theirs: string;
    [g, theirs] = put(g, "p2", bear("Ours adverse", { power: "5", toughness: "5" }));
    let clone: string;
    [g, clone] = inHand(g, "p1", fakeCard("Clone", { typeLine: "Creature — Shapeshifter", manaCost: "{3}{U}", colors: ["U"], power: "0", toughness: "0", oracleText: "You may have Clone enter as a copy of any creature on the battlefield." }));
    g = mana(g, "p1", "UUUU");
    g = act(g, "p1", { type: "castSpell", cardId: clone });
    g = resolveAll(g);
    g = act(g, "p1", { type: "chooseCards", cardId: clone, cardIds: [theirs] });
    g = resolveAll(g);
    expect(g.cards[clone]!.zone).toBe("battlefield");
    expect(data(g, clone).name).toBe("Ours adverse");
    expect(data(g, clone).power).toBe("5");
  });
});

describe("Ratadrabik : jeton copie Zombie", () => {
  it("une autre créature légendaire meurt : jeton copie non légendaire, 2/2, noir, Zombie", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Ratadrabik of Urborg"));
    let legend: string;
    [g, legend] = put(g, "p1", LEGEND);
    g = act(g, "p1", { type: "moveCard", cardId: legend, to: "graveyard" });
    g = resolveAll(g);
    const tokens = g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken);
    expect(tokens).toHaveLength(1);
    const d = data(g, tokens[0]!);
    expect(d.name).toBe("Grizzly Legend");
    expect(d.typeLine).toBe("Creature — Bear Zombie");
    expect([d.power, d.toughness]).toEqual(["2", "2"]);
    expect(d.colors.sort()).toEqual(["B", "G"]);
    expect(d.oracleText).toContain("Whenever Grizzly Legend attacks");
    // Le jeton n'est pas légendaire : sa mort ne redéclenche pas Ratadrabik.
    g = act(g, "p1", { type: "moveCard", cardId: tokens[0]!, to: "graveyard" });
    g = resolveAll(g);
    expect(g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken)).toHaveLength(0);
  });

  it("une créature non légendaire meurt : rien", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Ratadrabik of Urborg"));
    let ours: string;
    [g, ours] = put(g, "p1", bear("Ours"));
    g = act(g, "p1", { type: "moveCard", cardId: ours, to: "graveyard" });
    g = resolveAll(g);
    expect(g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken)).toHaveLength(0);
  });
});
