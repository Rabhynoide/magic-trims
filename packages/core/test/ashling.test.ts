import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { chooseBotAction } from "../src/bot.js";
import { canBlock, creatureStats, hasKeyword } from "../src/combat.js";
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
    if (g.stack.some((id) => g.cards[id]!.ability?.awaitingDecision || g.cards[id]!.ability?.needsTargets || g.cards[id]!.cardChoice || (g.cards[id]!.modes && !g.cards[id]!.modes!.chosen))) break;
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
    const etb = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.needsTargets);
    if (etb) g = act(g, "p1", { type: "chooseTargets", cardId: etb.instanceId, targets: [{ kind: "player", id: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p1!.zones.graveyard).toContain(endurance);
  });

  it("Ashling copie Morophon (changelin) évoqué : le jeton arrive avec la célérité", () => {
    let g = toMain(newTestGame(2));
    let morophon: string;
    [g] = put(g, "p1", real("Ashling, the Limitless"));
    [g, morophon] = inHand(g, "p1", real("Morophon, the Boundless"), 1);
    g = mana(g, "p1", "CCCC");
    g = act(g, "p1", { type: "castSpell", cardId: morophon, evoke: "granted" });
    g = resolveAll(g);
    expect(g.players.p1!.zones.graveyard).toContain(morophon);
    const token = g.players.p1!.zones.battlefield.find((id) => g.cards[id]!.isToken);
    expect(token && g.cardData[g.cards[token]!.cardId]!.name).toBe("Morophon, the Boundless");
    expect(hasKeyword(g, g.cards[token!]!, "Haste")).toBe(true);
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
    expect(levels.filter((l) => l === "full").length).toBe(97);
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

describe("Deck Ashling : atterrissage", () => {
  const waiting = (g: GameState) => g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.needsTargets || c.ability?.awaitingDecision)!;
  const plants = (g: GameState) => g.players.p1!.zones.battlefield.filter((id) => g.cardData[g.cards[id]!.cardId]?.typeLine.includes("Plant"));

  it("Avenger of Zendikar : une Plante par terrain, puis des marqueurs à chaque terrain", () => {
    let g = toMain(newTestGame(2));
    let avenger: string, forest: string;
    [g] = put(g, "p1", basic("Forest"));
    [g] = put(g, "p1", basic("Island"));
    [g, avenger] = inHand(g, "p1", real("Avenger of Zendikar", { colors: ["G"] }));
    [g, forest] = inHand(g, "p1", basic("Forest"), 1);
    g = mana(g, "p1", "GGGGGGG");
    g = act(g, "p1", { type: "castSpell", cardId: avenger });
    g = resolveAll(g);
    expect(plants(g)).toHaveLength(2);
    g = act(g, "p1", { type: "playLand", cardId: forest });
    g = resolveAll(g);
    const trigger = waiting(g);
    g = act(g, "p1", { type: "decideOptional", cardId: trigger.instanceId, accept: true });
    g = resolveAll(g);
    for (const id of plants(g)) expect(creatureStats(g, g.cards[id]!)).toEqual({ power: 1, toughness: 2 });
  });

  it("Omnath, Locus of Rage : un Élémental 5/5 par terrain, 3 blessures quand un Élémental meurt", () => {
    let g = toMain(newTestGame(2));
    let omnath: string, forest: string, elem: string;
    [g, omnath] = put(g, "p1", real("Omnath, Locus of Rage"));
    [g, elem] = put(g, "p1", fakeCard("Petit Élémental", { typeLine: "Creature — Elemental", power: "1", toughness: "1", manaCost: "{R}" }));
    [g, forest] = inHand(g, "p1", basic("Forest"));
    g = act(g, "p1", { type: "playLand", cardId: forest });
    g = resolveAll(g);
    const tokens = g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken);
    expect(tokens).toHaveLength(1);
    expect(creatureStats(g, g.cards[tokens[0]!]!)).toEqual({ power: 5, toughness: 5 });
    const life = g.players.p2!.life;
    g = act(g, "p1", { type: "moveCard", cardId: elem, to: "graveyard", force: true });
    g = act(g, "p1", { type: "chooseTargets", cardId: waiting(g).instanceId, targets: [{ kind: "player", id: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(life - 3);
    expect(omnath).toBeDefined();
  });

  it("Omnath, Locus of the Roil : blessures selon les Élémentaux, marqueur et pioche avec huit terrains", () => {
    let g = toMain(newTestGame(2));
    let omnath: string, forest: string, elem: string;
    [g, elem] = put(g, "p1", fakeCard("Petit Élémental", { typeLine: "Creature — Elemental", power: "1", toughness: "1", manaCost: "{R}" }));
    for (let i = 0; i < 8; i++) g = act(g, "p1", { type: "moveCard", cardId: g.players.p1!.zones.library[0]!, to: "hand", force: true });
    for (let i = 0; i < 7; i++) [g] = put(g, "p1", basic("Island"), 0);
    [g, forest] = inHand(g, "p1", basic("Forest"), 0);
    [g, omnath] = inHand(g, "p1", real("Omnath, Locus of the Roil", { colors: ["G", "U", "R"] }), 1);
    g = mana(g, "p1", "GURU");
    g = act(g, "p1", { type: "castSpell", cardId: omnath });
    g = resolveAll(g);
    const life = g.players.p2!.life;
    g = act(g, "p1", { type: "chooseTargets", cardId: waiting(g).instanceId, targets: [{ kind: "player", id: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(life - 2);
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "playLand", cardId: forest });
    // Un Plant n'est pas un Élémental : la cible doit être un Élémental que je contrôle.
    g = act(g, "p1", { type: "chooseTargets", cardId: waiting(g).instanceId, targets: [{ kind: "card", id: elem }] });
    g = resolveAll(g);
    expect(g.cards[elem]!.counters["+1/+1"]).toBe(1);
    expect(g.players.p1!.zones.hand.length).toBe(hand); // −1 terrain joué, +1 carte piochée
    for (const name of ["Avenger of Zendikar", "Omnath, Locus of Rage", "Omnath, Locus of the Roil"]) {
      expect(cardSupport(real(name)).level, name).toBe("full");
    }
  });
});

describe("Deck Ashling : doubleurs de déclencheurs", () => {
  const tokens = (g: GameState) => g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken).length;
  const landfall = (g: GameState, extra: string[]) => {
    let forest: string;
    [g] = put(g, "p1", real("Omnath, Locus of Rage"));
    for (const name of extra) [g] = put(g, "p1", real(name));
    [g, forest] = inHand(g, "p1", basic("Forest"));
    g = act(g, "p1", { type: "playLand", cardId: forest });
    return resolveAll(g);
  };

  it("Yarok : un terrain qui arrive déclenche Omnath deux fois", () => {
    expect(tokens(landfall(toMain(newTestGame(2)), ["Yarok, the Desecrated"]))).toBe(2);
  });

  it("Twinflame Travelers : les capacités des autres Élémentaux se déclenchent deux fois", () => {
    expect(tokens(landfall(toMain(newTestGame(2)), ["Twinflame Travelers"]))).toBe(2);
    expect(tokens(landfall(toMain(newTestGame(2)), ["Twinflame Travelers", "Yarok, the Desecrated"]))).toBe(3);
    // Sans doubleur : un seul jeton.
    expect(tokens(landfall(toMain(newTestGame(2)), []))).toBe(1);
    for (const name of ["Yarok, the Desecrated", "Twinflame Travelers"]) expect(cardSupport(real(name)).level, name).toBe("full");
  });
});

describe("Deck Ashling : créatures qui arrivent", () => {
  const big = (name: string, power: number, subtype = "Beast") => fakeCard(name, { typeLine: `Creature — ${subtype}`, power: String(power), toughness: String(power), manaCost: "{G}", colors: ["G"] });
  const cast = (g: GameState, card: CardData, n = 0): [GameState, string] => {
    let id: string;
    [g, id] = inHand(g, "p1", card, n);
    g = mana(g, "p1", "G");
    g = act(g, "p1", { type: "castSpell", cardId: id });
    return [resolveAll(g), id];
  };

  it("Elemental Bond : pioche pour une créature de force 3 ou plus", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Elemental Bond"));
    const hand = g.players.p1!.zones.hand.length;
    [g] = cast(g, big("Petit", 2));
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1);
    [g] = cast(g, big("Gros", 3));
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1);
  });

  it("Risen Reef : un terrain du dessus sur le champ de bataille, sinon en main", () => {
    let g = toMain(newTestGame(2));
    const topId = g.players.p1!.zones.library[0]!;
    g.cardData[g.cards[topId]!.cardId] = { ...basic("Forest"), id: g.cards[topId]!.cardId };
    // Risen Reef se déclenche lui-même en arrivant.
    [g] = put(g, "p1", real("Risen Reef"));
    g = resolveAll(g);
    const trigger = g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice)!;
    expect(trigger.cardChoice!.options).toEqual([topId]);
    g = act(g, "p1", { type: "chooseCards", cardId: trigger.instanceId, cardIds: [topId] });
    g = resolveAll(g);
    expect(g.cards[topId]!.zone).toBe("battlefield");
    expect(g.cards[topId]!.tapped).toBe(true);
    // Un autre Élémental : la carte du dessus n'est pas un terrain, elle va en main.
    const hand = g.players.p1!.zones.hand.length;
    [g] = cast(g, big("Élémental", 1, "Elemental"));
    expect(g.stack).toHaveLength(0);
    expect(g.players.p1!.zones.hand.length).toBe(hand);
    // Un non-Élémental ne déclenche pas Risen Reef.
    [g] = cast(g, big("Ours", 1));
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1);
  });

  it("Cream of the Crop : une des X cartes reste dessus, le reste dessous", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Cream of the Crop"));
    const library = g.players.p1!.zones.library.length;
    let id: string;
    [g, id] = inHand(g, "p1", big("Gros", 3));
    g = mana(g, "p1", "G");
    g = act(g, "p1", { type: "castSpell", cardId: id });
    g = resolveAll(g);
    const trigger = g.stack.map((s) => g.cards[s]!).find((c) => c.ability?.awaitingDecision)!;
    g = act(g, "p1", { type: "decideOptional", cardId: trigger.instanceId, accept: true });
    const choice = g.cards[trigger.instanceId]!.cardChoice!;
    expect(choice.options).toHaveLength(3);
    const keep = choice.options[2]!;
    const keepName = g.cardData[g.cards[keep]!.cardId]!.name;
    g = act(g, "p1", { type: "chooseCards", cardId: trigger.instanceId, cardIds: [keep] });
    g = resolveAll(g);
    expect(g.players.p1!.zones.library).toHaveLength(library);
    expect(g.cardData[g.cards[g.players.p1!.zones.library[0]!]!.cardId]!.name).toBe(keepName);
  });

  it("Selvala : le contrôleur pioche si la créature a la plus grande force", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Selvala, Heart of the Wilds"));
    const hand = g.players.p1!.zones.hand.length;
    [g] = cast(g, big("Gros", 5));
    expect(g.players.p1!.zones.hand.length).toBe(hand);
    [g] = cast(g, big("Petit", 1));
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1);
    for (const name of ["Elemental Bond", "Risen Reef", "Cream of the Crop", "Selvala, Heart of the Wilds"]) expect(cardSupport(real(name)).level, name).toBe("full");
  });
});

