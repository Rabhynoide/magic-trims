import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { chooseBotAction } from "../src/bot.js";
import { creatureStats, hasKeyword } from "../src/combat.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame, endTurn } from "./helpers.js";
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
    if (g.stack.some((id) => g.cards[id]!.ability?.awaitingDecision || (g.cards[id]!.scry && !g.cards[id]!.scry!.done) || (g.cards[id]!.modes && !g.cards[id]!.modes!.chosen) || g.cards[id]!.cardChoice)) break;
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
    g = endTurn(g, "p1");
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
    g = endTurn(g, "p1");
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
    g = endTurn(g, "p1");
    g = endTurn(g, "p2");
    g = endTurn(g, "p3");
    // Entretien d'Alice : 1 blessure à chaque adversaire, puis autant de PV gagnés.
    const life = g.players.p1!.life;
    g = resolveAll(g);
    expect(g.players.p1!.life).toBe(life + 2);
  });
});

describe("Cartes Sheoldred restantes", () => {
  it("Gray Merchant : chaque adversaire perd sa dévotion au noir, et tu gagnes autant", () => {
    let g = toMain(newTestGame(3));
    let merchant: string;
    [g] = put(g, "p1", real("Knight of Dusk's Shadow", { manaCost: "{1}{B}" }));
    [g, merchant] = inHand(g, "p1", real("Gray Merchant of Asphodel"), 1);
    g = mana(g, "p1", "BBBBB");
    g = act(g, "p1", { type: "castSpell", cardId: merchant });
    g = resolveAll(g);
    // Dévotion : {B}{B} du Merchant + {B} du Knight = 3.
    expect(g.players.p2!.life).toBe(37);
    expect(g.players.p3!.life).toBe(37);
    expect(g.players.p1!.life).toBe(46);
  });

  it("Cut Down ne vise qu'une créature de force + endurance 5 ou moins", () => {
    let g = toMain(newTestGame(2));
    let small: string, big: string, cut: string;
    [g, small] = put(g, "p2", fakeCard("Ours", { typeLine: "Creature — Bear", power: "2", toughness: "2" }));
    [g, big] = put(g, "p2", real("Sheoldred, the Apocalypse"), 1);
    [g, cut] = inHand(g, "p1", real("Cut Down"));
    g = mana(g, "p1", "B");
    expect(refuse(g, "p1", { type: "castSpell", cardId: cut, targets: [{ kind: "card", id: big }] })).toMatch(/Cible invalide/);
    g = act(g, "p1", { type: "castSpell", cardId: cut, targets: [{ kind: "card", id: small }] });
    g = resolveAll(g);
    expect(g.cards[small]!.zone).toBe("graveyard");
  });

  it("Feed the Swarm fait perdre la valeur de mana du permanent détruit", () => {
    let g = toMain(newTestGame(2));
    let victim: string, swarm: string;
    [g, victim] = put(g, "p2", real("Sheoldred, the Apocalypse", { manaValue: 4 }));
    [g, swarm] = inHand(g, "p1", real("Feed the Swarm"));
    g = mana(g, "p1", "BB");
    g = act(g, "p1", { type: "castSpell", cardId: swarm, targets: [{ kind: "card", id: victim }] });
    g = resolveAll(g);
    expect(g.cards[victim]!.zone).toBe("graveyard");
    expect(g.players.p1!.life).toBe(36);
  });

  it("Morbid Opportunist : une seule pioche par tour, même si plusieurs créatures meurent", () => {
    let g = toMain(newTestGame(2));
    let a: string, b: string, c: string;
    [g] = put(g, "p1", real("Morbid Opportunist"));
    [g, a] = put(g, "p2", fakeCard("A", { typeLine: "Creature — Bear", power: "2", toughness: "2" }), 0);
    [g, b] = put(g, "p2", fakeCard("B", { typeLine: "Creature — Bear", power: "2", toughness: "2" }), 0);
    [g, c] = put(g, "p2", fakeCard("C", { typeLine: "Creature — Bear", power: "2", toughness: "2" }), 0);
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p2", { type: "moveCard", cardId: a, to: "graveyard" });
    g = resolveAll(g);
    g = act(g, "p2", { type: "moveCard", cardId: b, to: "graveyard" });
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 1);
    g = endTurn(g, "p1");
    g = act(g, "p2", { type: "moveCard", cardId: c, to: "graveyard" });
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 2);
  });

  it("Peer into the Abyss : la moitié de la bibliothèque et des PV, arrondies au supérieur", () => {
    let g = toMain(newTestGame(2));
    let peer: string;
    [g, peer] = inHand(g, "p1", real("Peer into the Abyss"));
    g = mana(g, "p1", "BBBBBBB");
    g = act(g, "p1", { type: "adjustLife", playerId: "p2", delta: -1 });
    const library = g.players.p2!.zones.library.length;
    const hand = g.players.p2!.zones.hand.length;
    g = act(g, "p1", { type: "castSpell", cardId: peer, targets: [{ kind: "player", id: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p2!.zones.hand.length).toBe(hand + Math.ceil(library / 2));
    expect(g.players.p2!.life).toBe(19);
  });
});

describe("Regard, Wound Reflection, Teferi's Puzzle Box", () => {
  it("Read the Bones : le regard attend le choix du joueur, puis il pioche les cartes gardées", () => {
    let g = toMain(newTestGame(2));
    let bones: string;
    [g, bones] = inHand(g, "p1", real("Read the Bones"));
    g = mana(g, "p1", "BBB");
    const [a, b, c] = g.players.p1!.zones.library;
    g = act(g, "p1", { type: "castSpell", cardId: bones });
    g = resolveAll(g);
    expect(g.cards[bones]!.zone).toBe("stack");
    expect(g.cards[bones]!.scry).toEqual({ count: 2 });
    expect(g.cards[a!]!.revealedTo).toContain("p1");
    expect(refuse(g, g.priority!.playerId, { type: "passPriority" })).toMatch(/regard/);
    expect(refuse(g, "p1", { type: "scry", cardId: bones, top: [a!, c!], bottom: [] })).toMatch(/Range exactement/);
    expect(refuse(g, "p2", { type: "scry", cardId: bones, top: [a!], bottom: [b!] })).toMatch(/contrôleur/);
    g = act(g, "p1", { type: "scry", cardId: bones, top: [b!], bottom: [a!] });
    expect(g.cards[bones]!.zone).toBe("graveyard");
    expect(g.cards[bones]!.scry).toBeUndefined();
    const hand = g.players.p1!.zones.hand;
    expect(hand).toContain(b!);
    expect(hand).toContain(c!);
    expect(g.players.p1!.zones.library.at(-1)).toBe(a!);
    expect(g.players.p1!.life).toBe(38);
  });

  it("le bot garde les cartes de son regard au-dessus", () => {
    let g = toMain(newTestGame(2));
    let bones: string;
    [g, bones] = inHand(g, "p1", real("Read the Bones"));
    g = mana(g, "p1", "BBB");
    g = act(g, "p1", { type: "castSpell", cardId: bones });
    g = resolveAll(g);
    const action = chooseBotAction(g, "p1");
    expect(action?.type).toBe("scry");
    g = act(g, "p1", action!);
    expect(g.cards[bones]!.zone).toBe("graveyard");
  });

  it("Wound Reflection : à l'étape de fin, chaque adversaire reperd les PV perdus ce tour", () => {
    let g = toMain(newTestGame(3));
    [g] = put(g, "p1", real("Wound Reflection"));
    g = act(g, "p1", { type: "adjustLife", playerId: "p2", delta: -3 });
    g = act(g, "p1", { type: "adjustLife", playerId: "p2", delta: 1 });
    g = act(g, "p1", { type: "nextStep", to: "end" });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(35);
    expect(g.players.p3!.life).toBe(40);
    expect(g.players.p1!.life).toBe(40);
  });

  it("Teferi's Puzzle Box : à sa pioche, le joueur remplace sa main", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Teferi's Puzzle Box"));
    g = endTurn(g, "p1");
    g = resolveAll(g);
    const before = [...g.players.p2!.zones.hand];
    if (g.turn.step !== "draw") g = act(g, "p2", { type: "nextStep", to: "draw" });
    g = resolveAll(g);
    const after = g.players.p2!.zones.hand;
    expect(after.length).toBe(before.length + 1);
    expect(after.filter((id) => before.includes(id)).length).toBeLessThanOrEqual(1);
  });

  it("les cartes sont reconnues en entier", () => {
    for (const name of ["Read the Bones", "Wound Reflection", "Teferi's Puzzle Box"]) {
      const c = real(name);
      expect(cardSupport(c).level, name).toBe("full");
    }
  });
});

