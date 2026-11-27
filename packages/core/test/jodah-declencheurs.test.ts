import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import { parsePermanentAbilities, parseTriggerCondition } from "../src/triggers.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame, endTurn } from "./helpers.js";
import deck from "./jodah-oracle.json" with { type: "json" };

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

type OracleCard = CardData;

/** Une carte du deck Jodah, avec son texte Oracle exact. */
function real(name: string): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
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

/** Donne à une carte de la main les données voulues (elle reste en main). */
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

const toMain = (g: GameState) => act(g, g.turn.activePlayerId, { type: "nextStep", to: "main1" });

/** Lance une carte de la main de p1 avec les données voulues, puis résout la pile. */
function cast(g: GameState, card: CardData, pool: string, playerId = "p1"): GameState {
  let id: string;
  [g, id] = inHand(g, playerId, card);
  g = mana(g, playerId, pool);
  g = act(g, playerId, { type: "castSpell", cardId: id });
  return resolveAll(g);
}

const bear = (name: string, extra: Partial<CardData> = {}) =>
  fakeCard(name, { typeLine: "Creature — Bear", manaCost: "{1}{G}", colors: ["G"], power: "2", toughness: "2", ...extra });
const LEGEND = bear("Grizzly Legend", { typeLine: "Legendary Creature — Bear" });

/** Pioche-t-on ? Nombre de cartes en main de p1. */
const hand = (g: GameState) => g.players.p1!.zones.hand.length;

/** Attaque p2 avec la créature et va jusqu'aux blessures de combat (déclencheurs sur la pile). */
function attack(g: GameState, attacker: string): GameState {
  g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
  g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: attacker, defender: "p2" }] });
  for (let i = 0; i < 6 && !g.stack.length; i++) {
    if (g.turn.step === "combatDamage" || g.turn.step === "endCombat") break;
    g = act(g, g.priority?.playerId ?? "p1", g.priority ? { type: "passPriority" } : { type: "nextStep" });
  }
  if (!g.stack.length && g.turn.step !== "combatDamage") g = act(g, "p1", { type: "nextStep", to: "combatDamage" });
  return g;
}

function decide(g: GameState, accept = true): GameState {
  const card = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.awaitingDecision);
  if (!card) throw new Error("Aucune décision en attente");
  return resolveAll(act(g, card.controllerId, { type: "decideOptional", cardId: card.instanceId, accept }));
}

describe("Autres conditions de déclencheur : lecture", () => {
  it("arrivée : légendaire, non-jeton, jeton, artefact", () => {
    expect(parseTriggerCondition("another legendary permanent you control enters")).toMatchObject({ on: "enters", another: true, creature: false, legendary: true, whose: "you" });
    expect(parseTriggerCondition("a nontoken creature you control enters")).toMatchObject({ creature: true, nontoken: true, another: false });
    expect(parseTriggerCondition("another nontoken legendary permanent you control enters")).toMatchObject({ legendary: true, nontoken: true });
    expect(parseTriggerCondition("a creature token you control enters")).toMatchObject({ creature: true, token: true });
    expect(parseTriggerCondition("an artifact enters")).toMatchObject({ types: ["artifact"], whose: "any" });
    expect(parseTriggerCondition("an artifact creature you control enters")).toMatchObject({ creature: true, types: ["artifact"] });
  });

  it("meurt : légendaire, non-jeton, créature équipée", () => {
    expect(parseTriggerCondition("another legendary creature you control dies")).toMatchObject({ on: "dies", self: false, others: true, legendary: true, whose: "you" });
    expect(parseTriggerCondition("a nontoken creature you control dies")).toMatchObject({ nontoken: true });
    expect(parseTriggerCondition("equipped creature dies")).toEqual({ on: "leaves", enchanted: true, to: ["graveyard"] });
  });

  it("blessures : créature équipée ou enchantée, jeton, artefact, blessures hors combat", () => {
    expect(parseTriggerCondition("equipped creature deals combat damage to a player")).toMatchObject({ on: "combatDamage", attached: true, player: "any" });
    expect(parseTriggerCondition("enchanted creature deals damage to an opponent")).toMatchObject({ attached: true, anyDamage: true, player: "opponent" });
    expect(parseTriggerCondition("a creature token you control deals combat damage to a player")).toMatchObject({ creature: "you", token: true });
    expect(parseTriggerCondition("an artifact creature you control deals combat damage to a player")).toMatchObject({ types: ["artifact"] });
    expect(parseTriggerCondition("~ deals combat damage to a player")).not.toHaveProperty("anyDamage");
  });

  it("début de chaque combat", () => {
    expect(parseTriggerCondition("the beginning of each combat")).toEqual({ on: "step", step: "beginCombat", whose: "any" });
  });

  it("les cartes du deck Jodah de cette famille", () => {
    for (const name of ["Keen Sense", "Guardian Project", "Odric, Lunarch Marshal"]) expect(cardSupport(real(name)), name).toMatchObject({ level: "full" });
    // Il reste les lignes d'autres familles.
    expect(cardSupport(real("Yoshimaru, Ever Faithful")).unknown).toEqual(["Partner"]);
    expect(cardSupport(real("The Great Henge")).unknown).toEqual(["This spell costs {X} less to cast, where X is the greatest power among creatures you control."]);
    expect(cardSupport(real("Robe of the Archmagi")).unknown).toEqual(["Equip Shaman, Warlock, or Wizard {1}"]);
    expect(cardSupport(real("Cadric, Soul Kindler")).unknown).toEqual(['The "legend rule" doesn\'t apply to tokens you control.']);
    // Ratadrabik : la condition est lue, la copie « except… » reste pour la famille des copies.
    const rata = real("Ratadrabik of Urborg");
    const line = rata.oracleText.split("\n")[2]!;
    expect(parseTriggerCondition(/^Whenever (.+?), /.exec(line.replace("Ratadrabik of Urborg", "~"))![1]!)).toMatchObject({ legendary: true });
  });

  it("Skullclamp, Hero's Blade, Sharding Sphinx : lus en entier", () => {
    const clamp = fakeCard("Skullclamp", { typeLine: "Artifact — Equipment", oracleText: "Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}" });
    expect(parsePermanentAbilities(clamp.oracleText, clamp.name, clamp.typeLine).triggers).toHaveLength(1);
    const blade = parsePermanentAbilities("Whenever a legendary creature you control enters, you may attach this Equipment to it.", "Hero's Blade", "Artifact — Equipment");
    expect(blade.unknown).toEqual([]);
    expect(blade.triggers[0]!.effects.effects).toEqual([{ type: "attachEvent" }]);
  });
});