describe("Deck Ashling : mots-clés", () => {
  const creature = (name: string, colors: string[], typeLine = "Creature — Beast", extra: Partial<CardData> = {}) =>
    fakeCard(name, { typeLine, power: "2", toughness: "2", manaCost: "{1}", colors, ...extra });

  it("Shriekmaw : peur, et ne détruit pas une créature noire ni un artefact", () => {
    let g = toMain(newTestGame(2));
    let maw: string, green: string, black: string, golem: string, victim: string;
    [g, maw] = put(g, "p1", real("Shriekmaw", { colors: ["B"] }));
    g = resolveAll(g);
    [g, green] = put(g, "p2", creature("Vert", ["G"]));
    [g, black] = put(g, "p2", creature("Noir", ["B"]), 1);
    [g, golem] = put(g, "p2", creature("Golem", [], "Artifact Creature — Golem"), 2);
    expect(canBlock(g, g.cards[green]!, g.cards[maw]!)).toBe(false);
    expect(canBlock(g, g.cards[black]!, g.cards[maw]!)).toBe(true);
    expect(canBlock(g, g.cards[golem]!, g.cards[maw]!)).toBe(true);
    // En arrivant : seule la créature verte est une cible valable (choisie d'office).
    [g, victim] = inHand(g, "p1", real("Shriekmaw", { colors: ["B"] }));
    g = mana(g, "p1", "BBBBB");
    g = act(g, "p1", { type: "castSpell", cardId: victim });
    g = resolveAll(g);
    expect(g.cards[green]!.zone).toBe("graveyard");
    expect(g.cards[black]!.zone).toBe("battlefield");
    expect(g.cards[golem]!.zone).toBe("battlefield");
  });

  it("Animar : protection contre le blanc et le noir, réduction par marqueur", () => {
    let g = toMain(newTestGame(2));
    let animar: string, white: string, red: string, spell: string, bolt: string;
    [g, animar] = put(g, "p1", real("Animar, Soul of Elements", { colors: ["U", "R", "G"] }));
    [g, white] = put(g, "p2", creature("Blanc", ["W"]));
    [g, red] = put(g, "p2", creature("Rouge", ["R"]), 1);
    expect(canBlock(g, g.cards[white]!, g.cards[animar]!)).toBe(false);
    expect(canBlock(g, g.cards[red]!, g.cards[animar]!)).toBe(true);
    // Un sort noir ne peut pas le cibler.
    [g, bolt] = inHand(g, "p2", fakeCard("Meurtre", { typeLine: "Instant", manaCost: "{B}", colors: ["B"], oracleText: "Destroy target creature." }));
    g = mana(g, "p2", "B");
    expect(() => act(g, "p2", { type: "castSpell", cardId: bolt, targets: [{ kind: "card", id: animar }] })).toThrow();
    // Marqueurs : un sort de créature lancé en met un, et les suivants coûtent moins.
    [g, spell] = inHand(g, "p1", creature("Ours", ["G"], "Creature — Bear", { manaCost: "{1}{G}" }));
    g = mana(g, "p1", "GC");
    g = act(g, "p1", { type: "castSpell", cardId: spell });
    g = resolveAll(g);
    expect(g.cards[animar]!.counters["+1/+1"]).toBe(1);
    [g, spell] = inHand(g, "p1", creature("Ours 2", ["G"], "Creature — Bear", { manaCost: "{1}{G}" }));
    g = mana(g, "p1", "G");
    g = act(g, "p1", { type: "castSpell", cardId: spell });
    expect(g.cards[spell]!.zone).toBe("stack");
  });

  it("Nulldrifter : pioche au lancement, annihilateur 1 en attaquant", () => {
    let g = toMain(newTestGame(2));
    let drifter: string, land: string;
    [g, land] = put(g, "p2", basic("Forest"));
    [g] = put(g, "p2", basic("Island"), 1);
    [g, drifter] = inHand(g, "p1", real("Nulldrifter", { colors: [] }));
    g = mana(g, "p1", "CCCCCCC");
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "castSpell", cardId: drifter });
    g = resolveAll(g);
    expect(g.cards[drifter]!.zone).toBe("battlefield");
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1 + 2);
    delete g.cards[drifter]!.summoningSick;
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: drifter, defender: "p2" }] });
    g = resolveAll(g);
    const trigger = g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice)!;
    expect(trigger.cardChoice!.playerId).toBe("p2");
    g = act(g, "p2", { type: "chooseCards", cardId: trigger.instanceId, cardIds: [land] });
    g = resolveAll(g);
    expect(g.cards[land]!.zone).toBe("graveyard");
    for (const name of ["Shriekmaw", "Nulldrifter", "Animar, Soul of Elements"]) expect(cardSupport(real(name)).level, name).toBe("full");
  });
});

