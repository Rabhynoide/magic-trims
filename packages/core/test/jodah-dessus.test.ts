import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame } from "./helpers.js";
import deck from "./jodah-oracle.json" with { type: "json" };

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

function refuse(g: GameState, actorId: string, action: GameAction): string {
  const r = applyAction(g, { actorId, action });
  if (r.ok) throw new Error("L'action aurait dû être refusée.");
  return r.error;
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
    ...(c.loyalty ? { loyalty: c.loyalty } : {}),
  });
}

function setData(g: GameState, id: string, card: CardData): void {
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
}

/** Met une carte de la main sur le champ de bataille (sans mal d'invocation). */
function put(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  setData(g, id, card);
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  delete g.cards[id]!.summoningSick;
  return [g, id];
}

function inHand(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  setData(g, id, card);
  return [g, id];
}

/** Les cartes du dessus de la bibliothèque du joueur reçoivent ces données (la 1re est dessus). */
function stackLibrary(g: GameState, playerId: string, cards: CardData[]): string[] {
  const lib = g.players[playerId]!.zones.library;
  cards.forEach((c, i) => setData(g, lib[i]!, c));
  return lib.slice(0, cards.length);
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

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const choosing = (g: GameState) => g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice);
const legendary = (name: string, mv: number) =>
  fakeCard(name, { typeLine: "Legendary Creature — Human", manaCost: `{${mv}}`, manaValue: mv, power: "1", toughness: "1" });
const plain = (name: string, mv: number) => fakeCard(name, { typeLine: "Creature — Human", manaCost: `{${mv}}`, manaValue: mv, power: "1", toughness: "1" });
const land = (name: string) => fakeCard(name, { typeLine: "Basic Land — Forest", manaCost: "", manaValue: 0, oracleText: "({T}: Add {G}.)" });

describe("Dessus de la bibliothèque et sorts gratuits depuis l'exil : lecture", () => {
  it("Stock Up, Jodah, Etali et Dihada sont gérés en entier (le −11 de Dihada vient de la famille 22)", () => {
    for (const name of ["Stock Up", "Jodah, the Unifier", "Etali, Primal Storm", "Dihada, Binder of Wills"]) {
      expect(cardSupport(real(name)), name).toMatchObject({ level: "full" });
    }
  });
});

