import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { canAttack, canBlock } from "../src/combat.js";
import { cardSupport } from "../src/effects.js";
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
  if (r.ok) throw new Error("action acceptée");
  return r.error;
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

const bear = (name: string, power = "2") => fakeCard(name, { typeLine: "Creature — Bear", power, toughness: "2" });
const toAttackers = (g: GameState) => act(g, "p1", { type: "nextStep", to: "declareAttackers" });

describe("Wakanda : restrictions de combat", () => {
  it("Bast ne peut attaquer ni bloquer qu'avec trois créatures ou plus", () => {
    let g = newTestGame(3);
    let bast: string;
    [g, bast] = put(g, "p1", real("Bast, Panther Goddess"));
    expect(canAttack(g, g.cards[bast]!)).toBe(false);
    expect(canBlock(g, g.cards[bast]!)).toBe(false);
    [g] = put(g, "p1", bear("Ours A"));
    g = toAttackers(g);
    expect(refuse(g, "p1", { type: "declareAttackers", attackers: [{ cardId: bast, defender: "p2" }] })).toMatch(/ne peut pas attaquer/);
    expect(canAttack(g, g.cards[bast]!)).toBe(false);
    [g] = put(g, "p1", bear("Ours B"));
    expect(canAttack(g, g.cards[bast]!)).toBe(true);
    expect(canBlock(g, g.cards[bast]!)).toBe(true);
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: bast, defender: "p2" }] });
    expect(g.combat?.attackers[bast]).toBe("p2");
  });

  it("Whispersilk Cloak : la créature équipée ne peut pas être bloquée et a le linceul", () => {
    let g = newTestGame(3);
    let a: string, other: string, cloak: string, b: string;
    [g, a] = put(g, "p1", bear("Porteur"));
    [g, other] = put(g, "p1", bear("Autre"));
    [g, cloak] = put(g, "p1", real("Whispersilk Cloak"));
    [g, b] = put(g, "p2", bear("Bloqueur"));
    g = structuredClone(g);
    g.cards[cloak]!.attachedTo = a;
    expect(canBlock(g, g.cards[b]!, g.cards[a]!)).toBe(false);
    g = toAttackers(g);
    g = act(g, "p1", {
      type: "declareAttackers",
      attackers: [
        { cardId: a, defender: "p2" },
        { cardId: other, defender: "p2" },
      ],
    });
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    expect(g.turn.step).toBe("declareBlockers");
    expect(refuse(g, "p2", { type: "declareBlockers", blocks: [{ cardId: b, attackerId: a }] })).toMatch(/ne peut pas être bloqué/);
    const life = g.players.p2!.life;
    g = act(g, "p2", { type: "declareBlockers", blocks: [{ cardId: b, attackerId: other }] });
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    expect(g.players.p2!.life).toBe(life - 2);
  });

  it("Queen Mother Ramonda : les créatures de force 2 ou moins ne peuvent pas attaquer le monarque", () => {
    let g = newTestGame(3);
    let small: string, big: string;
    [g, small] = put(g, "p1", bear("Petit"));
    [g, big] = put(g, "p1", bear("Gros", "3"));
    [g] = put(g, "p2", real("Queen Mother Ramonda"));
    // En arrivant, Ramonda fait de p2 le monarque : on résout ce déclencheur, puis on retire le titre.
    for (let i = 0; i < 20 && g.priority && g.stack.length > 0; i++) g = act(g, g.priority.playerId, { type: "passPriority" });
    expect(g.monarch).toBe("p2");
    g = act(g, "p1", { type: "setMonarch", playerId: null });
    g = toAttackers(g);
    // p2 n'est pas le monarque : pas de restriction.
    expect(applyAction(g, { actorId: "p1", action: { type: "declareAttackers", attackers: [{ cardId: small, defender: "p2" }] } }).ok).toBe(true);
    g = structuredClone(g);
    g.monarch = "p2";
    expect(refuse(g, "p1", { type: "declareAttackers", attackers: [{ cardId: small, defender: "p2" }] })).toMatch(/force 2 ou moins/);
    g = act(g, "p1", {
      type: "declareAttackers",
      attackers: [
        { cardId: big, defender: "p2" },
        { cardId: small, defender: "p3" },
      ],
    });
    expect(g.combat?.attackers[big]).toBe("p2");
  });

  it("« can't be blocked this turn » : sur une cible ou sur soi-même", () => {
    const rogue = fakeCard("Passage", { typeLine: "Land", oracleText: "{T}: Add {C}.\n{4}, {T}: Target creature can't be blocked this turn." });
    const self = fakeCard("Ombre", { typeLine: "Creature — Shade", power: "1", toughness: "1", oracleText: "{2}{U}: This creature can't be blocked this turn." });
    expect(cardSupport(rogue).level).toBe("full");
    expect(cardSupport(self).level).toBe("full");
    expect(cardSupport(fakeCard("Furtif", { typeLine: "Creature — Rogue", oracleText: "This creature can't be blocked." })).level).toBe("full");
  });

  it("les cartes de la famille sont lues en entier (Ramonda : sauf le monarque, fait ailleurs)", () => {
    expect(cardSupport(real("Whispersilk Cloak")).level).toBe("full");
    expect(cardSupport(real("Bast, Panther Goddess")).unknown.filter((l) => /can't attack/.test(l))).toEqual([]);
    expect(cardSupport(real("Queen Mother Ramonda")).unknown.filter((l) => /can't attack/.test(l))).toEqual([]);
  });
});