describe("Deck Ashling : rebond, cascade, encore", () => {
  const creature = (name: string, mv: number, extra: Partial<CardData> = {}) =>
    fakeCard(name, { typeLine: "Creature — Beast", power: "2", toughness: "2", manaCost: `{${mv}}`, manaValue: mv, ...extra });

  it("Ephemerate : rebond, relancé gratuitement au tour suivant", () => {
    let g = toMain(newTestGame(2));
    let bear: string, spell: string;
    [g, bear] = put(g, "p1", creature("Ours", 2));
    [g, spell] = inHand(g, "p1", real("Ephemerate", { colors: ["W"] }));
    g = mana(g, "p1", "W");
    g = act(g, "p1", { type: "castSpell", cardId: spell, targets: [{ kind: "card", id: bear }] });
    g = resolveAll(g);
    expect(g.cards[spell]!.zone).toBe("exile");
    expect(g.cards[spell]!.rebound).toBe("p1");
    // Pas avant le prochain entretien.
    expect(() => act(g, "p1", { type: "castSpell", cardId: spell, targets: [{ kind: "card", id: g.players.p1!.zones.battlefield.at(-1)! }] })).toThrow();
    g = endTurn(g, "p1");
    g = endTurn(g, "p2");
    expect(g.turn.activePlayerId).toBe("p1");
    const target = g.players.p1!.zones.battlefield.find((id) => g.cardData[g.cards[id]!.cardId]?.name === "Ours")!;
    g = act(g, "p1", { type: "castSpell", cardId: spell, targets: [{ kind: "card", id: target }] });
    g = resolveAll(g);
    // Relancé depuis l'exil : il va au cimetière cette fois.
    expect(g.cards[spell]!.zone).toBe("graveyard");
  });

  it("Maelstrom Wanderer : deux cascades, gratuites", () => {
    let g = toMain(newTestGame(2));
    let wanderer: string;
    // La bibliothèque : un terrain, puis une créature à 3, une à 9 (trop chère), une à 2.
    const lib = g.players.p1!.zones.library;
    const set = (i: number, data: CardData) => (g.cardData[g.cards[lib[i]!]!.cardId] = { ...data, id: g.cards[lib[i]!]!.cardId });
    set(0, basic("Forest"));
    set(1, creature("Trois", 3));
    set(2, creature("Neuf", 9));
    set(3, creature("Deux", 2));
    [g, wanderer] = inHand(g, "p1", real("Maelstrom Wanderer", { colors: ["U", "R", "G"], manaValue: 8 }));
    g = mana(g, "p1", "UURRGGCC");
    const libSize = g.players.p1!.zones.library.length;
    g = act(g, "p1", { type: "castSpell", cardId: wanderer });
    // Deux déclencheurs de cascade sur la pile.
    expect(g.stack).toHaveLength(3);
    g = act(g, "p1", { type: "passPriority" });
    g = act(g, "p2", { type: "passPriority" });
    const three = g.players.p1!.zones.exile.find((id) => g.cardData[g.cards[id]!.cardId]?.name === "Trois")!;
    expect(g.cards[three]!.castPermission?.reason).toBe("cascade");
    g = act(g, "p1", { type: "castSpell", cardId: three });
    g = resolveAll(g);
    expect(g.cards[three]!.zone).toBe("battlefield");
    // Seconde cascade : « Deux » (le 9 passe dessous) ; on ne la lance pas.
    const two = g.players.p1!.zones.exile.find((id) => g.cardData[g.cards[id]!.cardId]?.name === "Deux");
    expect(two).toBeUndefined();
    expect(g.cards[wanderer]!.zone).toBe("battlefield");
    // Les cartes non lancées sont dessous : la bibliothèque a perdu seulement « Trois ».
    expect(g.players.p1!.zones.library).toHaveLength(libSize - 1);
  });

  it("Lamentation : encore depuis le cimetière", () => {
    let g = newTestGame(3);
    g = toMain(g);
    let lam: string;
    [g, lam] = inHand(g, "p1", real("Lamentation", { colors: ["B"] }));
    g = act(g, "p1", { type: "moveCard", cardId: lam, to: "graveyard", force: true });
    g = mana(g, "p1", "BBCCCCCC");
    g = act(g, "p1", { type: "activateAbility", cardId: lam, index: 0 });
    g = resolveAll(g);
    expect(g.cards[lam]!.zone).toBe("exile");
    const tokens = g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken);
    expect(tokens).toHaveLength(2);
    for (const id of tokens) expect(hasKeyword(g, g.cards[id]!, "Haste")).toBe(true);
    for (const name of ["Ephemerate", "Maelstrom Wanderer", "Lamentation"]) expect(cardSupport(real(name)).level, name).toBe("full");
  });
});

