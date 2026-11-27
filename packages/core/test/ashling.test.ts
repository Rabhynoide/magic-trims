import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { chooseBotAction } from "../src/bot.js";
import { creatureStats, hasKeyword } from "../src/combat.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame, endTurn } from "./helpers.js";
import deck from "./ashling-oracle.json" with { type: "json" };

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

type OracleCard = { name: string; typeLine: string; oracleText?: string; manaCost?: string; power?: string; toughness?: string; loyalty?: string };

/** Une carte du deck Ashling, avec son texte Oracle exact. */
function real(name: string, extra: Partial<CardData> = {}): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, {
    typeLine: c.typeLine,
    oracleText: c.oracleText ?? "",
    manaCost: c.manaCost ?? "",
    ...(c.power ? { power: c.power, toughness: c.toughness } : {}),
    ...(c.loyalty ? { loyalty: c.loyalty } : {}),
    ...extra,
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

/** Donne à une carte de la main les données voulues (elle reste en main). */
function inHand(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  return [g, id];
}

function resolveAll(g: GameState, max = 100): GameState {
  for (let i = 0; i < max && g.priority && g.stack.length > 0; i++) {
    if (g.stack.some((id) => g.cards[id]!.ability?.awaitingDecision || g.cards[id]!.ability?.needsTargets || g.cards[id]!.cardChoice)) break;
    g = act(g, g.priority.playerId, { type: "passPriority" });
  }
  return g;
}

function mana(g: GameState, playerId: string, pool: string): GameState {
  for (const m of pool.match(/[WUBRGC]/g) ?? []) g = act(g, playerId, { type: "adjustMana", mana: m as "B", delta: 1 });
  return g;
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const bear = (name = "Bear") => fakeCard(name, { typeLine: "Creature — Bear", power: "2", toughness: "2", manaCost: "{1}{G}" });


describe("Deck Ashling : évocation", () => {
  it("Mulldrifter évoquée pioche deux cartes puis est sacrifiée", () => {
    let g = toMain(newTestGame(2));
    let drifter: string;
    [g, drifter] = inHand(g, "p1", real("Mulldrifter"));
    g = mana(g, "p1", "UCC");
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "castSpell", cardId: drifter, evoke: true });
    g = resolveAll(g);
    expect(g.players.p1!.zones.graveyard).toContain(drifter);
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1 + 2);
  });

  it("Endurance s'évoque en exilant une carte verte de sa main", () => {
    let g = toMain(newTestGame(2));
    let endurance: string, green: string, red: string;
    [g, endurance] = inHand(g, "p1", real("Endurance"));
    [g, green] = inHand(g, "p1", fakeCard("Ours vert", { typeLine: "Creature — Bear", colors: ["G"], manaCost: "{1}{G}" }), 1);
    [g, red] = inHand(g, "p1", fakeCard("Gobelin", { typeLine: "Creature — Goblin", colors: ["R"], manaCost: "{R}" }), 2);
    expect(refuse(g, "p1", { type: "castSpell", cardId: endurance, evoke: true, evokeExile: red })).toMatch(/verte/);
    g = act(g, "p1", { type: "castSpell", cardId: endurance, evoke: true, evokeExile: green });
    expect(g.players.p1!.zones.exile).toContain(green);
    g = resolveAll(g);
    expect(g.players.p1!.zones.graveyard).toContain(endurance);
  });

  it("Ashling donne l'évocation {4} et copie l'Élémental sacrifié, qui part à la fin du tour sans paiement", () => {
    let g = toMain(newTestGame(2));
    let ashling: string, drifter: string;
    [g, ashling] = put(g, "p1", real("Ashling, the Limitless"));
    [g, drifter] = inHand(g, "p1", real("Mulldrifter"), 1);
    g = mana(g, "p1", "CCCC");
    g = act(g, "p1", { type: "castSpell", cardId: drifter, evoke: "granted" });
    g = resolveAll(g);
    expect(g.players.p1!.zones.graveyard).toContain(drifter);
    const token = g.players.p1!.zones.battlefield.find((id) => g.cards[id]!.isToken);
    expect(token && g.cardData[g.cards[token]!.cardId]!.name).toBe("Mulldrifter");
    expect(hasKeyword(g, g.cards[token!]!, "Haste")).toBe(true);
    g = act(g, "p1", { type: "nextStep", to: "end" });
    g = resolveAll(g);
    const upkeep = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.awaitingDecision);
    expect(upkeep).toBeDefined();
    g = act(g, "p1", { type: "decideOptional", cardId: upkeep!.instanceId, accept: false });
    g = resolveAll(g);
    expect(g.players.p1!.zones.battlefield).not.toContain(token);
    // Le jeton sacrifié n'est pas recopié (« nontoken »).
    expect(g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken)).toHaveLength(0);
    void ashling;
    for (const name of ["Ashling, the Limitless", "Mulldrifter", "Shriekmaw", "Foundation Breaker", "Ingot Chewer"]) {
      expect(cardSupport(real(name)).level, name).not.toBe("manual");
    }
    expect(cardSupport(real("Ashling, the Limitless")).level).toBe("full");
  });
});

