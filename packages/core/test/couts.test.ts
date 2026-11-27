import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { hasKeyword } from "../src/combat.js";
import { cardSupport, parseSpellEffects } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import { costReductions, parseStaticLine, selfCostReduction } from "../src/statics.js";
import type { ManaType } from "../src/mana.js";
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

type OracleCard = { name: string; typeLine: string; oracleText?: string; manaCost?: string; power?: string; toughness?: string; colors?: string[] };

/** Une carte du deck Jodah, avec son texte Oracle exact. */
function real(name: string): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, {
    typeLine: c.typeLine,
    oracleText: c.oracleText ?? "",
    manaCost: c.manaCost ?? "",
    colors: c.colors ?? [],
    ...(c.power ? { power: c.power, toughness: c.toughness } : {}),
  });
}

/** Donne les données de `card` à la n-ième carte de la main du joueur. */
function inHand(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  const cardId = g.cards[id]!.cardId;
  g.cardData[cardId] = { ...card, id: cardId };
  return [g, id];
}

/** Met une carte de la main du joueur sur le champ de bataille. */
function put(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  let id: string;
  [g, id] = inHand(g, playerId, card, n);
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  delete g.cards[id]!.summoningSick;
  return [g, id];
}

function mana(g: GameState, playerId: string, pool: string): GameState {
  for (const m of pool.match(/[WUBRGC]/g) ?? []) g = act(g, playerId, { type: "adjustMana", mana: m as ManaType, delta: 1 });
  return g;
}

function poolSize(g: GameState, playerId: string): number {
  return Object.values(g.players[playerId]!.manaPool).reduce((a, b) => a + b, 0);
}

function resolveAll(g: GameState, max = 100): GameState {
  for (let i = 0; i < max && g.priority && g.stack.length > 0; i++) g = act(g, g.priority.playerId, { type: "passPriority" });
  return g;
}