describe("Deck Ashling : myriade et provocation", () => {
  const elemental = (name: string) => fakeCard(name, { typeLine: "Creature — Elemental", power: "3", toughness: "3", manaCost: "{R}", colors: ["R"] });

  it("Mass of Mysteries : un autre Élémental gagne la myriade et se copie contre chaque autre adversaire", () => {
    let g = toMain(newTestGame(3));
    let elem: string;
    [g] = put(g, "p1", real("Mass of Mysteries", { colors: ["W", "U", "B", "R", "G"] }));
    [g, elem] = put(g, "p1", elemental("Élémental"), 0);
    g = act(g, "p1", { type: "nextStep", to: "beginCombat" });
    g = resolveAll(g);
    expect(g.cards[elem]!.grants).toContain("myriad");
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: elem, defender: "p2" }] });
    g = resolveAll(g);
    const tokens = g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken);
    expect(tokens).toHaveLength(1);
    expect(g.combat!.attackers[tokens[0]!]).toBe("p3");
    expect(g.cards[tokens[0]!]!.tapped).toBe(true);
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    expect(g.cards[tokens[0]!]?.zone ?? "exile").not.toBe("battlefield");
  });

  it("Havoc Eater : provoque une créature par adversaire et grandit de leur force", () => {
    let g = toMain(newTestGame(3));
    let eater: string, a: string, b: string;
    [g, a] = put(g, "p2", elemental("A"));
    [g, b] = put(g, "p3", elemental("B"));
    [g, eater] = inHand(g, "p1", real("Havoc Eater", { colors: ["R"] }));
    g = mana(g, "p1", "RRRRRRRR");
    g = act(g, "p1", { type: "castSpell", cardId: eater });
    g = resolveAll(g);
    const trigger = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.needsTargets)!;
    g = act(g, "p1", { type: "chooseTargets", cardId: trigger.instanceId, targets: [{ kind: "card", id: a }, { kind: "card", id: b }] });
    g = resolveAll(g);
    expect(g.cards[a]!.goadedBy).toEqual(["p1"]);
    expect(g.cards[eater]!.counters["+1/+1"]).toBe(6);
    // Au tour de p2, A doit attaquer, et pas p1 (p3 est possible).
    g = endTurn(g, "p1");
    g = act(g, "p2", { type: "nextStep", to: "declareAttackers" });
    expect(() => act(g, "p2", { type: "declareAttackers", attackers: [] })).toThrow(/provoqué/);
    expect(() => act(g, "p2", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p1" }] })).toThrow(/autre joueur/);
    g = act(g, "p2", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p3" }] });
    expect(g.combat!.attackers[a]).toBe("p3");
    for (const name of ["Mass of Mysteries", "Havoc Eater"]) expect(cardSupport(real(name)).level, name).toBe("full");
  });
});