describe("Dessus de la bibliothèque et sorts gratuits depuis l'exil : en partie", () => {
  it("Stock Up : deux des cinq cartes du dessus en main, les trois autres dessous", () => {
    let g = toMain(newTestGame(2));
    const top = stackLibrary(g, "p1", [plain("A", 1), plain("B", 2), plain("C", 3), plain("D", 4), plain("E", 5)]);
    let stock: string;
    [g, stock] = inHand(g, "p1", real("Stock Up"));
    g = mana(g, "p1", "UCC");
    const libSize = g.players.p1!.zones.library.length;
    g = act(g, "p1", { type: "castSpell", cardId: stock });
    g = resolveAll(g);
    const choice = choosing(g)!;
    expect(choice.cardChoice).toMatchObject({ options: top, min: 2, max: 2 });
    // Seul le lanceur voit les cartes regardées.
    expect(g.cards[top[0]!]!.revealedTo).toEqual(["p1"]);
    expect(refuse(g, "p1", { type: "chooseCards", cardId: choice.instanceId, cardIds: [top[1]!] })).toBeTruthy();
    g = act(g, "p1", { type: "chooseCards", cardId: choice.instanceId, cardIds: [top[1]!, top[3]!] });
    g = resolveAll(g);
    expect(g.cards[top[1]!]!.zone).toBe("hand");
    expect(g.cards[top[3]!]!.zone).toBe("hand");
    const lib = g.players.p1!.zones.library;
    expect(lib).toHaveLength(libSize - 2);
    expect(lib.slice(-3).sort()).toEqual([top[0]!, top[2]!, top[4]!].sort());
    expect(g.cards[stock]!.zone).toBe("graveyard");
  });

  it("Dihada −3 : les légendaires en main, le reste au cimetière, un Trésor par carte au cimetière", () => {
    let g = toMain(newTestGame(2));
    const top = stackLibrary(g, "p1", [legendary("Héros", 3), plain("Soldat", 2), land("Forêt"), legendary("Reine", 5)]);
    let dihada: string;
    [g, dihada] = put(g, "p1", real("Dihada, Binder of Wills"));
    expect(g.cards[dihada]!.counters["loyauté"]).toBe(5);
    g = act(g, "p1", { type: "activateAbility", cardId: dihada, index: 1 });
    expect(g.cards[dihada]!.counters["loyauté"]).toBe(2);
    g = resolveAll(g);
    const choice = choosing(g)!;
    // Seules les légendaires se choisissent, autant qu'on veut ; tout le monde les voit.
    expect(choice.cardChoice).toMatchObject({ options: [top[0], top[3]], min: 0, max: 2 });
    expect(g.cards[top[1]!]!.revealedTo).toEqual(g.turnOrder);
    g = act(g, "p1", { type: "chooseCards", cardId: choice.instanceId, cardIds: [top[3]!] });
    g = resolveAll(g);
    expect(g.cards[top[3]!]!.zone).toBe("hand");
    for (const id of [top[0]!, top[1]!, top[2]!]) expect(g.cards[id]!.zone).toBe("graveyard");
    const treasures = g.players.p1!.zones.battlefield.filter((id) => g.cardData[g.cards[id]!.cardId]?.name === "Treasure");
    expect(treasures).toHaveLength(3);
  });

  it("Jodah : un sort légendaire lancé de la main exile jusqu'à une légendaire non-terrain moins chère, lançable gratuitement", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Jodah, the Unifier"));
    // Dessus : un terrain légendaire n'arrête pas, une non légendaire moins chère non plus, une légendaire trop chère non plus.
    const top = stackLibrary(g, "p1", [
      fakeCard("Ville", { typeLine: "Legendary Land", manaCost: "", manaValue: 0 }),
      plain("Soldat", 1),
      legendary("Géant", 6),
      legendary("Héros", 3),
    ]);
    let queen: string;
    [g, queen] = inHand(g, "p1", legendary("Reine", 4), 1);
    g = mana(g, "p1", "CCCC");
    const libSize = g.players.p1!.zones.library.length;
    g = act(g, "p1", { type: "castSpell", cardId: queen });
    // Le déclencheur de Jodah se résout, la Reine est encore sur la pile.
    g = act(g, "p1", { type: "passPriority" });
    g = act(g, "p2", { type: "passPriority" });
    expect(g.stack).toEqual([queen]);
    const hero = top[3]!;
    expect(g.cards[hero]!.zone).toBe("exile");
    expect(g.cards[hero]!.castPermission).toMatchObject({ free: true, reason: "Jodah, the Unifier", whileOnStack: queen });
    // Les trois autres sont dessous.
    expect(g.players.p1!.zones.library).toHaveLength(libSize - 1);
    const names = g.players.p1!.zones.library.slice(-3).map((id) => g.cardData[g.cards[id]!.cardId]?.name).sort();
    expect(names).toEqual(["Géant", "Soldat", "Ville"]);
    g = act(g, "p1", { type: "castSpell", cardId: hero });
    // Lancé depuis l'exil : Jodah ne se déclenche pas de nouveau (« from your hand »).
    expect(g.stack).toEqual([queen, hero]);
    g = resolveAll(g);
    expect(g.cards[hero]!.zone).toBe("battlefield");
    expect(g.cards[queen]!.zone).toBe("battlefield");
    expect(g.players.p1!.manaPool).toMatchObject({ C: 0 });
  });

  it("Jodah : rien pour un sort non légendaire ; la carte non lancée va dessous quand le sort quitte la pile", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Jodah, the Unifier"));
    const top = stackLibrary(g, "p1", [legendary("Héros", 1)]);
    let soldier: string;
    [g, soldier] = inHand(g, "p1", plain("Soldat", 2), 1);
    g = mana(g, "p1", "CC");
    g = act(g, "p1", { type: "castSpell", cardId: soldier });
    expect(g.stack).toEqual([soldier]);
    g = resolveAll(g);
    let queen: string;
    [g, queen] = inHand(g, "p1", legendary("Reine", 4), 1);
    g = mana(g, "p1", "CCCC");
    g = act(g, "p1", { type: "castSpell", cardId: queen });
    g = act(g, "p1", { type: "passPriority" });
    g = act(g, "p2", { type: "passPriority" });
    expect(g.cards[top[0]!]!.zone).toBe("exile");
    // On ne le lance pas : la Reine se résout, le Héros part dessous.
    g = resolveAll(g);
    // (une carte qui rejoint la bibliothèque change d'identifiant)
    expect(g.cards[top[0]!]).toBeUndefined();
    const bottom = g.players.p1!.zones.library.at(-1)!;
    expect(g.cardData[g.cards[bottom]!.cardId]?.name).toBe("Héros");
    expect(g.players.p1!.zones.exile).toHaveLength(0);
  });

  it("Etali : la carte du dessus de chaque bibliothèque, ses sorts lancés gratuitement pendant l'étape, même ceux d'un adversaire", () => {
    let g = toMain(newTestGame(3));
    let etali: string;
    [g, etali] = put(g, "p1", real("Etali, Primal Storm"));
    const [mine] = stackLibrary(g, "p1", [plain("Mien", 3)]);
    const [theirs] = stackLibrary(g, "p2", [legendary("Sien", 5)]);
    const [ground] = stackLibrary(g, "p3", [land("Forêt")]);
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: etali, defender: "p2" }] });
    g = resolveAll(g);
    for (const id of [mine!, theirs!, ground!]) expect(g.cards[id]!.zone).toBe("exile");
    expect(g.cards[theirs!]!.castPermission).toMatchObject({ free: true, caster: "p1" });
    expect(g.cards[ground!]!.castPermission).toBeUndefined();
    // Bruno ne peut pas lancer sa propre carte : la permission est à Alice.
    expect(refuse(g, "p2", { type: "castSpell", cardId: theirs! })).toBeTruthy();
    g = act(g, "p1", { type: "castSpell", cardId: theirs! });
    g = resolveAll(g);
    expect(g.cards[theirs!]!.zone).toBe("battlefield");
    expect(g.cards[theirs!]!.controllerId).toBe("p1");
    expect(g.cards[theirs!]!.ownerId).toBe("p2");
    expect(g.players.p1!.zones.battlefield).toContain(theirs);
    // Après l'étape, la permission ne tient plus : la carte reste en exil.
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    expect(refuse(g, "p1", { type: "castSpell", cardId: mine! })).toBeTruthy();
    expect(g.cards[mine!]!.zone).toBe("exile");
  });
});
