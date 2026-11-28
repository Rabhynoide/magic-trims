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

type OracleCard = { name: string; typeLine: string; oracleText?: string; manaCost?: string; power?: string; toughness?: string; colors?: string[] };

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

function put(g: GameState, playerId: string, card: CardData): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[0]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  delete g.cards[id]!.summoningSick;
  return [g, id];
}

/** Remplace les cartes du dessus de la bibliothèque par celles voulues. */
function library(g: GameState, playerId: string, cards: CardData[]): [GameState, string[]] {
  g = structuredClone(g);
  const ids = g.players[playerId]!.zones.library.slice(0, cards.length);
  ids.forEach((id, i) => (g.cardData[g.cards[id]!.cardId] = { ...cards[i]!, id: g.cards[id]!.cardId }));
  return [g, ids];
}

function mana(g: GameState, playerId: string, pool: string): GameState {
  for (const m of pool.match(/[WUBRGC]/g) ?? []) g = act(g, playerId, { type: "adjustMana", mana: m as "B", delta: 1 });
  return g;
}

function resolveAll(g: GameState, max = 100): GameState {
  for (let i = 0; i < max && g.priority && g.stack.length > 0; i++) {
    if (g.stack.some((id) => g.cards[id]!.cardChoice)) break;
    g = act(g, g.priority.playerId, { type: "passPriority" });
  }
  return g;
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const legend = (name: string, mv: number, type = "Creature — Human") =>
  fakeCard(name, { typeLine: `Legendary ${type}`, manaValue: mv, manaCost: `{${mv}}`, power: "1", toughness: "1" });

describe("Tuteur filtré", () => {
  it("lit la capacité de Sisay : permanent légendaire, valeur de mana inférieure à sa force", () => {
    const sisay = real("Sisay, Weatherlight Captain");
    const line = sisay.oracleText.split("\n")[1]!.split(": ")[1]!;
    const fx = parseSpellEffects(line, sisay.name);
    expect(fx.unknown).toEqual([]);
    expect(fx.effects[0]).toMatchObject({ type: "search", types: ["permanent"], legendary: true, to: "battlefield", mv: { cmp: "lt", amount: { q: { stat: "power", of: "self" } } } });
    expect(fx.effects[1]).toMatchObject({ type: "shuffle" });
    expect(cardSupport(sisay).unknown).toEqual([]);
  });

  it("autres formes : « mana value 3 or less », types multiples", () => {
    const fx = parseSpellEffects("Search your library for a creature or artifact card with mana value 3 or less, reveal it, put it into your hand, then shuffle.", "Test");
    expect(fx.unknown).toEqual([]);
    expect(fx.effects[0]).toMatchObject({ type: "search", types: ["creature", "artifact"], to: "hand", reveal: true, mv: { cmp: "le", amount: 3 } });
  });

  it("Sisay cherche un permanent légendaire de valeur de mana inférieure à sa force", () => {
    let g = toMain(newTestGame(2));
    let sisay: string;
    [g, sisay] = put(g, "p1", real("Sisay, Weatherlight Captain"));
    // Une légende bleue-noire : Sisay passe à 4/4, donc valeur de mana < 4.
    [g] = put(g, "p1", fakeCard("Duo", { typeLine: "Legendary Creature — Human", power: "1", toughness: "1", colors: ["U", "B"] }));
    expect(creatureStats(g, g.cards[sisay]!).power).toBe(4);
    let ids: string[];
    [g, ids] = library(g, "p1", [
      legend("Petite légende", 3),
      legend("Grosse légende", 4),
      fakeCard("Ours", { typeLine: "Creature — Bear", manaValue: 1 }),
      legend("Sort légendaire", 1, "Sorcery"),
      legend("Relique", 0, "Artifact"),
    ]);
    g = mana(g, "p1", "WUBRG");
    g = act(g, "p1", { type: "activateAbility", cardId: sisay, index: 0 });
    g = resolveAll(g);
    const top = g.cards[g.stack.at(-1)!]!;
    expect(new Set(top.cardChoice?.options)).toEqual(new Set([ids[0], ids[4]]));
    expect(top.cardChoice?.label).toMatch(/légendaire permanent, valeur de mana inférieure à 4/);
    g = act(g, "p1", { type: "chooseCards", cardId: top.instanceId, cardIds: [ids[0]!] });
    g = resolveAll(g);
    expect(g.cards[ids[0]!]!.zone).toBe("battlefield");
    expect(g.cards[ids[0]!]!.controllerId).toBe("p1");
    expect(g.log.some((l) => /mélange sa bibliothèque/.test(l.message))).toBe(true);
    g = endTurn(g, "p1");
  });

  it("aucune carte admissible : la recherche ne trouve rien", () => {
    let g = toMain(newTestGame(2));
    let sisay: string;
    [g, sisay] = put(g, "p1", real("Sisay, Weatherlight Captain"));
    g = structuredClone(g);
    for (const id of g.players.p1!.zones.library) g.cardData[g.cards[id]!.cardId] = { ...legend(`L${id}`, 5), id: g.cards[id]!.cardId };
    g = mana(g, "p1", "WUBRG");
    g = act(g, "p1", { type: "activateAbility", cardId: sisay, index: 0 });
    g = resolveAll(g);
    expect(g.stack).toHaveLength(0);
    expect(g.log.some((l) => /ne prend aucune carte/.test(l.message))).toBe(true);
  });
});