/** Donne à la n-ième carte de la bibliothèque les données voulues. */
function inLibrary(g: GameState, playerId: string, card: CardData, n: number): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.library[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  return [g, id];
}
const basic = (type: string) => fakeCard(type, { typeLine: `Basic Land — ${type}`, manaCost: "" });

describe("Deck Ashling : recherches de terrains", () => {
  it("Misty Rainforest va chercher une Forêt ou une Île", () => {
    let g = toMain(newTestGame(2));
    let fetch: string, forest: string, plains: string;
    [g, fetch] = put(g, "p1", real("Misty Rainforest"));
    [g, forest] = inLibrary(g, "p1", basic("Forest"), 5);
    [g, plains] = inLibrary(g, "p1", basic("Plains"), 6);
    g = act(g, "p1", { type: "activateAbility", cardId: fetch, index: 0 });
    expect(g.players.p1!.life).toBe(39);
    g = resolveAll(g);
    const ability = g.stack.at(-1)!;
    expect(g.cards[ability]!.cardChoice!.options).toContain(forest);
    expect(g.cards[ability]!.cardChoice!.options).not.toContain(plains);
    g = act(g, "p1", { type: "chooseCards", cardId: ability, cardIds: [forest] });
    g = resolveAll(g);
    expect(g.players.p1!.zones.battlefield).toContain(forest);
    expect(g.cards[forest]!.tapped).toBe(false);
  });

  it("Farseek arrive engagé ; Cultivate : un terrain engagé et un en main", () => {
    let g = toMain(newTestGame(2));
    let farseek: string, cultivate: string, island: string, forest: string, swamp: string;
    [g, farseek] = inHand(g, "p1", real("Farseek"));
    [g, cultivate] = inHand(g, "p1", real("Cultivate"), 1);
    [g, island] = inLibrary(g, "p1", basic("Island"), 3);
    [g, forest] = inLibrary(g, "p1", basic("Forest"), 4);
    [g, swamp] = inLibrary(g, "p1", basic("Swamp"), 5);
    g = mana(g, "p1", "GC");
    g = act(g, "p1", { type: "castSpell", cardId: farseek });
    g = resolveAll(g);
    let spell = g.stack.at(-1)!;
    expect(g.cards[spell]!.cardChoice!.options).not.toContain(forest);
    g = act(g, "p1", { type: "chooseCards", cardId: spell, cardIds: [island] });
    g = resolveAll(g);
    expect(g.cards[island]!.zone).toBe("battlefield");
    expect(g.cards[island]!.tapped).toBe(true);
    g = mana(g, "p1", "GCC");
    g = act(g, "p1", { type: "castSpell", cardId: cultivate });
    g = resolveAll(g);
    spell = g.stack.at(-1)!;
    // La bibliothèque a été mélangée par Farseek (nouvelles identités) : on prend les deux terrains proposés.
    const [first, second] = g.cards[spell]!.cardChoice!.options as [string, string];
    expect(g.cards[spell]!.cardChoice!.max).toBe(2);
    g = act(g, "p1", { type: "chooseCards", cardId: spell, cardIds: [first, second] });
    g = resolveAll(g);
    expect(g.cards[first]!.zone).toBe("battlefield");
    expect(g.cards[first]!.tapped).toBe(true);
    expect(g.cards[second]!.zone).toBe("hand");
    void forest;
    void swamp;
  });

  it("Land Tax ne se déclenche que si un adversaire a plus de terrains", () => {
    let g = toMain(newTestGame(2));
    let a: string, b: string, c: string;
    [g] = put(g, "p1", real("Land Tax"));
    [g] = put(g, "p2", basic("Plains"));
    [g, a] = inLibrary(g, "p1", basic("Plains"), 2);
    [g, b] = inLibrary(g, "p1", basic("Island"), 3);
    [g, c] = inLibrary(g, "p1", basic("Forest"), 4);
    g = endTurn(g, "p1");
    g = endTurn(g, "p2");
    g = resolveAll(g);
    const tax = g.stack.at(-1)!;
    expect(g.cards[tax]!.ability?.awaitingDecision).toBe(true);
    g = act(g, "p1", { type: "decideOptional", cardId: tax, accept: true });
    g = act(g, "p1", { type: "chooseCards", cardId: tax, cardIds: [a, b, c] });
    g = resolveAll(g);
    for (const id of [a, b, c]) expect(g.cards[id]!.zone).toBe("hand");
    for (const name of ["Misty Rainforest", "Windswept Heath", "Flooded Strand", "Scalding Tarn", "Bloodstained Mire", "Farseek", "Rampant Growth", "Cultivate", "Kodama's Reach", "Land Tax"]) {
      expect(cardSupport(real(name)).level, name).toBe("full");
    }
  });
});