describe("Coût alternatif, retours sur le champ de bataille, auras", () => {
  it("Baleful Mastery : pour {1}{B}, un adversaire choisi pioche une carte", () => {
    let g = toMain(newTestGame(3));
    let victim: string, mastery: string;
    [g, victim] = put(g, "p2", real("Sheoldred, the Apocalypse"));
    [g, mastery] = inHand(g, "p1", real("Baleful Mastery", { manaCost: "{3}{B}" }));
    g = mana(g, "p1", "BB");
    const hand = g.players.p3!.zones.hand.length;
    expect(refuse(g, "p1", { type: "castSpell", cardId: mastery, targets: [{ kind: "card", id: victim }] })).toMatch(/Pas assez de mana/);
    g = act(g, "p1", {
      type: "castSpell",
      cardId: mastery,
      alternative: true,
      targets: [{ kind: "player", id: "p3" }, { kind: "card", id: victim }],
    });
    g = resolveAll(g);
    expect(g.cards[victim]!.zone).toBe("exile");
    expect(g.players.p3!.zones.hand.length).toBe(hand + 1);
    expect(g.cards[mastery]!.alternative).toBeUndefined();
  });

  it("Malakir Rebirth : la créature revient engagée quand elle meurt ce tour-ci", () => {
    let g = toMain(newTestGame(2));
    let bear0: string, rebirth: string;
    [g, bear0] = put(g, "p1", bear());
    [g, rebirth] = inHand(g, "p1", real("Malakir Rebirth // Malakir Mire", { faces: [] }));
    g = structuredClone(g);
    // Les faces du test n'ont pas de texte : on donne celui de la face sort.
    const oracle = 'Choose target creature. You lose 2 life. Until end of turn, that creature gains "When this creature dies, return it to the battlefield tapped under its owner\'s control."';
    g.cardData[g.cards[rebirth]!.cardId] = { ...g.cardData[g.cards[rebirth]!.cardId]!, typeLine: "Instant", oracleText: oracle, manaCost: "{B}" };
    g = mana(g, "p1", "B");
    g = act(g, "p1", { type: "castSpell", cardId: rebirth, targets: [{ kind: "card", id: bear0 }] });
    g = resolveAll(g);
    expect(g.players.p1!.life).toBe(38);
    expect(g.cards[bear0]!.grantedTriggers).toHaveLength(1);
    g = act(g, "p1", { type: "moveCard", cardId: bear0, to: "graveyard" });
    g = resolveAll(g);
    expect(g.cards[bear0]!.zone).toBe("battlefield");
    expect(g.cards[bear0]!.tapped).toBe(true);
    expect(g.cards[bear0]!.grantedTriggers).toBeUndefined();
    // Elle n'a plus la capacité : une seconde mort est définitive.
    g = act(g, "p1", { type: "moveCard", cardId: bear0, to: "graveyard" });
    g = resolveAll(g);
    expect(g.cards[bear0]!.zone).toBe("graveyard");
  });

  it("Kaya's Ghostform : lancée sur une créature, elle la ramène quand elle meurt ou est exilée", () => {
    let g = toMain(newTestGame(2));
    let bear0: string, ghost: string;
    [g, bear0] = put(g, "p1", bear());
    [g, ghost] = inHand(g, "p1", real("Kaya's Ghostform"));
    g = mana(g, "p1", "B");
    expect(refuse(g, "p1", { type: "castSpell", cardId: ghost })).toMatch(/aura enchante/);
    g = act(g, "p1", { type: "castSpell", cardId: ghost, targets: [{ kind: "card", id: bear0 }] });
    g = resolveAll(g);
    expect(g.cards[ghost]!.zone).toBe("battlefield");
    expect(g.cards[ghost]!.attachedTo).toBe(bear0);
    g = act(g, "p1", { type: "moveCard", cardId: bear0, to: "exile" });
    g = resolveAll(g);
    expect(g.cards[bear0]!.zone).toBe("battlefield");
    expect(g.cards[ghost]!.zone).toBe("graveyard");
  });

  it("les cartes sont reconnues en entier", () => {
    for (const name of ["Baleful Mastery", "Kaya's Ghostform"]) expect(cardSupport(real(name)).level, name).toBe("full");
  });
});

