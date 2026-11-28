import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import { creatureStats, hasKeyword } from "../src/combat.js";
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

/** Met la n-ième carte de la main du joueur sur le champ de bataille avec ces données (sans mal d'invocation). */
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

const bear = (name: string, extra: Partial<CardData> = {}) =>
  fakeCard(name, { typeLine: "Creature — Bear", manaCost: "{1}{G}", colors: ["G"], power: "2", toughness: "2", ...extra });
const rock = (name: string) => fakeCard(name, { typeLine: "Artifact", manaCost: "{1}" });

/** p1 déclare ses attaquants contre p2 (sans résoudre les déclencheurs). */
function declare(g: GameState, attackers: string[], defender = "p2"): GameState {
  g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
  return act(g, "p1", { type: "declareAttackers", attackers: attackers.map((cardId) => ({ cardId, defender })) });
}

const abilitiesOf = (g: GameState, source: string) => g.stack.map((id) => g.cards[id]!).filter((c) => c.ability?.sourceId === source);
const hand = (g: GameState, p: string) => g.players[p]!.zones.hand.length;

describe("Wakanda famille 3 : déclencheurs d'attaque", () => {
  it("Everett, Storm, Shuri, Coveted Jewel et Sword of the Animist sont entièrement gérés", () => {
    for (const name of ["Everett K. Ross, Hapless Attaché", "Storm, Queen of Wakanda", "Shuri, the Black Panther", "Coveted Jewel", "Sword of the Animist"]) {
      expect(cardSupport(real(name)), name).toEqual({ level: "full", unknown: [] });
    }
    // Bast : il ne reste que la restriction d'attaque (famille 11).
    expect(cardSupport(real("Bast, Panther Goddess")).unknown).toEqual(["Bast can't attack or block unless you control three or more creatures."]);
  });

  it("Bast : une seule fois par attaque, +X/+X où X est le nombre de vos créatures", () => {
    let g = newTestGame(2);
    let a: string, b: string, bast: string;
    [g, bast] = put(g, "p1", real("Bast, Panther Goddess"));
    [g, a] = put(g, "p1", bear("Ours A"));
    [g, b] = put(g, "p1", bear("Ours B"));
    g = declare(g, [a, b]);
    const triggers = abilitiesOf(g, bast);
    expect(triggers).toHaveLength(1);
    // Deux attaquants : p1 choisit la cible.
    expect(triggers[0]!.ability?.needsTargets).toBeTruthy();
    g = act(g, "p1", { type: "chooseTargets", cardId: triggers[0]!.instanceId, targets: [{ kind: "card", id: b }] });
    g = resolveAll(g);
    expect(creatureStats(g, g.cards[b]!)).toMatchObject({ power: 5, toughness: 5 });
    expect(creatureStats(g, g.cards[a]!)).toMatchObject({ power: 2, toughness: 2 });
  });

  it("Everett : l'adversaire attaque avec deux créatures ou plus, on pioche", () => {
    let g = newTestGame(2);
    let a: string, b: string;
    [g] = put(g, "p2", real("Everett K. Ross, Hapless Attaché"));
    [g, a] = put(g, "p1", bear("Ours A"));
    [g, b] = put(g, "p1", bear("Ours B"));
    const before = hand(g, "p2");
    g = resolveAll(declare(g, [a, b]));
    expect(hand(g, "p2")).toBe(before + 1);
  });

  it("Everett : une seule créature ne suffit pas", () => {
    let g = newTestGame(2);
    let a: string;
    [g] = put(g, "p2", real("Everett K. Ross, Hapless Attaché"));
    [g, a] = put(g, "p1", bear("Ours A"));
    const before = hand(g, "p2");
    g = resolveAll(declare(g, [a]));
    expect(hand(g, "p2")).toBe(before);
  });

  it("Storm attaque : une autre créature attaquante gagne le vol et +X/+0 (X = force de Storm)", () => {
    let g = newTestGame(2);
    let a: string, storm: string;
    [g, storm] = put(g, "p1", real("Storm, Queen of Wakanda"));
    [g, a] = put(g, "p1", bear("Ours A"));
    g = resolveAll(declare(g, [storm, a]));
    expect(creatureStats(g, g.cards[a]!)).toMatchObject({ power: 6, toughness: 2 });
    expect(hasKeyword(g, g.cards[a]!, "Flying")).toBe(true);
    expect(creatureStats(g, g.cards[storm]!)).toMatchObject({ power: 4, toughness: 5 });
  });

  it("Storm : une créature volante qui vous attaque subit des blessures égales à sa force", () => {
    let g = newTestGame(2);
    let flyer: string, walker: string;
    [g] = put(g, "p2", real("Storm, Queen of Wakanda"));
    [g, flyer] = put(g, "p1", bear("Oiseau", { keywords: ["Flying"], oracleText: "Flying", power: "3", toughness: "3" }));
    [g, walker] = put(g, "p1", bear("Ours A"));
    g = resolveAll(declare(g, [flyer, walker]));
    expect(g.cards[flyer]!.zone).toBe("graveyard");
    expect(g.cards[walker]!.zone).toBe("battlefield");
  });

  it("Shuri attaque : pioche avec trois artefacts, +2/+2 à vos créatures avec six", () => {
    let g = newTestGame(2);
    let shuri: string, a: string;
    [g, shuri] = put(g, "p1", real("Shuri, the Black Panther"));
    // Une créature-artefact : elle compte parmi les artefacts.
    [g, a] = put(g, "p1", bear("Ours de fer", { typeLine: "Artifact Creature — Bear" }));
    for (let i = 0; i < 2; i++) [g] = put(g, "p1", rock(`Caillou ${i}`));
    let before = hand(g, "p1");
    let h = resolveAll(declare(g, [shuri]));
    expect(hand(h, "p1")).toBe(before + 1);
    expect(creatureStats(h, h.cards[a]!)).toMatchObject({ power: 2, toughness: 2 });
    for (let i = 2; i < 5; i++) [g] = put(g, "p1", rock(`Caillou ${i}`));
    before = hand(g, "p1");
    h = resolveAll(declare(g, [shuri]));
    expect(hand(h, "p1")).toBe(before + 1);
    expect(creatureStats(h, h.cards[a]!)).toMatchObject({ power: 4, toughness: 4 });
    expect(creatureStats(h, h.cards[shuri]!)).toMatchObject({ power: 4, toughness: 5 });
  });

  it("Shuri sans trois artefacts : rien", () => {
    let g = newTestGame(2);
    let shuri: string;
    [g, shuri] = put(g, "p1", real("Shuri, the Black Panther"));
    [g] = put(g, "p1", rock("Caillou"));
    const before = hand(g, "p1");
    g = resolveAll(declare(g, [shuri]));
    expect(hand(g, "p1")).toBe(before);
  });

  it("Coveted Jewel : attaquant non bloqué, l'attaquant pioche trois cartes et prend le Joyau, dégagé", () => {
    let g = newTestGame(2);
    let jewel: string, a: string;
    [g, jewel] = put(g, "p2", real("Coveted Jewel"));
    g = resolveAll(g);
    g.cards[jewel]!.tapped = true;
    [g, a] = put(g, "p1", bear("Ours A"));
    g = resolveAll(declare(g, [a]));
    // p2 n'a aucune créature : sa déclaration (vide) se fait d'office en arrivant à l'étape des bloqueurs.
    const before = hand(g, "p1");
    g = resolveAll(act(g, "p1", { type: "nextStep", to: "declareBlockers" }));
    expect(hand(g, "p1")).toBe(before + 3);
    expect(g.cards[jewel]!.controllerId).toBe("p1");
    expect(g.cards[jewel]!.tapped).toBe(false);
  });

  it("Coveted Jewel : le défenseur déclare qu'il ne bloque pas", () => {
    let g = newTestGame(2);
    let jewel: string, a: string;
    [g, jewel] = put(g, "p2", real("Coveted Jewel"));
    g = resolveAll(g);
    [g] = put(g, "p2", bear("Mur"), 1);
    [g, a] = put(g, "p1", bear("Ours A"));
    g = resolveAll(declare(g, [a]));
    g = act(g, "p1", { type: "nextStep", to: "declareBlockers" });
    const before = hand(g, "p1");
    g = resolveAll(act(g, "p2", { type: "declareBlockers", blocks: [] }));
    expect(hand(g, "p1")).toBe(before + 3);
    expect(g.cards[jewel]!.controllerId).toBe("p1");
  });

  it("Coveted Jewel : rien si l'attaquant est bloqué", () => {
    let g = newTestGame(2);
    let jewel: string, a: string, wall: string;
    [g, jewel] = put(g, "p2", real("Coveted Jewel"));
    g = resolveAll(g);
    [g, wall] = put(g, "p2", bear("Mur"), 1);
    [g, a] = put(g, "p1", bear("Ours A"));
    g = resolveAll(declare(g, [a]));
    g = act(g, "p1", { type: "nextStep", to: "declareBlockers" });
    const before = hand(g, "p1");
    g = resolveAll(act(g, "p2", { type: "declareBlockers", blocks: [{ cardId: wall, attackerId: a }] }));
    expect(hand(g, "p1")).toBe(before);
    expect(g.cards[jewel]!.controllerId).toBe("p2");
  });

  it("Sword of the Animist : la créature équipée attaque, on peut chercher un terrain de base engagé", () => {
    let g = newTestGame(2);
    let sword: string, a: string;
    [g, sword] = put(g, "p1", real("Sword of the Animist"));
    [g, a] = put(g, "p1", bear("Ours A"));
    g.cards[sword]!.attachedTo = a;
    const forest = g.players.p1!.zones.library[0]!;
    g.cardData[g.cards[forest]!.cardId] = fakeCard("Forest", { id: g.cards[forest]!.cardId, typeLine: "Basic Land — Forest", oracleText: "({T}: Add {G}.)" });
    g = declare(g, [a]);
    const trigger = abilitiesOf(g, sword)[0]!;
    expect(trigger).toBeDefined();
    g = resolveAll(g);
    if (g.cards[trigger.instanceId]?.ability?.awaitingDecision) g = act(g, "p1", { type: "decideOptional", cardId: trigger.instanceId, accept: true });
    g = resolveAll(g);
    const choice = g.cards[trigger.instanceId]!;
    expect(choice.cardChoice?.options).toContain(forest);
    g = resolveAll(act(g, "p1", { type: "chooseCards", cardId: trigger.instanceId, cardIds: [forest] }));
    expect(g.cards[forest]!.zone).toBe("battlefield");
    expect(g.cards[forest]!.tapped).toBe(true);
  });

  it("Sword of the Animist : rien quand une autre créature attaque", () => {
    let g = newTestGame(2);
    let sword: string, a: string, b: string;
    [g, sword] = put(g, "p1", real("Sword of the Animist"));
    [g, a] = put(g, "p1", bear("Ours A"));
    [g, b] = put(g, "p1", bear("Ours B"));
    g.cards[sword]!.attachedTo = a;
    g = declare(g, [b]);
    expect(abilitiesOf(g, sword)).toHaveLength(0);
  });
});