describe("Deck Ashling : bilan", () => {
  it("compte les cartes entièrement gérées", () => {
    const levels = (deck as OracleCard[]).map((c) => cardSupport(fakeCard(c.name, { typeLine: c.typeLine, oracleText: c.oracleText ?? "", manaCost: c.manaCost ?? "" })).level);
    expect(levels.filter((l) => l === "full").length).toBeGreaterThanOrEqual(61);
  });
});

describe("Deck Ashling : type choisi et mana réservé", () => {
  const elemental = (name: string, cost = "{1}{G}") => fakeCard(name, { typeLine: "Creature — Elemental", power: "2", toughness: "2", manaCost: cost, colors: ["G"] });

  it("Primal Beyond : le mana de couleur ne sert qu'aux Élémentaux", () => {
    let g = toMain(newTestGame(2));
    let beyond: string, ours: string, elem: string;
    [g, beyond] = put(g, "p1", real("Primal Beyond"));
    g.cards[beyond]!.tapped = false;
    [g, ours] = inHand(g, "p1", bear("Ours"), 1);
    [g, elem] = inHand(g, "p1", elemental("Élémental", "{G}"), 2);
    g = act(g, "p1", { type: "tapForMana", cardId: beyond, choice: 5 });
    expect(g.players.p1!.restrictedMana).toEqual([{ mana: "G", subtype: "Elemental", abilities: true }]);
    expect(refuse(g, "p1", { type: "castSpell", cardId: ours })).toMatch(/mana/);
    g = act(g, "p1", { type: "castSpell", cardId: elem });
    expect(g.players.p1!.restrictedMana).toEqual([]);
  });

  it("Secluded Courtyard : le type choisi en jouant le terrain", () => {
    let g = toMain(newTestGame(2));
    let yard: string;
    [g, yard] = inHand(g, "p1", real("Secluded Courtyard"));
    g = act(g, "p1", { type: "playLand", cardId: yard, chosenType: "elf" });
    expect(g.cards[yard]!.chosenType).toBe("Elf");
    g = act(g, "p1", { type: "tapForMana", cardId: yard, choice: 1 });
    expect(g.players.p1!.restrictedMana?.[0]?.subtype).toBe("Elf");
  });

  it("Herald's Horn, Urza's Incubator, Morophon : réductions selon le type choisi", () => {
    let g = toMain(newTestGame(2));
    let elem: string, theirs: string;
    [g] = put(g, "p1", real("Herald's Horn"));
    expect(g.cards[g.players.p1!.zones.battlefield.at(-1)!]!.chosenType).toBeDefined();
    let horn = g.players.p1!.zones.battlefield.at(-1)!;
    g.cards[horn]!.chosenType = "Elemental";
    [g] = put(g, "p2", real("Urza's Incubator"));
    const incubator = g.players.p2!.zones.battlefield.at(-1)!;
    g.cards[incubator]!.chosenType = "Elemental";
    [g, elem] = inHand(g, "p1", elemental("Élémental", "{4}{G}"), 2);
    // {4}{G} − 1 (Horn) − 2 (Incubator, pour tout le monde) = {1}{G}.
    g = mana(g, "p1", "GC");
    g = act(g, "p1", { type: "castSpell", cardId: elem });
    g = resolveAll(g);
    expect(g.cards[elem]!.zone).toBe("battlefield");
    // Morophon : {W}{U}{B}{R}{G} de moins pour le type choisi.
    [g] = put(g, "p1", real("Morophon, the Boundless"), 0);
    const morophon = g.players.p1!.zones.battlefield.at(-1)!;
    g.cards[morophon]!.chosenType = "Elemental";
    [g, theirs] = inHand(g, "p1", fakeCard("Grand Élémental", { typeLine: "Creature — Elemental", power: "5", toughness: "5", manaCost: "{1}{W}{U}{B}{R}{G}" }), 0);
    g = act(g, "p1", { type: "castSpell", cardId: theirs });
    expect(g.cards[theirs]!.zone).toBe("stack");
    // Les autres créatures du type choisi : +1/+1 (Morophon).
    expect(creatureStats(g, g.cards[elem]!)).toEqual({ power: 3, toughness: 3 });
    void horn;
    horn = "";
  });

  it("Incandescent Soulstoke et Goblin Anarchomancer", () => {
    let g = toMain(newTestGame(2));
    let elem: string, ours: string, spell: string;
    [g] = put(g, "p1", real("Incandescent Soulstoke"));
    [g, elem] = put(g, "p1", elemental("Élémental"), 0);
    [g, ours] = put(g, "p1", bear("Ours"), 0);
    expect(creatureStats(g, g.cards[elem]!)).toEqual({ power: 3, toughness: 3 });
    expect(creatureStats(g, g.cards[ours]!)).toEqual({ power: 2, toughness: 2 });
    [g] = put(g, "p1", real("Goblin Anarchomancer"), 0);
    [g, spell] = inHand(g, "p1", fakeCard("Sort vert", { typeLine: "Sorcery", manaCost: "{1}{G}", colors: ["G"], oracleText: "You gain 1 life." }), 0);
    g = mana(g, "p1", "G");
    g = act(g, "p1", { type: "castSpell", cardId: spell });
    expect(g.cards[spell]!.zone).toBe("stack");
    for (const name of ["Primal Beyond", "Secluded Courtyard", "Unclaimed Territory", "Herald's Horn", "Urza's Incubator", "Cloud Key", "Morophon, the Boundless", "Smokebraider", "Flamebraider", "Incandescent Soulstoke", "Goblin Anarchomancer"]) {
      expect(cardSupport(real(name)).level, name).not.toBe("manual");
    }
  });
});