describe("Deuxième pioche, mana en plus, payer X", () => {
  it("Gixian Puppeteer : seulement à la deuxième carte piochée du tour", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Gixian Puppeteer"));
    g = act(g, "p1", { type: "draw", count: 1 });
    g = resolveAll(g);
    // La pioche du tour compte : le tour 1 de p1 n'en a pas, donc ceci est la première… ou la deuxième.
    const drawn = g.players.p1!.drawsThisTurn!.count;
    g = act(g, "p1", { type: "draw", count: 1 });
    g = resolveAll(g);
    g = act(g, "p1", { type: "draw", count: 1 });
    g = resolveAll(g);
    // Une seule fois sur ces pioches, quand le compte passe par 2.
    expect(drawn).toBeLessThanOrEqual(2);
    expect(g.players.p2!.life).toBe(38);
    expect(g.players.p1!.life).toBe(42);
  });

  it("Bubbling Muck : chaque Swamp engagé donne {B} en plus jusqu'à la fin du tour", () => {
    let g = toMain(newTestGame(2));
    let swamp: string, muck: string;
    [g, swamp] = put(g, "p1", fakeCard("Swamp", { typeLine: "Basic Land — Swamp", manaCost: "" }));
    [g, muck] = inHand(g, "p1", real("Bubbling Muck", { manaCost: "{B}" }));
    g = mana(g, "p1", "B");
    g = act(g, "p1", { type: "castSpell", cardId: muck });
    g = resolveAll(g);
    g = act(g, "p1", { type: "tapForMana", cardId: swamp });
    expect(g.players.p1!.manaPool.B).toBe(2);
    g = act(g, "p1", { type: "passTurn" });
    expect(g.manaBonuses).toBeUndefined();
  });

  it("Well of Lost Dreams : payer X (au plus les PV gagnés) pour piocher X cartes", () => {
    let g = toMain(newTestGame(2));
    let well: string, knight: string;
    [g, well] = put(g, "p1", real("Well of Lost Dreams"));
    void well;
    [g, knight] = inHand(g, "p1", fakeCard("Soin", { typeLine: "Sorcery", oracleText: "You gain 3 life.", manaCost: "{B}" }));
    g = mana(g, "p1", "BBBB");
    g = act(g, "p1", { type: "castSpell", cardId: knight });
    g = resolveAll(g);
    const decide = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.awaitingDecision)!;
    expect(decide).toBeDefined();
    expect(refuse(g, "p1", { type: "decideOptional", cardId: decide.instanceId, accept: true, x: 4 })).toMatch(/entre 0 et 3/);
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "decideOptional", cardId: decide.instanceId, accept: true, x: 2 });
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 2);
    expect(g.players.p1!.manaPool.B).toBe(1);
  });

  it("les cartes sont reconnues en entier", () => {
    for (const name of ["Bubbling Muck", "Well of Lost Dreams"]) expect(cardSupport(real(name)).level, name).toBe("full");
  });
});