/** Le commandant du joueur, mis sur le champ de bataille. */
function commanderOut(g: GameState, playerId: string): GameState {
  const id = g.players[playerId]!.zones.command[0]!;
  return act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const creature = (name: string, power: string, extra: Partial<CardData> = {}) =>
  fakeCard(name, { typeLine: "Creature — Beast", power, toughness: power, manaCost: "{1}{G}", colors: ["G"], ...extra });

describe("Réductions de coût et sorts gratuits", () => {
  it("Kethis : les sorts légendaires coûtent {1} de moins, pas les autres", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Kethis, the Hidden Hand"));
    let legend: string, bear: string;
    [g, legend] = inHand(g, "p1", fakeCard("Héros", { typeLine: "Legendary Creature — Human", manaCost: "{2}{W}", colors: ["W"], power: "2", toughness: "2" }));
    [g, bear] = inHand(g, "p1", creature("Ours", "2", { manaCost: "{2}{G}" }), 1);
    g = mana(g, "p1", "GG");
    expect(refuse(g, "p1", { type: "castSpell", cardId: bear })).toMatch(/Pas assez de mana/);
    g = mana(g, "p1", "WW");
    g = act(g, "p1", { type: "castSpell", cardId: legend });
    expect(poolSize(g, "p1")).toBe(2);
    expect(g.log.at(-1)!.message).toContain("réduction de {1}");
  });

  it("The Great Henge : coûte {X} de moins, X = la plus grande force parmi mes créatures", () => {
    let g = toMain(newTestGame(2));
    let henge: string;
    [g, henge] = inHand(g, "p1", real("The Great Henge"));
    expect(selfCostReduction(g, "p1", g.cards[henge]!, 0)).toBe(0);
    [g] = put(g, "p1", creature("Petit", "2"), 1);
    [g] = put(g, "p1", creature("Gros", "5"), 1);
    // La créature de l'adversaire ne compte pas.
    [g] = put(g, "p2", creature("Géant", "9"));
    expect(selfCostReduction(g, "p1", g.cards[henge]!, 0)).toBe(5);
    g = mana(g, "p1", "GGG");
    expect(refuse(g, "p1", { type: "castSpell", cardId: henge })).toMatch(/Pas assez de mana/);
    g = mana(g, "p1", "G");
    g = act(g, "p1", { type: "castSpell", cardId: henge });
    expect(poolSize(g, "p1")).toBe(0);
    g = resolveAll(g);
    expect(g.cards[henge]!.zone).toBe("battlefield");
  });

  it("Flawless Maneuver : gratuit seulement si je contrôle un commandant", () => {
    let g = toMain(newTestGame(2));
    let spell: string, bear: string;
    [g, bear] = put(g, "p1", creature("Ours", "2"));
    [g, spell] = inHand(g, "p1", real("Flawless Maneuver"));
    expect(parseSpellEffects(g.cardData[g.cards[spell]!.cardId]!.oracleText, "Flawless Maneuver").alternativeIf).toBe("commander");
    expect(refuse(g, "p1", { type: "castSpell", cardId: spell, alternative: true })).toMatch(/commandant/);
    g = commanderOut(g, "p1");
    g = act(g, "p1", { type: "castSpell", cardId: spell, alternative: true });
    expect(g.log.at(-1)!.message).toContain("en payant rien");
    g = resolveAll(g);
    expect(hasKeyword(g, g.cards[bear]!, "Indestructible")).toBe(true);
    g = endTurn(g, "p1");
    expect(hasKeyword(g, g.cards[bear]!, "Indestructible")).toBe(false);
  });

  it("Fierce Guardianship : contrecarre gratuitement un sort non-créature", () => {
    let g = toMain(newTestGame(2));
    g = commanderOut(g, "p2");
    let counter: string, rite: string;
    [g, counter] = inHand(g, "p2", real("Fierce Guardianship"));
    [g, rite] = inHand(g, "p1", fakeCard("Rituel", { typeLine: "Sorcery", manaCost: "{B}", colors: ["B"], oracleText: "Draw a card." }));
    g = mana(g, "p1", "B");
    g = act(g, "p1", { type: "castSpell", cardId: rite });
    g = act(g, "p1", { type: "passPriority" });
    g = act(g, "p2", { type: "castSpell", cardId: counter, alternative: true, targets: [{ kind: "card", id: rite }] });
    g = resolveAll(g);
    expect(g.cards[rite]!.zone).toBe("graveyard");
    expect(g.cards[counter]!.zone).toBe("graveyard");
  });

  it("augmentations de coût : pour tous, ou seulement pour les adversaires", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p2", fakeCard("Gardienne", { typeLine: "Creature — Human Soldier", oracleText: "First strike\nNoncreature spells cost {1} more to cast.", power: "2", toughness: "1" }));
    [g] = put(g, "p2", fakeCard("Taxeur", { typeLine: "Creature — Human", oracleText: "Spells your opponents cast cost {1} more to cast.", power: "1", toughness: "1" }), 1);
    expect(costReductions(g, "p1", { typeLine: "Instant", colors: ["R"] }).generic).toBe(-2);
    expect(costReductions(g, "p2", { typeLine: "Instant", colors: ["R"] }).generic).toBe(-1);
    expect(costReductions(g, "p1", { typeLine: "Creature — Bear", colors: ["G"] }).generic).toBe(-1);
    let bolt: string;
    [g, bolt] = inHand(g, "p1", fakeCard("Éclair", { typeLine: "Instant", manaCost: "{R}", colors: ["R"], oracleText: "~ deals 3 damage to any target." }));
    g = mana(g, "p1", "RR");
    expect(refuse(g, "p1", { type: "castSpell", cardId: bolt, targets: [{ kind: "player", id: "p2" }] })).toMatch(/Pas assez de mana/);
    g = mana(g, "p1", "R");
    g = act(g, "p1", { type: "castSpell", cardId: bolt, targets: [{ kind: "player", id: "p2" }] });
    expect(g.log.at(-1)!.message).toContain("surcoût de {2}");
  });

  it("lit les autres formes de réduction et d'augmentation", () => {
    const red = (l: string) => parseStaticLine(l);
    expect(red("Legendary spells you cast cost {1} less to cast.")).toMatchObject({ kind: "costReduction", amount: 1, legendary: true });
    expect(red("Dragon spells you cast cost {1} less to cast.")).toMatchObject({ kind: "costReduction", subtypes: ["Dragon"] });
    expect(red("Angel spells and Human spells you cast cost {1} less to cast.")).toMatchObject({ subtypes: ["Angel", "Human"] });
    expect(red("Aura and Equipment spells you cast cost {1} less to cast.")).toMatchObject({ subtypes: ["Aura", "Equipment"] });
    expect(red("Instant and sorcery spells you cast cost {1} less to cast.")).toMatchObject({ types: ["instant", "sorcery"] });
    expect(red("Colorless spells you cast cost {2} less to cast.")).toMatchObject({ amount: 2, colorless: true });
    expect(red("Black creature spells you cast cost {1} less to cast.")).toMatchObject({ colors: ["B"], types: ["creature"] });
    expect(red("Noncreature spells cost {1} more to cast.")).toMatchObject({ amount: -1, notTypes: ["creature"], everyone: true });
    expect(red("Spells your opponents cast cost {1} more to cast.")).toMatchObject({ amount: -1, opponents: true });
    expect(red("~ costs {1} less to cast for each creature on the battlefield.")).toMatchObject({ kind: "selfCost", amount: 1, per: { kind: "permanents" } });
    expect(red("This spell costs {1} less to cast for each creature your opponents control.")).toMatchObject({ kind: "selfCost" });
    expect(red("This spell costs {X} less to cast, where X is the total power of creatures you control.")).toMatchObject({ kind: "selfCost", x: { kind: "power", total: true } });
    // Ce qui n'est pas compris reste non géré.
    expect(red("Creature spells you cast with power 4 or greater cost {1} less to cast.")).toBeNull();
    expect(red("This spell costs {1} less to cast for each attacking creature.")).toBeNull();
  });

  it("Blasphemous Act : {1} de moins par créature sur le champ de bataille", () => {
    let g = toMain(newTestGame(2));
    let act2: string;
    [g, act2] = inHand(g, "p1", fakeCard("Blasphemous Act", { typeLine: "Sorcery", manaCost: "{8}{R}", colors: ["R"], oracleText: "This spell costs {1} less to cast for each creature on the battlefield.\nBlasphemous Act deals 13 damage to each creature." }), 0);
    [g] = put(g, "p1", creature("A", "1"), 1);
    [g] = put(g, "p2", creature("B", "1"));
    [g] = put(g, "p2", creature("C", "1"));
    expect(selfCostReduction(g, "p1", g.cards[act2]!, 0)).toBe(3);
  });

  it("les cartes de la famille sont gérées (sauf les lignes d'autres familles)", () => {
    const unknown = (n: string) => cardSupport(real(n)).unknown;
    expect(cardSupport(real("Flawless Maneuver")).level).toBe("full");
    expect(cardSupport(real("Fierce Guardianship")).level).toBe("full");
    expect(unknown("The Great Henge").some((l) => /less to cast/.test(l))).toBe(false);
    expect(unknown("Kethis, the Hidden Hand").some((l) => /less to cast/.test(l))).toBe(false);
  });
});