describe("Deck Ashling : terrains engagés sous condition", () => {
  const elemental = fakeCard("Élémental", { typeLine: "Creature — Elemental", power: "2", toughness: "2", manaCost: "{1}{R}" });

  it("Overgrown Tomb : payer 2 PV pour l'avoir dégagé", () => {
    let g = toMain(newTestGame(2));
    let tomb: string;
    [g, tomb] = inHand(g, "p1", real("Overgrown Tomb"));
    const life = g.players.p1!.life;
    const paid = act(g, "p1", { type: "playLand", cardId: tomb, untap: true });
    expect(paid.cards[tomb]!.tapped).toBe(false);
    expect(paid.players.p1!.life).toBe(life - 2);
    const tapped = act(g, "p1", { type: "playLand", cardId: tomb });
    expect(tapped.cards[tomb]!.tapped).toBe(true);
    expect(tapped.players.p1!.life).toBe(life);
  });

  it("Flamekin Village et Primal Beyond : révéler un Élémental", () => {
    let g = toMain(newTestGame(2));
    let village: string;
    [g, village] = inHand(g, "p1", real("Flamekin Village"));
    expect(() => act(g, "p1", { type: "playLand", cardId: village, untap: true })).toThrow(/Elemental/);
    expect(act(g, "p1", { type: "playLand", cardId: village }).cards[village]!.tapped).toBe(true);
    [g] = inHand(g, "p1", elemental, 1);
    const shown = act(g, "p1", { type: "playLand", cardId: village, untap: true });
    expect(shown.cards[village]!.tapped).toBe(false);
    expect(JSON.stringify(shown.log.slice(-3))).toMatch(/révèle Élémental/);
    // {R}, {T} : la créature ciblée gagne la célérité.
    let fresh: string;
    [g, fresh] = put(shown, "p1", elemental, 0);
    g.cards[fresh]!.summoningSick = true;
    g = mana(g, "p1", "R");
    g = act(g, "p1", { type: "activateAbility", cardId: village, index: 0, targets: [{ kind: "card", id: fresh }] });
    g = resolveAll(g);
    expect(hasKeyword(g, g.cards[fresh]!, "Haste")).toBe(true);
  });

  it("Sodden Verdure : dégagé avec deux terrains de base", () => {
    let g = toMain(newTestGame(2));
    let verdure: string;
    [g] = put(g, "p1", basic("Forest"));
    [g, verdure] = inHand(g, "p1", real("Sodden Verdure"));
    expect(act(g, "p1", { type: "playLand", cardId: verdure }).cards[verdure]!.tapped).toBe(true);
    [g] = put(g, "p1", basic("Island"), 1);
    expect(act(g, "p1", { type: "playLand", cardId: verdure }).cards[verdure]!.tapped).toBe(false);
    for (const name of ["Flamekin Village", "Primal Beyond", "Overgrown Tomb", "Sodden Verdure"]) {
      expect(cardSupport(real(name)).level, name).toBe("full");
    }
  });
});