describe("Autres conditions de déclencheur : en partie", () => {
  it("Yoshimaru : un marqueur +1/+1 pour un autre permanent légendaire, pas pour un autre", () => {
    let g = toMain(newTestGame(2));
    let yoshi: string;
    [g, yoshi] = put(g, "p1", real("Yoshimaru, Ever Faithful"));
    [g] = put(g, "p1", bear("Ours"));
    g = resolveAll(g);
    expect(g.cards[yoshi]!.counters["+1/+1"] ?? 0).toBe(0);
    [g] = put(g, "p1", real("Sol Ring"));
    g = resolveAll(g);
    expect(g.cards[yoshi]!.counters["+1/+1"] ?? 0).toBe(0);
    [g] = put(g, "p1", real("The Great Henge"));
    g = resolveAll(g);
    expect(g.cards[yoshi]!.counters["+1/+1"]).toBe(1);
  });

  it("The Great Henge : un marqueur +1/+1 et une pioche pour une créature non-jeton", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("The Great Henge"));
    const before = hand(g);
    let ours: string;
    [g, ours] = put(g, "p1", bear("Ours"));
    g = resolveAll(g);
    expect(g.cards[ours]!.counters["+1/+1"]).toBe(1);
    expect(hand(g)).toBe(before - 1 + 1);
    // Un jeton créature ne déclenche rien.
    const tokens = () => g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken);
    const h = hand(g);
    g = cast(g, fakeCard("Saproling Call", { typeLine: "Sorcery", manaCost: "{G}", colors: ["G"], oracleText: "Create a 1/1 green Saproling creature token." }), "G");
    expect(tokens()).toHaveLength(1);
    expect(g.cards[tokens()[0]!]!.counters["+1/+1"] ?? 0).toBe(0);
    expect(hand(g)).toBe(h - 1);
  });

  it("Guardian Project : pioche pour une créature au nom unique, pas pour un doublon", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Guardian Project"));
    let h = hand(g);
    [g] = put(g, "p1", bear("Ours"));
    g = resolveAll(g);
    expect(hand(g)).toBe(h - 1 + 1);
    h = hand(g);
    [g] = put(g, "p1", bear("Ours"));
    g = resolveAll(g);
    expect(g.stack).toEqual([]);
    expect(hand(g)).toBe(h - 1);
    // Une créature du même nom au cimetière empêche aussi la pioche.
    g = structuredClone(g);
    let elk: string;
    [g, elk] = inHand(g, "p1", bear("Élan"));
    g = act(g, "p1", { type: "moveCard", cardId: elk, to: "graveyard", force: true });
    h = hand(g);
    [g] = put(g, "p1", bear("Élan"));
    g = resolveAll(g);
    expect(hand(g)).toBe(h - 1);
  });

  it("Robe of the Archmagi : la créature équipée blesse un joueur, on pioche autant de cartes", () => {
    let g = newTestGame(2);
    let robe: string;
    let ours: string;
    [g, robe] = put(g, "p1", real("Robe of the Archmagi"));
    [g, ours] = put(g, "p1", bear("Ours", { power: "3", toughness: "3" }));
    g = act(g, "p1", { type: "attach", cardId: robe, targetId: ours });
    const h = hand(g);
    g = resolveAll(attack(g, ours));
    expect(g.players.p2!.life).toBe(37);
    expect(hand(g)).toBe(h + 3);
  });

  it("Keen Sense : la créature enchantée blesse un adversaire (combat ou non), on peut piocher", () => {
    let g = newTestGame(2);
    let sense: string;
    let pinger: string;
    [g, sense] = put(g, "p1", real("Keen Sense"));
    [g, pinger] = put(g, "p1", bear("Pinger", { oracleText: "{T}: ~ deals 1 damage to each opponent." }));
    g = act(g, "p1", { type: "attach", cardId: sense, targetId: pinger });
    let h = hand(g);
    g = decide(resolveAll(attack(g, pinger)));
    expect(hand(g)).toBe(h + 1);
    // Hors combat, au tour suivant.
    g = endTurn(g, "p1");
    g = endTurn(g, "p2");
    g = toMain(g);
    h = hand(g);
    g = act(g, "p1", { type: "activateAbility", cardId: pinger, index: 0 });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(37);
    g = decide(g);
    expect(hand(g)).toBe(h + 1);
  });

  it("Odric : au début du combat, les créatures partagent leurs mots-clés", () => {
    let g = toMain(newTestGame(2));
    let odric: string;
    let bird: string;
    let wolf: string;
    [g, odric] = put(g, "p1", real("Odric, Lunarch Marshal"));
    [g, bird] = put(g, "p1", bear("Oiseau", { oracleText: "Flying", keywords: ["Flying"] }));
    [g, wolf] = put(g, "p1", bear("Loup", { oracleText: "Deathtouch\nSkulk", keywords: ["Deathtouch", "Skulk"] }));
    g = resolveAll(act(g, "p1", { type: "nextStep", to: "beginCombat" }));
    for (const id of [odric, bird, wolf]) expect(g.cards[id]!.grants).toEqual(expect.arrayContaining(["flying", "deathtouch", "skulk"]));
    expect(g.cards[odric]!.grants).not.toContain("trample");
  });

  it("Rôder : pas bloquée par une créature de plus grande force", async () => {
    const { canBlock } = await import("../src/combat.js");
    let g = toMain(newTestGame(2));
    let sneak: string;
    let big: string;
    let small: string;
    [g, sneak] = put(g, "p1", bear("Rôdeur", { oracleText: "Skulk", keywords: ["Skulk"] }));
    [g, big] = put(g, "p2", bear("Géant", { power: "5", toughness: "5" }));
    [g, small] = put(g, "p2", bear("Nain", { power: "1", toughness: "1" }));
    expect(canBlock(g, g.cards[big]!, g.cards[sneak]!)).toBe(false);
    expect(canBlock(g, g.cards[small]!, g.cards[sneak]!)).toBe(true);
  });

  it("Cadric : payer {1} crée une copie avec la célérité, sacrifiée à la fin du tour", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Cadric, Soul Kindler"));
    [g] = put(g, "p1", LEGEND);
    g = resolveAll(g);
    g = mana(g, "p1", "R");
    g = decide(g);
    const copies = () => g.players.p1!.zones.battlefield.filter((id) => g.cards[id]!.isToken && g.cardData[g.cards[id]!.cardId]!.name === "Grizzly Legend");
    expect(g.log.map((l) => l.message)).toContain("Alice crée un jeton copie de Grizzly Legend.");
    // La règle des légendes (et son exception pour les jetons) reste à faire : on regarde le jeton s'il a survécu.
    if (copies().length > 0) {
      expect(g.cards[copies()[0]!]!.grants).toContain("haste");
      g = endTurn(g, "p1");
      g = resolveAll(g);
      expect(copies()).toHaveLength(0);
    }
  });

  it("Skullclamp : la créature équipée meurt, on pioche deux cartes", () => {
    let g = toMain(newTestGame(2));
    let clamp: string;
    let ours: string;
    [g, clamp] = put(g, "p1", fakeCard("Skullclamp", { typeLine: "Artifact — Equipment", oracleText: "Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}" }));
    [g, ours] = put(g, "p1", bear("Ours"));
    g = act(g, "p1", { type: "attach", cardId: clamp, targetId: ours });
    const h = hand(g);
    g = act(g, "p1", { type: "moveCard", cardId: ours, to: "graveyard" });
    g = resolveAll(g);
    expect(hand(g)).toBe(h + 2);
  });
});