describe("Deck Ashling : gros effets et déclencheurs divers", () => {
  const creature = (name: string, extra: Partial<CardData> = {}) => fakeCard(name, { typeLine: "Creature — Beast", power: "2", toughness: "2", manaCost: "{1}", ...extra });
  const named = (g: GameState, zone: "battlefield" | "graveyard" | "exile" | "hand" | "library", player: string, name: string) =>
    g.players[player]!.zones[zone].find((id) => g.cardData[g.cards[id]!.cardId]?.name === name);

  it("Bane of Progress : détruit artefacts et enchantements, un marqueur par permanent", () => {
    let g = toMain(newTestGame(2));
    let bane: string;
    [g] = put(g, "p2", fakeCard("Bague", { typeLine: "Artifact", manaCost: "{1}" }));
    [g] = put(g, "p2", fakeCard("Aura", { typeLine: "Enchantment", manaCost: "{1}" }), 1);
    [g, bane] = put(g, "p1", real("Bane of Progress"));
    g = resolveAll(g);
    expect(g.cards[bane]!.counters["+1/+1"]).toBe(2);
    expect(g.players.p2!.zones.battlefield).toHaveLength(0);
  });

  it("Living Death : les créatures des cimetières remplacent celles en jeu", () => {
    let g = toMain(newTestGame(2));
    let ld: string, alive: string;
    [g, alive] = put(g, "p1", creature("Vivant"));
    [g] = inHand(g, "p2", creature("Mort"));
    g = act(g, "p2", { type: "moveCard", cardId: g.players.p2!.zones.hand[0]!, to: "graveyard", force: true });
    [g, ld] = inHand(g, "p1", real("Living Death"));
    g = mana(g, "p1", "BBCCC");
    g = act(g, "p1", { type: "castSpell", cardId: ld });
    g = resolveAll(g);
    expect(g.cards[alive]!.zone).toBe("graveyard");
    expect(named(g, "battlefield", "p2", "Mort")).toBeDefined();
  });

  it("Shroudstomper : en arrivant et en attaquant", () => {
    let g = toMain(newTestGame(2));
    let stomper: string;
    const life = g.players.p2!.life;
    [g, stomper] = put(g, "p1", real("Shroudstomper"));
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(life - 2);
    delete g.cards[stomper]!.summoningSick;
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: stomper, defender: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(life - 4);
  });

  it("Endurance, Cavalier of Dawn, Tyrant of Discord", () => {
    let g = toMain(newTestGame(2));
    let rock: string;
    [g] = inHand(g, "p2", creature("Mort"));
    g = act(g, "p2", { type: "moveCard", cardId: g.players.p2!.zones.hand[0]!, to: "graveyard", force: true });
    [g] = put(g, "p1", real("Endurance"));
    const t = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.needsTargets);
    if (t) g = act(g, "p1", { type: "chooseTargets", cardId: t.instanceId, targets: [{ kind: "player", id: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p2!.zones.graveyard).toHaveLength(0);
    // Cavalier of Dawn : le contrôleur du permanent détruit reçoit un Golem 3/3.
    [g, rock] = put(g, "p2", fakeCard("Pierre", { typeLine: "Artifact", manaCost: "{1}" }));
    [g] = put(g, "p1", real("Cavalier of Dawn"), 0);
    const dawn = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.needsTargets);
    if (dawn) g = act(g, "p1", { type: "chooseTargets", cardId: dawn.instanceId, targets: [{ kind: "card", id: rock }] });
    g = resolveAll(g);
    expect(g.cards[rock]!.zone).toBe("graveyard");
    expect(g.players.p2!.zones.battlefield.some((id) => g.cards[id]!.isToken)).toBe(true);
    // Tyrant of Discord : sacrifices au hasard jusqu'à un terrain.
    [g] = put(g, "p2", basic("Forest"), 0);
    [g] = put(g, "p1", real("Tyrant of Discord"), 0);
    g = resolveAll(g);
    expect(g.players.p2!.zones.battlefield.length).toBeLessThan(2);
  });

  it("Greenwarden of Murasa et Cavalier of Gales en mourant", () => {
    let g = toMain(newTestGame(2));
    let warden: string, gales: string;
    [g] = inHand(g, "p1", creature("Souvenir"));
    g = act(g, "p1", { type: "moveCard", cardId: g.players.p1!.zones.hand[0]!, to: "graveyard", force: true });
    [g, warden] = put(g, "p1", real("Greenwarden of Murasa"));
    // En arrivant : on refuse de reprendre la carte.
    g = resolveAll(g);
    const etb = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.awaitingDecision)!;
    g = act(g, "p1", { type: "decideOptional", cardId: etb.instanceId, accept: false });
    g = resolveAll(g);
    expect(named(g, "graveyard", "p1", "Souvenir")).toBeDefined();
    // En mourant : on exile Greenwarden pour reprendre Souvenir.
    g = act(g, "p1", { type: "moveCard", cardId: warden, to: "graveyard", force: true });
    const dies = g.stack.map((id) => g.cards[id]!).find((c) => c.ability)!;
    if (dies.ability!.needsTargets) g = act(g, "p1", { type: "chooseTargets", cardId: dies.instanceId, targets: [{ kind: "card", id: named(g, "graveyard", "p1", "Souvenir")! }] });
    g = resolveAll(g);
    g = act(g, "p1", { type: "decideOptional", cardId: dies.instanceId, accept: true });
    g = resolveAll(g);
    expect(named(g, "hand", "p1", "Souvenir")).toBeDefined();
    expect(g.cards[warden]!.zone).toBe("exile");
    // Cavalier of Gales : pioche 3, en remet 2 dessus ; en mourant, mélangé dans la bibliothèque.
    const hand = g.players.p1!.zones.hand.length;
    [g, gales] = put(g, "p1", real("Cavalier of Gales"));
    g = resolveAll(g);
    const choice = g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice)!;
    g = act(g, "p1", { type: "chooseCards", cardId: choice.instanceId, cardIds: choice.cardChoice!.options.slice(0, 2) });
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1 + 3 - 2);
    const lib = g.players.p1!.zones.library.length;
    g = act(g, "p1", { type: "moveCard", cardId: gales, to: "graveyard", force: true });
    g = act(g, "p1", { type: "passPriority" });
    g = act(g, "p2", { type: "passPriority" });
    const scry = g.stack.map((id) => g.cards[id]!).find((c) => c.scry);
    expect(scry).toBeDefined();
    expect(g.players.p1!.zones.library).toHaveLength(lib + 1);
  });

  it("Fury : 4 blessures réparties, Incandescent Soulstoke, Horde of Notions, Cavalier of Thorns", () => {
    let g = toMain(newTestGame(2));
    let a: string, b: string, soul: string, horde: string;
    [g, a] = put(g, "p2", creature("A", { toughness: "3" }));
    [g, b] = put(g, "p2", creature("B", { toughness: "1" }), 1);
    [g] = put(g, "p1", real("Fury"));
    const fury = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.needsTargets)!;
    g = act(g, "p1", { type: "chooseTargets", cardId: fury.instanceId, targets: [{ kind: "card", id: a }, { kind: "card", id: a }, { kind: "card", id: a }, { kind: "card", id: b }] });
    g = resolveAll(g);
    expect(g.cards[a]!.zone).toBe("graveyard");
    expect(g.cards[b]!.zone).toBe("graveyard");
    // Soulstoke : un Élémental de la main, avec la célérité.
    [g, soul] = put(g, "p1", real("Incandescent Soulstoke"));
    delete g.cards[soul]!.summoningSick;
    let elem: string;
    [g, elem] = inHand(g, "p1", fakeCard("Élémental", { typeLine: "Creature — Elemental", power: "1", toughness: "1", manaCost: "{5}" }));
    g = mana(g, "p1", "RC");
    g = act(g, "p1", { type: "activateAbility", cardId: soul, index: 0 });
    g = resolveAll(g);
    const pick = g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice)!;
    g = act(g, "p1", { type: "chooseCards", cardId: pick.instanceId, cardIds: [elem] });
    g = resolveAll(g);
    expect(g.cards[elem]!.zone).toBe("battlefield");
    expect(hasKeyword(g, g.cards[elem]!, "Haste")).toBe(true);
    // Horde of Notions : l'Élémental du cimetière se lance gratuitement.
    g = act(g, "p1", { type: "moveCard", cardId: elem, to: "graveyard", force: true });
    [g, horde] = put(g, "p1", real("Horde of Notions"));
    g = mana(g, "p1", "WUBRG");
    g = act(g, "p1", { type: "activateAbility", cardId: horde, index: 0, targets: [{ kind: "card", id: elem }] });
    g = resolveAll(g);
    g = act(g, "p1", { type: "castSpell", cardId: elem });
    g = resolveAll(g);
    expect(g.cards[elem]!.zone).toBe("battlefield");
    for (const name of ["Bane of Progress", "Living Death", "Shroudstomper", "Endurance", "Cavalier of Dawn", "Tyrant of Discord", "Greenwarden of Murasa", "Cavalier of Gales", "Cavalier of Thorns", "Fury", "Incandescent Soulstoke", "Horde of Notions"]) {
      expect(cardSupport(real(name)).level, name).toBe("full");
    }
  });
});

