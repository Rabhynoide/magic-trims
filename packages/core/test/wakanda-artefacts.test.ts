import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import { selfCostReduction } from "../src/statics.js";
import type { ManaType } from "../src/mana.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame } from "./helpers.js";
import deck from "./wakanda-oracle.json" with { type: "json" };

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

type OracleCard = { name: string; typeLine: string; oracleText?: string; manaCost?: string; manaValue?: number; power?: string; toughness?: string; colors?: string[] };

/** Une carte du deck Wakanda Forever, avec son texte Oracle exact. */
function real(name: string): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, {
    typeLine: c.typeLine,
    oracleText: c.oracleText ?? "",
    manaCost: c.manaCost ?? "",
    manaValue: c.manaValue ?? 0,
    colors: c.colors ?? [],
    ...(c.power ? { power: c.power, toughness: c.toughness } : {}),
  });
}

function inHand(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  const cardId = g.cards[id]!.cardId;
  g.cardData[cardId] = { ...card, id: cardId };
  return [g, id];
}

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

function resolveAll(g: GameState, max = 100): GameState {
  for (let i = 0; i < max && g.priority && g.stack.length > 0; i++) g = act(g, g.priority.playerId, { type: "passPriority" });
  return g;
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const trinket = (name: string, mv: number) => fakeCard(name, { typeLine: "Artifact", manaCost: `{${mv}}`, manaValue: mv, colors: [] });
const bear = (name: string) => fakeCard(name, { typeLine: "Creature — Bear", power: "2", toughness: "2", manaCost: "{1}{G}", colors: ["G"] });

describe("Wakanda : coûts des artefacts", () => {
  it("Panther Robot (affinité pour les artefacts) : {1} de moins par artefact", () => {
    let g = toMain(newTestGame(2));
    let robot: string;
    [g, robot] = inHand(g, "p1", real("Panther Robot"), 0);
    [g] = put(g, "p1", trinket("Bibelot", 1), 1);
    [g] = put(g, "p1", trinket("Gadget", 3), 1);
    [g] = put(g, "p2", trinket("Chez l'adversaire", 2));
    expect(selfCostReduction(g, "p1", g.cards[robot]!, 0)).toBe(2);
    g = mana(g, "p1", "CCCCCCCC");
    g = act(g, "p1", { type: "castSpell", cardId: robot });
    expect(g.log.some((l) => l.message.includes("réduction de {2}"))).toBe(true);
  });

  it("Metalwork Colossus : {X} de moins, X = valeur de mana totale des artefacts non-créatures", () => {
    let g = toMain(newTestGame(2));
    let colossus: string;
    [g, colossus] = inHand(g, "p1", real("Metalwork Colossus"), 0);
    [g] = put(g, "p1", trinket("Bibelot", 2), 1);
    [g] = put(g, "p1", trinket("Gadget", 4), 1);
    [g] = put(g, "p1", fakeCard("Golem", { typeLine: "Artifact Creature — Golem", power: "3", toughness: "3", manaCost: "{3}", manaValue: 3 }), 1);
    expect(selfCostReduction(g, "p1", g.cards[colossus]!, 0)).toBe(6);
  });

  it("Vanquish the Horde : {1} de moins par créature sur le champ de bataille", () => {
    let g = toMain(newTestGame(2));
    let vanquish: string;
    [g, vanquish] = inHand(g, "p1", real("Vanquish the Horde"), 0);
    [g] = put(g, "p1", bear("A"), 1);
    [g] = put(g, "p2", bear("B"));
    [g] = put(g, "p2", bear("C"));
    expect(selfCostReduction(g, "p1", g.cards[vanquish]!, 0)).toBe(3);
  });

  it("Dispatch : engage la créature, l'exile avec trois artefacts (métal)", () => {
    for (const artifacts of [2, 3]) {
      let g = toMain(newTestGame(2));
      let dispatch: string, victim: string;
      [g, dispatch] = inHand(g, "p1", real("Dispatch"), 0);
      for (let i = 0; i < artifacts; i++) [g] = put(g, "p1", trinket(`Bibelot ${i}`, 1), 1);
      [g, victim] = put(g, "p2", bear("Cible"));
      g = mana(g, "p1", "W");
      g = act(g, "p1", { type: "castSpell", cardId: dispatch, targets: [{ kind: "card", id: victim }] });
      g = resolveAll(g);
      const c = g.cards[victim]!;
      if (artifacts === 3) expect(c.zone).toBe("exile");
      else {
        expect(c.zone).toBe("battlefield");
        expect(c.tapped).toBe(true);
      }
    }
  });

  it("Ingenious Smith : un marqueur quand des artefacts arrivent, une seule fois par tour", () => {
    let g = toMain(newTestGame(2));
    let smith: string, a: string, b: string;
    [g, smith] = put(g, "p1", real("Ingenious Smith"), 0);
    [g, a] = inHand(g, "p1", trinket("Bibelot", 0), 0);
    [g, b] = inHand(g, "p1", trinket("Gadget", 0), 1);
    g = act(g, "p1", { type: "castSpell", cardId: a });
    g = resolveAll(g);
    g = resolveAll(g);
    expect(g.cards[smith]!.counters["+1/+1"] ?? 0).toBe(1);
    g = act(g, "p1", { type: "castSpell", cardId: b });
    g = resolveAll(g);
    g = resolveAll(g);
    expect(g.cards[smith]!.counters["+1/+1"] ?? 0).toBe(1);
  });

  it("les lignes de coût de la famille sont gérées", () => {
    const unknown = (n: string) => cardSupport(real(n)).unknown;
    for (const n of ["Panther Robot", "Vanquish the Horde", "Dispatch"]) expect(cardSupport(real(n)).level).toBe("full");
    expect(unknown("Metalwork Colossus").some((l) => /less to cast/.test(l))).toBe(false);
    expect(unknown("Ingenious Smith").some((l) => /artifacts you control enter/.test(l))).toBe(false);
  });
});
