import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { chooseBotAction } from "../src/bot.js";
import { creatureStats, hasKeyword } from "../src/combat.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame } from "./helpers.js";
import deck from "./sheoldred-oracle.json" with { type: "json" };

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

/** Une carte du deck Sheoldred, avec son texte Oracle exact. */
function real(name: string, extra: Partial<CardData> = {}): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  const black = /\{B\}/.test(c.manaCost ?? "");
  return fakeCard(c.name, {
    typeLine: c.typeLine,
    oracleText: c.oracleText ?? "",
    manaCost: c.manaCost ?? "",
    colors: black ? ["B"] : [],
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
    if (g.stack.some((id) => g.cards[id]!.ability?.awaitingDecision)) break;
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

describe("Capacités activées", () => {
  it("Knight of Dusk's Shadow : +1/+1 jusqu'à la fin du tour, et les adversaires ne gagnent pas de PV", () => {
    let g = toMain(newTestGame(2));
    let knight: string;
    [g, knight] = put(g, "p1", real("Knight of Dusk's Shadow"));
    [g] = put(g, "p2", real("Sheoldred, the Apocalypse"));
    g = mana(g, "p1", "BB");
    g = act(g, "p1", { type: "activateAbility", cardId: knight, index: 0 });
    expect(g.stack).toHaveLength(1);
    expect(g.priority?.playerId).toBe("p1");
    g = resolveAll(g);
    expect(creatureStats(g, g.cards[knight]!)).toEqual({ power: 3, toughness: 3 });
    expect(g.players.p1!.manaPool.B).toBe(0);
    // Sheoldred de Bruno : il pioche, mais ne peut pas gagner de PV.
    g = act(g, "p2", { type: "draw", count: 1 });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(40);
    expect(g.log.some((l) => /ne peut pas gagner de points de vie/.test(l.message))).toBe(true);
    g = act(g, "p1", { type: "passTurn" });
    expect(creatureStats(g, g.cards[knight]!)).toEqual({ power: 2, toughness: 2 });
  });

  it("Temple Bell : s'engage pour faire piocher tout le monde", () => {
    let g = toMain(newTestGame(3));
    let bell: string;
    [g, bell] = put(g, "p1", real("Temple Bell"));
    const hands = ["p1", "p2", "p3"].map((p) => g.players[p]!.zones.hand.length);
    g = act(g, "p1", { type: "activateAbility", cardId: bell, index: 0 });
    expect(g.cards[bell]!.tapped).toBe(true);
    expect(refuse(g, "p1", { type: "activateAbility", cardId: bell, index: 0 })).toMatch(/déjà engagé/);
    g = resolveAll(g);
    expect(["p1", "p2", "p3"].map((p) => g.players[p]!.zones.hand.length)).toEqual(hands.map((n) => n + 1));
  });

  it("Blood Celebrant : capacité de mana sans la pile, couleur au choix et 1 PV", () => {
    let g = toMain(newTestGame(2));
    let celebrant: string;
    [g, celebrant] = put(g, "p1", real("Blood Celebrant"));
    g = mana(g, "p1", "B");
    expect(refuse(g, "p1", { type: "activateAbility", cardId: celebrant, index: 0 })).toMatch(/couleur/);
    g = act(g, "p1", { type: "activateAbility", cardId: celebrant, index: 0, color: "R" });
    expect(g.stack).toHaveLength(0);
    expect(g.players.p1!.manaPool).toMatchObject({ B: 0, R: 1 });
    expect(g.players.p1!.life).toBe(39);
  });

  it("Clattering Augur : ne bloque pas, revient du cimetière dans la main", () => {
    let g = toMain(newTestGame(2));
    let augur: string;
    [g, augur] = put(g, "p1", real("Clattering Augur"));
    g = resolveAll(g);
    g = act(g, "p1", { type: "moveCard", cardId: augur, to: "graveyard" });
    expect(refuse(g, "p2", { type: "activateAbility", cardId: augur, index: 0 })).toMatch(/cimetière/);
    g = mana(g, "p1", "BBBB");
    g = act(g, "p1", { type: "activateAbility", cardId: augur, index: 0 });
    g = resolveAll(g);
    expect(g.cards[augur]!.zone).toBe("hand");
  });

  it("Ob Nixilis : −2 détruit une créature, son contrôleur pioche deux cartes ; une fois par tour", () => {
    let g = toMain(newTestGame(2));
    let ob: string, victim: string;
    [g, ob] = put(g, "p1", real("Ob Nixilis, the Hate-Twisted"));
    [g, victim] = put(g, "p2", bear());
    expect(g.cards[ob]!.counters["loyauté"]).toBe(5);
    const hand = g.players.p2!.zones.hand.length;
    g = act(g, "p1", { type: "activateAbility", cardId: ob, index: 0, targets: [{ kind: "card", id: victim }] });
    expect(g.cards[ob]!.counters["loyauté"]).toBe(3);
    g = resolveAll(g);
    expect(g.cards[victim]!.zone).toBe("graveyard");
    // Les deux cartes piochées déclenchent aussi Ob Nixilis (1 blessure par carte).
    expect(g.players.p2!.zones.hand.length).toBe(hand + 2);
    expect(g.players.p2!.life).toBe(38);
    expect(refuse(g, "p1", { type: "activateAbility", cardId: ob, index: 0, targets: [{ kind: "player", id: "p2" }] })).toMatch(
      /déjà activé une capacité de loyauté/,
    );
  });

  it("Équipement : Lightning Greaves donne la célérité et le linceul, Darksteel Plate l'indestructible", () => {
    let g = toMain(newTestGame(2));
    let greaves: string, plate: string, bearId: string;
    [g, greaves] = put(g, "p1", real("Lightning Greaves"));
    [g, plate] = put(g, "p1", real("Darksteel Plate"));
    [g, bearId] = put(g, "p1", bear());
    g.cards[bearId]!.summoningSick = true;
    g = act(g, "p1", { type: "activateAbility", cardId: greaves, index: 0, targets: [{ kind: "card", id: bearId }] });
    g = resolveAll(g);
    expect(g.cards[greaves]!.attachedTo).toBe(bearId);
    expect(hasKeyword(g, g.cards[bearId]!, "Haste")).toBe(true);
    expect(hasKeyword(g, g.cards[bearId]!, "Shroud")).toBe(true);
    // Le linceul empêche d'y attacher un autre équipement.
    g = mana(g, "p1", "CC");
    expect(refuse(g, "p1", { type: "activateAbility", cardId: plate, index: 0, targets: [{ kind: "card", id: bearId }] })).toMatch(/Cible invalide/);
    // Équiper se fait à la vitesse d'un rituel.
    g = act(g, "p1", { type: "nextStep", to: "beginCombat" });
    expect(refuse(g, "p1", { type: "activateAbility", cardId: greaves, index: 0, targets: [{ kind: "card", id: bearId }] })).toMatch(/phase principale/);
  });

  it("Vito : les créatures gagnent le lien de vie jusqu'à la fin du tour", () => {
    let g = toMain(newTestGame(2));
    let vito: string, bearId: string;
    [g, vito] = put(g, "p1", real("Vito, Thorn of the Dusk Rose"));
    [g, bearId] = put(g, "p1", bear());
    g = mana(g, "p1", "BBBBB");
    g = act(g, "p1", { type: "activateAbility", cardId: vito, index: 0 });
    g = resolveAll(g);
    expect(hasKeyword(g, g.cards[bearId]!, "Lifelink")).toBe(true);
    g = act(g, "p1", { type: "passTurn" });
    expect(hasKeyword(g, g.cards[bearId]!, "Lifelink")).toBe(false);
  });
});

describe("Choix « peut »", () => {
  it("Exploit : Fell Stinger sacrifie une créature au choix, puis fait piocher et perdre 2 PV", () => {
    let g = toMain(newTestGame(2));
    let fodder: string, stinger: string;
    [g, fodder] = put(g, "p1", bear("Fodder"));
    [g, stinger] = inHand(g, "p1", real("Fell Stinger"), 1);
    g = mana(g, "p1", "BBB");
    g = act(g, "p1", { type: "castSpell", cardId: stinger });
    g = resolveAll(g);
    // La capacité d'exploitation attend la décision d'Alice ; personne ne peut passer.
    const exploit = g.stack.at(-1)!;
    expect(g.cards[exploit]!.ability?.awaitingDecision).toBe(true);
    expect(refuse(g, "p1", { type: "passPriority" })).toMatch(/décider/);
    expect(refuse(g, "p1", { type: "decideOptional", cardId: exploit, accept: true })).toMatch(/sacrifier/);
    g = act(g, "p1", { type: "decideOptional", cardId: exploit, accept: true, choice: fodder });
    expect(g.cards[fodder]!.zone).toBe("graveyard");
    // « When ~ exploits a creature, target player draws two cards and loses 2 life. »
    const trigger = g.stack.at(-1)!;
    expect(g.cards[trigger]!.ability?.needsTargets).toBe(true);
    g = act(g, "p1", { type: "chooseTargets", cardId: trigger, targets: [{ kind: "player", id: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(38);
  });

  it("« you may » : le contrôleur peut refuser, et le bot accepte", () => {
    let g = toMain(newTestGame(2));
    let well: string;
    [g, well] = put(g, "p1", fakeCard("Well", { typeLine: "Enchantment", oracleText: "At the beginning of your end step, you may draw a card." }));
    void well;
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "nextStep", to: "end" });
    g = resolveAll(g);
    const id = g.stack.at(-1)!;
    expect(chooseBotAction(g, "p1")).toEqual({ type: "decideOptional", cardId: id, accept: true });
    g = act(g, "p1", { type: "decideOptional", cardId: id, accept: false });
    expect(g.stack).toHaveLength(0);
    expect(g.players.p1!.zones.hand.length).toBe(hand);
  });
});

describe("Effets statiques", () => {
  it("Jet Medallion et Bontu's Monument réduisent le coût ; le Monument se déclenche au lancement d'une créature", () => {
    let g = toMain(newTestGame(2));
    let knight: string;
    [g] = put(g, "p1", real("Jet Medallion"));
    [g] = put(g, "p1", real("Bontu's Monument"));
    [g, knight] = inHand(g, "p1", real("Knight of Dusk's Shadow"), 2);
    g = mana(g, "p1", "B");
    // {1}{B} moins 2 : il ne reste que {B}.
    g = act(g, "p1", { type: "castSpell", cardId: knight });
    expect(g.log.some((l) => /réduction de \{2\}/.test(l.message))).toBe(true);
    g = resolveAll(g);
    expect(g.cards[knight]!.zone).toBe("battlefield");
    expect(g.players.p2!.life).toBe(39);
    expect(g.players.p1!.life).toBe(41);
  });

  it("Village Rites : sacrifier une créature fait partie du coût", () => {
    let g = toMain(newTestGame(2));
    let rites: string, fodder: string;
    [g, fodder] = put(g, "p1", bear());
    [g, rites] = inHand(g, "p1", real("Village Rites"), 1);
    g = mana(g, "p1", "B");
    expect(refuse(g, "p1", { type: "castSpell", cardId: rites })).toMatch(/sacrifier/);
    g = act(g, "p1", { type: "castSpell", cardId: rites, sacrifice: fodder });
    expect(g.cards[fodder]!.zone).toBe("graveyard");
    const hand = g.players.p1!.zones.hand.length;
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 2);
  });

  it("Psychosis Crawler compte la main ; « no maximum hand size » supprime le rappel de défausse", () => {
    let g = toMain(newTestGame(2));
    let crawler: string;
    [g, crawler] = put(g, "p1", real("Psychosis Crawler"));
    const n = g.players.p1!.zones.hand.length;
    expect(creatureStats(g, g.cards[crawler]!)).toEqual({ power: n, toughness: n });
    [g] = put(g, "p1", real("Reliquary Tower"));
    g = act(g, "p1", { type: "draw", count: 5 });
    g = resolveAll(g);
    g = act(g, "p1", { type: "nextStep", to: "cleanup" });
    expect(g.log.some((l) => /doit en défausser/.test(l.message))).toBe(false);
  });

  it("Howling Golem fait piocher quand il attaque ; Creeping Bloodsucker rend les PV infligés", () => {
    let g = toMain(newTestGame(3));
    let golem: string;
    [g, golem] = put(g, "p1", real("Howling Golem"));
    [g] = put(g, "p1", real("Creeping Bloodsucker"));
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    const hands = ["p1", "p2", "p3"].map((p) => g.players[p]!.zones.hand.length);
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: golem, defender: "p2" }] });
    g = resolveAll(g);
    expect(["p1", "p2", "p3"].map((p) => g.players[p]!.zones.hand.length)).toEqual(hands.map((n) => n + 1));
    g = act(g, "p1", { type: "passTurn" });
    g = act(g, "p2", { type: "passTurn" });
    g = act(g, "p3", { type: "passTurn" });
    // Entretien d'Alice : 1 blessure à chaque adversaire, puis autant de PV gagnés.
    const life = g.players.p1!.life;
    g = resolveAll(g);
    expect(g.players.p1!.life).toBe(life + 2);
  });
});

describe("Deck Sheoldred", () => {
  it("la plupart des cartes sont gérées en entier", () => {
    const levels = (deck as OracleCard[]).map((c) => cardSupport(fakeCard(c.name, { typeLine: c.typeLine, oracleText: c.oracleText ?? "" })).level);
    const full = levels.filter((l) => l === "full").length;
    expect(full).toBeGreaterThanOrEqual(47);
  });
});