describe("Deck Ashling : présage, retour du cimetière, Pyre, Descendants' Fury", () => {
  const elemental = (name: string, manaValue = 1) => fakeCard(name, { typeLine: "Creature — Elemental", power: "2", toughness: "2", manaCost: "{R}", colors: ["R"], manaValue });
  const goblin = (name: string, manaValue = 1) => fakeCard(name, { typeLine: "Creature — Goblin", power: "1", toughness: "1", manaCost: "{R}", colors: ["R"], manaValue });

  function inGraveyard(g: GameState, playerId: string, card: CardData): [GameState, string] {
    let id: string;
    [g, id] = inHand(g, playerId, card, 0);
    g = act(g, playerId, { type: "moveCard", cardId: id, to: "graveyard", force: true });
    return [g, id];
  }

  function inLibrary(g: GameState, playerId: string, card: CardData, n: number): [GameState, string] {
    g = structuredClone(g);
    const id = g.players[playerId]!.zones.library[n]!;
    g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
    return [g, id];
  }

  it("Haunting Voyage : deux Élémentaux au choix, ou tous s'il a été présagé", () => {
    let g = toMain(newTestGame(2));
    let a: string, b: string, c: string, gob: string, voyage: string;
    [g, a] = inGraveyard(g, "p1", elemental("Alpha"));
    [g, b] = inGraveyard(g, "p1", elemental("Beta"));
    [g, c] = inGraveyard(g, "p1", elemental("Gamma"));
    [g, gob] = inGraveyard(g, "p1", goblin("Gobelin"));
    [g, voyage] = inHand(g, "p1", real("Haunting Voyage", { manaValue: 6 }));
    // Lancé normalement : deux Élémentaux au choix.
    const normal = act(mana(g, "p1", "BBCCCC"), "p1", { type: "castSpell", cardId: voyage, chosenType: "Elemental" });
    let h = resolveAll(normal);
    const choice = h.cards[voyage]!.cardChoice!;
    expect(choice.options.sort()).toEqual([a, b, c].sort());
    expect(choice.max).toBe(2);
    h = act(h, "p1", { type: "chooseCards", cardId: voyage, cardIds: [a, c] });
    h = resolveAll(h);
    expect(h.cards[a]!.zone).toBe("battlefield");
    expect(h.cards[b]!.zone).toBe("graveyard");
    // Présagé : {2} pendant son tour, puis lancé à un tour suivant pour {5}{B}{B}.
    g = act(mana(g, "p1", "CC"), "p1", { type: "foretell", cardId: voyage });
    expect(g.cards[voyage]!.zone).toBe("exile");
    expect(g.cards[voyage]!.faceDown).toBe(true);
    expect(refuse(mana(g, "p1", "BBCCCCC"), "p1", { type: "castSpell", cardId: voyage, chosenType: "Elemental" })).toMatch(/main/);
    g = endTurn(g, "p1");
    g = endTurn(g, "p2");
    g = toMain(g);
    g = act(mana(g, "p1", "BBCCCCC"), "p1", { type: "castSpell", cardId: voyage, chosenType: "Elemental" });
    g = resolveAll(g);
    for (const id of [a, b, c]) expect(g.cards[id]!.zone).toBe("battlefield");
    expect(g.cards[gob]!.zone).toBe("graveyard");
    expect(cardSupport(real("Haunting Voyage")).level).toBe("full");
  });

  it("Wake the Dead : seulement pendant le combat d'un adversaire, et les créatures repartent à la fin du tour", () => {
    let g = toMain(newTestGame(2));
    let a: string, b: string, wake: string;
    [g, a] = inGraveyard(g, "p1", elemental("Alpha"));
    [g, b] = inGraveyard(g, "p1", goblin("Beta"));
    [g, wake] = inHand(g, "p1", real("Wake the Dead", { manaValue: 2 }));
    expect(refuse(mana(g, "p1", "BBCC"), "p1", { type: "castSpell", cardId: wake, x: 2 })).toMatch(/combat/);
    g = endTurn(g, "p1");
    g = act(g, "p2", { type: "nextStep", to: "beginCombat" });
    g = act(mana(g, "p1", "BBCC"), "p1", { type: "castSpell", cardId: wake, x: 2 });
    g = resolveAll(g);
    expect(g.cards[a]!.zone).toBe("battlefield");
    expect(g.cards[b]!.zone).toBe("battlefield");
    expect(g.cards[a]!.controllerId).toBe("p1");
    g = act(g, "p2", { type: "nextStep", to: "end" });
    g = resolveAll(g);
    expect(g.cards[a]!.zone).toBe("graveyard");
    expect(g.cards[b]!.zone).toBe("graveyard");
    expect(cardSupport(real("Wake the Dead")).level).toBe("full");
  });

  it("Pyre of Heroes : sacrifie un Élémental et cherche un Élémental de valeur de mana +1", () => {
    let g = toMain(newTestGame(2));
    let pyre: string, a: string, wanted: string, other: string;
    [g, pyre] = put(g, "p1", real("Pyre of Heroes"));
    [g, a] = put(g, "p1", elemental("Alpha", 2));
    [g, other] = inLibrary(g, "p1", goblin("Gobelin", 3), 0);
    [g, wanted] = inLibrary(g, "p1", elemental("Cherché", 3), 1);
    g = act(mana(g, "p1", "CC"), "p1", { type: "activateAbility", cardId: pyre, index: 0, sacrifice: a });
    expect(g.cards[a]!.zone).toBe("graveyard");
    g = resolveAll(g);
    const ability = g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice)!;
    expect(ability.cardChoice!.options).toEqual([wanted]);
    g = act(g, "p1", { type: "chooseCards", cardId: ability.instanceId, cardIds: [wanted] });
    g = resolveAll(g);
    // Les cartes changent d'identifiant en quittant une zone cachée : on les retrouve par leur nom.
    const names = (zone: "battlefield" | "library") => g.players.p1!.zones[zone].map((id) => g.cardData[g.cards[id]!.cardId]!.name);
    expect(names("battlefield")).toContain("Cherché");
    expect(names("library")).toContain("Gobelin");
    expect(cardSupport(real("Pyre of Heroes")).level).toBe("full");
  });

  it("Descendants' Fury : une seule fois pour toutes les créatures, sacrifie l'une d'elles et révèle jusqu'à une créature du même type", () => {
    let g = toMain(newTestGame(2));
    let a: string, b: string, gob: string, hit: string;
    [g] = put(g, "p1", real("Descendants' Fury"));
    [g, a] = put(g, "p1", elemental("Alpha"));
    [g, b] = put(g, "p1", elemental("Beta"));
    [g, gob] = inLibrary(g, "p1", goblin("Gobelin"), 0);
    [g, hit] = inLibrary(g, "p1", elemental("Trouvé"), 1);
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p2" }, { cardId: b, defender: "p2" }] });
    g = act(g, "p1", { type: "nextStep", to: "combatDamage" });
    g = resolveAll(g);
    const triggers = g.stack.map((id) => g.cards[id]!).filter((c) => c.ability?.awaitingDecision);
    expect(triggers).toHaveLength(1);
    g = act(g, "p1", { type: "decideOptional", cardId: triggers[0]!.instanceId, accept: true });
    g = resolveAll(g);
    const choosing = g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice)!;
    expect(choosing.cardChoice!.options.sort()).toEqual([a, b].sort());
    g = act(g, "p1", { type: "chooseCards", cardId: choosing.instanceId, cardIds: [a] });
    g = resolveAll(g);
    expect(g.cards[a]!.zone).toBe("graveyard");
    expect(g.cards[hit]!.zone).toBe("battlefield");
    expect(g.players.p1!.zones.library.at(-1)).toBe(gob);
    expect(cardSupport(real("Descendants' Fury")).level).toBe("full");
  });

  it("Subterfuge : la cible vole et fait piocher autant que ses blessures de combat", () => {
    let g = toMain(newTestGame(2));
    let bear: string, sub: string;
    [g, bear] = put(g, "p1", elemental("Ours"));
    [g, sub] = inHand(g, "p1", real("Subterfuge", { colors: ["U"], manaValue: 5 }));
    g = act(mana(g, "p1", "UCCCC"), "p1", { type: "castSpell", cardId: sub });
    g = resolveAll(g);
    const etb = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.needsTargets);
    if (etb) g = act(g, "p1", { type: "chooseTargets", cardId: etb.instanceId, targets: [{ kind: "card", id: bear }] });
    g = resolveAll(g);
    expect(hasKeyword(g, g.cards[bear]!, "Flying")).toBe(true);
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: bear, defender: "p2" }] });
    g = act(g, "p1", { type: "nextStep", to: "combatDamage" });
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 2);
    expect(cardSupport(real("Subterfuge")).level).toBe("full");
  });
});