describe("Modes", () => {
  it("Black Market Connections : au début de la première phase principale, choisir un ou plusieurs modes", () => {
    let g = newTestGame(2);
    [g] = put(g, "p1", real("Black Market Connections"));
    g = act(g, "p1", { type: "nextStep", to: "main1" });
    const ability = g.stack.map((id) => g.cards[id]!).find((c) => c.ability);
    expect(ability).toBeDefined();
    g = resolveAll(g);
    expect(g.cards[ability!.instanceId]!.modes).toEqual({});
    expect(refuse(g, "p1", { type: "chooseModes", cardId: ability!.instanceId, modes: [] })).toMatch(/Choisis entre 1 et 3/);
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "chooseModes", cardId: ability!.instanceId, modes: [0, 1] });
    g = resolveAll(g);
    const treasure = g.players.p1!.zones.battlefield.map((id) => g.cards[id]!).find((c) => g.cardData[c.cardId]!.name === "Treasure");
    expect(treasure).toBeDefined();
    expect(g.players.p1!.zones.hand.length).toBe(hand + 1);
    expect(g.players.p1!.life).toBe(37);
    // Le Trésor se sacrifie pour un mana de la couleur choisie.
    g = act(g, "p1", { type: "activateAbility", cardId: treasure!.instanceId, index: 0, color: "R" });
    expect(g.players.p1!.manaPool.R).toBe(1);
    expect(g.cards[treasure!.instanceId]).toBeUndefined();
  });

  it("le bot choisit un mode", () => {
    let g = newTestGame(2);
    [g] = put(g, "p1", real("Black Market Connections"));
    g = act(g, "p1", { type: "nextStep", to: "main1" });
    g = resolveAll(g);
    const action = chooseBotAction(g, "p1");
    expect(action).toMatchObject({ type: "chooseModes", modes: [0] });
  });

  it("une carte modale est reconnue en entier", () => {
    expect(cardSupport(real("Black Market Connections")).level).toBe("full");
  });
});