describe("Deck Ashling : mana en plus", () => {
  it("Utopia Sprawl : une Forêt, et un mana de plus de la couleur choisie", () => {
    let g = toMain(newTestGame(2));
    let forest: string, island: string, sprawl: string;
    [g, forest] = put(g, "p1", basic("Forest"));
    [g, island] = put(g, "p1", basic("Island"));
    [g, sprawl] = inHand(g, "p1", real("Utopia Sprawl"));
    g = mana(g, "p1", "G");
    expect(() => act(g, "p1", { type: "castSpell", cardId: sprawl, targets: [{ kind: "card", id: island }], chosenType: "U" })).toThrow();
    g = act(g, "p1", { type: "castSpell", cardId: sprawl, targets: [{ kind: "card", id: forest }], chosenType: "blue" });
    g = resolveAll(g);
    expect(g.cards[sprawl]!.attachedTo).toBe(forest);
    expect(g.cards[sprawl]!.chosenType).toBe("U");
    g = act(g, "p1", { type: "tapForMana", cardId: forest });
    expect(g.players.p1!.manaPool.G).toBe(1);
    expect(g.players.p1!.manaPool.U).toBe(1);
  });

  it("Fertile Ground : un mana de plus au choix", () => {
    let g = toMain(newTestGame(2));
    let forest: string, ground: string;
    [g, forest] = put(g, "p1", basic("Forest"));
    [g, ground] = put(g, "p1", real("Fertile Ground"));
    g.cards[ground]!.attachedTo = forest;
    expect(() => act(g, "p1", { type: "tapForMana", cardId: forest })).toThrow(/Choisis/);
    g = act(g, "p1", { type: "tapForMana", cardId: forest, choice: 3 });
    expect(g.players.p1!.manaPool.G).toBe(1);
    expect(g.players.p1!.manaPool.R).toBe(1);
  });

  it("Faeburrow Elder et Bloom Tender : un mana par couleur parmi mes permanents", () => {
    let g = toMain(newTestGame(2));
    let elder: string, tender: string;
    [g, elder] = put(g, "p1", real("Faeburrow Elder", { colors: ["G", "W"] }));
    [g, tender] = put(g, "p1", real("Bloom Tender", { colors: ["G"] }));
    [g] = put(g, "p1", fakeCard("Ours rouge", { typeLine: "Creature — Bear", power: "2", toughness: "2", manaCost: "{R}", colors: ["R"] }));
    expect(creatureStats(g, g.cards[elder]!)).toEqual({ power: 3, toughness: 3 });
    g = act(g, "p1", { type: "tapForMana", cardId: tender });
    expect(g.players.p1!.manaPool).toMatchObject({ W: 1, G: 1, R: 1, U: 0, B: 0 });
  });

  it("Selvala : X mana, X étant la plus grande force", () => {
    let g = toMain(newTestGame(2));
    let selvala: string;
    [g, selvala] = put(g, "p1", real("Selvala, Heart of the Wilds", { colors: ["G"] }));
    [g] = put(g, "p1", fakeCard("Gros", { typeLine: "Creature — Beast", power: "5", toughness: "5", manaCost: "{4}{G}" }));
    g = mana(g, "p1", "G");
    g = act(g, "p1", { type: "activateAbility", cardId: selvala, index: 0, color: "U" });
    g = resolveAll(g);
    expect(g.players.p1!.manaPool.U).toBe(5);
    for (const name of ["Utopia Sprawl", "Fertile Ground", "Faeburrow Elder", "Bloom Tender"]) {
      expect(cardSupport(real(name)).level, name).toBe("full");
    }
  });
});
