import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { abilitiesOf } from "../src/triggers.js";
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
function place(g: GameState, card: CardData, to: "battlefield" | "graveyard" | "hand", n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players.p1!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  if (to !== "hand") g = act(g, "p1", { type: "moveCard", cardId: id, to, force: true });
  delete g.cards[id]!.summoningSick;
  return [g, id];
}

function resolveAll(g: GameState): GameState {
  for (let i = 0; i < 50 && g.priority && g.stack.length > 0; i++) g = act(g, g.priority.playerId, { type: "passPriority" });
  return g;
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const KETHIS = real("Kethis, the Hidden Hand");
const LEGEND_A = fakeCard("Legend A", { typeLine: "Legendary Creature — Elf", manaCost: "{G}", manaValue: 1, colors: ["G"], power: "1", toughness: "1" });
const LEGEND_B = fakeCard("Legend B", { typeLine: "Legendary Artifact", manaCost: "{1}", manaValue: 1, colors: [] });
const LEGEND_C = fakeCard("Legend C", { typeLine: "Legendary Creature — Human", manaCost: "{W}", manaValue: 1, colors: ["W"], power: "2", toughness: "2" });
const OTAWARA = real("Otawara, Soaring City");
const COMMON = fakeCard("Common Bear", { typeLine: "Creature — Bear", manaCost: "{G}", manaValue: 1, colors: ["G"], power: "2", toughness: "2" });

/** Kethis en jeu ; au cimetière : A, B (à exiler), C, Otawara, et un ours non légendaire. */
function setup(): { g: GameState; kethis: string; a: string; b: string; c: string; land: string; bear: string } {
  let g = toMain(newTestGame(2));
  let kethis: string, a: string, b: string, c: string, land: string, bear: string;
  // On place en partant de la fin de la main, pour que les indices restent valables.
  [g, kethis] = place(g, KETHIS, "battlefield", 0);
  [g, a] = place(g, LEGEND_A, "graveyard", 0);
  [g, b] = place(g, LEGEND_B, "graveyard", 0);
  [g, c] = place(g, LEGEND_C, "graveyard", 0);
  [g, land] = place(g, OTAWARA, "graveyard", 0);
  [g, bear] = place(g, COMMON, "graveyard", 0);
  return { g, kethis, a, b, c, land, bear };
}

describe("Kethis : jouer les cartes légendaires depuis le cimetière", () => {
  it("lit le coût (exiler deux cartes légendaires du cimetière) et l'effet ; Kethis est entièrement gérée", () => {
    const ability = abilitiesOf(KETHIS, 0).activated[0]!;
    expect(ability.cost.exileFromGraveyard).toEqual({ count: 2, filter: { types: [], whose: "you", legendary: true } });
    expect(ability.effects.effects).toEqual([{ type: "graveyardPlayable", filter: { types: [], whose: "you", legendary: true }, lands: true }]);
    expect(cardSupport(KETHIS).unknown.filter((u) => /graveyard/.test(u))).toEqual([]);
  });

  it("refuse un mauvais coût : une seule carte, une carte non légendaire, deux fois la même", () => {
    const { g, kethis, a, b, bear } = setup();
    expect(fails(g, "p1", { type: "activateAbility", cardId: kethis, index: 0, exile: [a] })).toMatch(/Choisis 2/);
    expect(fails(g, "p1", { type: "activateAbility", cardId: kethis, index: 0, exile: [a, bear] })).toMatch(/exiler 2/);
    expect(fails(g, "p1", { type: "activateAbility", cardId: kethis, index: 0, exile: [a, a] })).toMatch(/Choisis 2/);
    void b;
  });

  it("exile les deux cartes, puis on lance une légende et on joue un terrain légendaire depuis le cimetière", () => {
    let { g, kethis, a, b, c, land, bear } = setup();
    g = act(g, "p1", { type: "activateAbility", cardId: kethis, index: 0, exile: [a, b] });
    expect(g.cards[a]!.zone).toBe("exile");
    expect(g.cards[b]!.zone).toBe("exile");
    g = resolveAll(g);
    expect(g.cards[c]!.castPermission).toMatchObject({ free: false, lands: true });
    expect(g.cards[bear]!.castPermission).toBeUndefined();
    // Pas sans payer : il faut le mana.
    expect(fails(g, "p1", { type: "castSpell", cardId: c })).toBeTruthy();
    g = act(g, "p1", { type: "adjustMana", mana: "W", delta: 1 });
    g = act(g, "p1", { type: "castSpell", cardId: c });
    g = resolveAll(g);
    expect(g.cards[c]!.zone).toBe("battlefield");
    // Le non-légendaire reste au cimetière.
    expect(fails(g, "p1", { type: "castSpell", cardId: bear })).toBeTruthy();
    // Terrain légendaire : compte comme le terrain du tour.
    g = act(g, "p1", { type: "playLand", cardId: land });
    expect(g.cards[land]!.zone).toBe("battlefield");
    expect(g.players.p1!.landsPlayed).toBe(1);
  });

  it("la permission ne dure que ce tour, et ne touche pas les cartes arrivées au cimetière après", () => {
    let { g, kethis, a, b, c } = setup();
    g = act(g, "p1", { type: "activateAbility", cardId: kethis, index: 0, exile: [a, b] });
    g = resolveAll(g);
    let late: string;
    [g, late] = place(g, fakeCard("Late Legend", { typeLine: "Legendary Creature — Elf", manaCost: "{G}", manaValue: 1, colors: ["G"], power: "1", toughness: "1" }), "graveyard", 0);
    expect(g.cards[late]!.castPermission).toBeUndefined();
    g = endTurn(g, "p1");
    g = endTurn(g, "p2");
    g = toMain(g);
    g = act(g, "p1", { type: "adjustMana", mana: "W", delta: 1 });
    expect(fails(g, "p1", { type: "castSpell", cardId: c })).toBeTruthy();
  });
});