describe("Deck Ashling : modes avec cibles", () => {
  const elemental = (name: string) => fakeCard(name, { typeLine: "Creature — Elemental", power: "2", toughness: "2", manaCost: "{R}", colors: ["R"] });

  it("Ashling's Command : les modes se choisissent en lançant, puis leurs cibles", () => {
    let g = toMain(newTestGame(2));
    let elem: string, foe: string, cmd: string;
    [g, elem] = put(g, "p1", elemental("Flammèche"));
    [g, foe] = put(g, "p2", elemental("Ennemi"));
    [g, cmd] = inHand(g, "p1", real("Ashling's Command", { manaValue: 5, colors: ["U", "R"] }));
    g = mana(g, "p1", "URCCC");
    expect(refuse(g, "p1", { type: "castSpell", cardId: cmd, modes: [0] })).toMatch(/2 modes/);
    // Copier l'Élémental et 2 blessures à chaque créature de p2.
    expect(refuse(g, "p1", { type: "castSpell", cardId: cmd, modes: [0, 2], targets: [{ kind: "card", id: foe }, { kind: "player", id: "p2" }] })).toMatch(/Cible invalide/);
    g = act(g, "p1", { type: "castSpell", cardId: cmd, modes: [0, 2], targets: [{ kind: "card", id: elem }, { kind: "player", id: "p2" }] });
    g = resolveAll(g);
    const copies = g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken && g.cardData[g.cards[id]!.cardId]!.name === "Flammèche");
    expect(copies).toHaveLength(1);
    expect(g.cards[foe]!.zone).toBe("graveyard");
    expect(g.cards[elem]!.zone).toBe("battlefield");
    expect(cardSupport(real("Ashling's Command")).level).toBe("full");
  });

  it("Ashling's Command : pioche et Trésors pour des joueurs ciblés", () => {
    let g = toMain(newTestGame(2));
    let cmd: string;
    [g, cmd] = inHand(g, "p1", real("Ashling's Command", { manaValue: 5, colors: ["U", "R"] }));
    g = mana(g, "p1", "URCCC");
    const hand = g.players.p2!.zones.hand.length;
    g = act(g, "p1", { type: "castSpell", cardId: cmd, modes: [3, 1], targets: [{ kind: "player", id: "p2" }, { kind: "player", id: "p1" }] });
    g = resolveAll(g);
    expect(g.players.p2!.zones.hand.length).toBe(hand + 2);
    expect(g.players.p1!.zones.battlefield.filter((id) => g.cardData[g.cards[id]!.cardId]!.name === "Treasure")).toHaveLength(2);
  });

  it("Titan of Industry : deux modes à l'arrivée, avec leurs cibles, et le marqueur bouclier", () => {
    let g = toMain(newTestGame(2));
    let titan: string, rock: string;
    [g, rock] = put(g, "p2", fakeCard("Caillou", { typeLine: "Artifact", manaCost: "{1}" }));
    [g, titan] = inHand(g, "p1", real("Titan of Industry", { manaValue: 7, colors: ["G"] }));
    g = mana(g, "p1", "GGGCCCC");
    g = act(g, "p1", { type: "castSpell", cardId: titan });
    g = resolveAll(g);
    const trigger = g.stack.map((id) => g.cards[id]!).find((c) => c.modes && !c.modes.chosen)!;
    expect(trigger).toBeDefined();
    g = act(g, "p1", { type: "chooseModes", cardId: trigger.instanceId, modes: [0, 3] });
    // Une seule cible possible (le Caillou) : choisie d'office ; le bouclier va sur le Titan, seule créature.
    expect(g.cards[trigger.instanceId]!.targets).toEqual([{ kind: "card", id: rock }]);
    g = resolveAll(g);
    expect(g.cards[rock]!.zone).toBe("graveyard");
    expect(g.cards[titan]!.counters.shield).toBe(1);
    // Le bouclier part à la place de la destruction.
    let wrath: string;
    [g, wrath] = inHand(g, "p2", fakeCard("Fléau", { typeLine: "Instant", oracleText: "Destroy target creature.", manaCost: "{B}" }));
    g = act(mana(g, "p2", "B"), "p2", { type: "castSpell", cardId: wrath, targets: [{ kind: "card", id: titan }] });
    g = resolveAll(g);
    expect(g.cards[titan]!.zone).toBe("battlefield");
    expect(g.cards[titan]!.counters.shield).toBeUndefined();
    expect(cardSupport(real("Titan of Industry")).level).toBe("full");
  });
});