describe("Fenêtre de choix : cimetière, bibliothèque, main révélée, saga", () => {
  it("Gixian Puppeteer : en mourant, ramène une autre créature de valeur de mana 3 ou moins", () => {
    let g = toMain(newTestGame(2));
    let puppeteer: string, small: string, big: string;
    [g, puppeteer] = put(g, "p1", real("Gixian Puppeteer", { manaValue: 4 }));
    [g, small] = put(g, "p1", fakeCard("Petit", { typeLine: "Creature — Bear", power: "2", toughness: "2", manaValue: 2 }));
    [g, big] = put(g, "p1", fakeCard("Gros", { typeLine: "Creature — Giant", power: "5", toughness: "5", manaValue: 5 }));
    g = act(g, "p1", { type: "moveCard", cardId: small, to: "graveyard" });
    g = act(g, "p1", { type: "moveCard", cardId: big, to: "graveyard" });
    g = act(g, "p1", { type: "moveCard", cardId: puppeteer, to: "graveyard" });
    // Une seule cible possible (le Puppeteer lui-même est exclu) : choisie d'office.
    const ability = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.sourceName === "Gixian Puppeteer")!;
    expect(ability.targets).toEqual([{ kind: "card", id: small }]);
    g = resolveAll(g);
    expect(g.cards[small]!.zone).toBe("battlefield");
    expect(g.cards[big]!.zone).toBe("graveyard");
  });

  it("Expedition Map : on choisit un terrain dans sa bibliothèque", () => {
    let g = toMain(newTestGame(2));
    let map: string;
    [g, map] = put(g, "p1", real("Expedition Map"));
    g = structuredClone(g);
    const landId = g.players.p1!.zones.library[5]!;
    g.cardData[g.cards[landId]!.cardId] = fakeCard("Swamp", { id: g.cards[landId]!.cardId, typeLine: "Basic Land — Swamp" });
    g = mana(g, "p1", "CC");
    g = act(g, "p1", { type: "activateAbility", cardId: map, index: 0 });
    g = resolveAll(g);
    const ability = g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice)!;
    expect(ability.cardChoice!.options).toEqual([landId]);
    expect(refuse(g, g.priority!.playerId, { type: "passPriority" })).toMatch(/choisir une carte/);
    g = act(g, "p1", { type: "chooseCards", cardId: ability.instanceId, cardIds: [landId] });
    const inHand = g.players.p1!.zones.hand.map((id) => g.cardData[g.cards[id]!.cardId]!.name);
    expect(inHand).toContain("Swamp");
    expect(g.stack).toHaveLength(0);
  });

  it("The Cruelty of Gix : lecture anticipée au chapitre III, puis sacrifiée", () => {
    let g = toMain(newTestGame(2));
    let saga: string, dead: string;
    [g, dead] = put(g, "p2", fakeCard("Mort", { typeLine: "Creature — Zombie", power: "3", toughness: "3" }));
    g = act(g, "p2", { type: "moveCard", cardId: dead, to: "graveyard" });
    [g, saga] = inHand(g, "p1", real("The Cruelty of Gix", { manaCost: "{2}{B}" }));
    g = mana(g, "p1", "BBB");
    expect(refuse(g, "p1", { type: "castSpell", cardId: saga, chapter: 4 })).toMatch(/entre 1 et 3/);
    g = act(g, "p1", { type: "castSpell", cardId: saga, chapter: 3 });
    g = resolveAll(g);
    expect(g.cards[dead]!.zone).toBe("battlefield");
    expect(g.cards[dead]!.controllerId).toBe("p1");
    expect(g.cards[saga]!.zone).toBe("graveyard");
  });

  it("The Cruelty of Gix : chapitre I, la main révélée et la défausse choisie, puis le II au tour suivant", () => {
    let g = toMain(newTestGame(2));
    let saga: string;
    [g, saga] = inHand(g, "p1", real("The Cruelty of Gix", { manaCost: "{2}{B}" }));
    g = structuredClone(g);
    const victim = g.players.p2!.zones.hand[0]!;
    g.cardData[g.cards[victim]!.cardId] = fakeCard("Cible", { id: g.cards[victim]!.cardId, typeLine: "Creature — Elf" });
    g = mana(g, "p1", "BBB");
    g = act(g, "p1", { type: "castSpell", cardId: saga });
    g = resolveAll(g);
    expect(g.cards[saga]!.counters["savoir"]).toBe(1);
    const ability = g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice)!;
    expect(ability.cardChoice!.options).toEqual([victim]);
    expect(g.cards[victim]!.revealedTo).toContain("p1");
    g = act(g, "p1", { type: "chooseCards", cardId: ability.instanceId, cardIds: [victim] });
    expect(g.cards[victim]!.zone).toBe("graveyard");
    // Tour suivant de p1 : chapitre II (recherche, 3 PV).
    g = act(g, "p1", { type: "passTurn" });
    g = act(g, "p2", { type: "passTurn" });
    g = resolveAll(g);
    if (g.turn.step !== "main1") g = act(g, "p1", { type: "nextStep", to: "main1" });
    g = resolveAll(g);
    expect(g.cards[saga]!.counters["savoir"]).toBe(2);
    const search = g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice)!;
    expect(search.cardChoice!.options.length).toBeGreaterThan(10);
    g = act(g, "p1", { type: "chooseCards", cardId: search.instanceId, cardIds: [search.cardChoice!.options[3]!] });
    expect(g.players.p1!.life).toBe(37);
  });

  it("les cartes sont reconnues en entier", () => {
    for (const name of ["Gixian Puppeteer", "Expedition Map", "The Cruelty of Gix"]) expect(cardSupport(real(name)).level, name).toBe("full");
  });
});

describe("Blessures de combat", () => {
  it("Gix : une créature qui blesse un adversaire permet de payer 1 PV pour piocher", () => {
    let g = newTestGame(2);
    let attacker: string;
    [g] = put(g, "p1", real("Gix, Yawgmoth Praetor"));
    [g, attacker] = put(g, "p1", bear("Ours"), 1);
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: attacker, defender: "p2" }] });
    for (let i = 0; i < 6 && !g.stack.length; i++) {
      if (g.turn.step === "combatDamage" || g.turn.step === "endCombat") break;
      g = act(g, g.priority?.playerId ?? "p1", g.priority ? { type: "passPriority" } : { type: "nextStep" });
    }
    if (!g.stack.length) g = act(g, "p1", { type: "nextStep", to: "combatDamage" });
    g = resolveAll(g);
    const decide = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.awaitingDecision);
    expect(decide).toBeDefined();
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "decideOptional", cardId: decide!.instanceId, accept: true });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(38);
    expect(g.players.p1!.life).toBe(39);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 1);
  });
});

describe("Deck Sheoldred", () => {
  it("la plupart des cartes sont gérées en entier", () => {
    const levels = (deck as OracleCard[]).map((c) => cardSupport(fakeCard(c.name, { typeLine: c.typeLine, oracleText: c.oracleText ?? "" })).level);
    const full = levels.filter((l) => l === "full").length;
    expect(full).toBeGreaterThanOrEqual(63);
  });
});
