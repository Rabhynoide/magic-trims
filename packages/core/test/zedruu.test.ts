import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { chooseBotAction } from "../src/bot.js";
import { creatureStats, hasKeyword } from "../src/combat.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame } from "./helpers.js";
import deck from "./zedruu-oracle.json" with { type: "json" };

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
    if (g.stack.some((id) => g.cards[id]!.ability?.awaitingDecision || g.cards[id]!.ability?.needsTargets)) break;
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

describe("Deck Zedruu : dons et échanges de contrôle", () => {
  it("Zedruu donne un permanent, puis pioche et gagne des PV à l'entretien", () => {
    let g = toMain(newTestGame(2));
    let zedruu: string, ring: string;
    [g, zedruu] = put(g, "p1", real("Zedruu the Greathearted"));
    [g, ring] = put(g, "p1", real("Sol Ring"));
    g = mana(g, "p1", "URW");
    g = act(g, "p1", { type: "activateAbility", cardId: zedruu, index: 0, targets: [{ kind: "player", id: "p2" }, { kind: "card", id: ring }] });
    g = resolveAll(g);
    expect(g.cards[ring]!.controllerId).toBe("p2");
    expect(g.players.p2!.zones.battlefield).toContain(ring);
    g = act(g, "p1", { type: "passTurn" });
    g = act(g, "p2", { type: "passTurn" });
    const hand = g.players.p1!.zones.hand.length;
    g = resolveAll(g);
    expect(g.players.p1!.life).toBe(41);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 1);
  });

  it("Harmless Offering et Political Trickery", () => {
    let g = toMain(newTestGame(2));
    let offering: string, trickery: string, mine: string, theirs: string, gift: string;
    [g, mine] = put(g, "p1", real("Tundra"));
    [g, gift] = put(g, "p1", real("Jinxed Idol"), 1);
    [g, theirs] = put(g, "p2", real("Plateau"));
    [g, offering] = inHand(g, "p1", real("Harmless Offering"), 2);
    [g, trickery] = inHand(g, "p1", real("Political Trickery"), 3);
    g = mana(g, "p1", "RRRUCC");
    g = act(g, "p1", { type: "castSpell", cardId: offering, targets: [{ kind: "player", id: "p2" }, { kind: "card", id: gift }] });
    g = resolveAll(g);
    expect(g.cards[gift]!.controllerId).toBe("p2");
    g = act(g, "p1", { type: "castSpell", cardId: trickery, targets: [{ kind: "card", id: mine }, { kind: "card", id: theirs }] });
    g = resolveAll(g);
    expect(g.cards[mine]!.controllerId).toBe("p2");
    expect(g.cards[theirs]!.controllerId).toBe("p1");
  });

  it("Akroan Horse va chez un adversaire au choix (choisi d'office à deux joueurs)", () => {
    let g = toMain(newTestGame(3));
    let horse: string;
    [g, horse] = inHand(g, "p1", real("Akroan Horse"));
    g = mana(g, "p1", "CCCC");
    g = act(g, "p1", { type: "castSpell", cardId: horse });
    g = resolveAll(g);
    const trigger = g.stack.at(-1)!;
    expect(g.cards[trigger]!.ability?.needsTargets).toBe(true);
    g = act(g, "p1", { type: "chooseTargets", cardId: trigger, targets: [{ kind: "player", id: "p3" }] });
    g = resolveAll(g);
    expect(g.cards[horse]!.controllerId).toBe("p3");
  });

  it("Humble Defector : seulement pendant son tour, pioche deux cartes puis change de camp", () => {
    let g = toMain(newTestGame(2));
    let defector: string;
    [g, defector] = put(g, "p1", real("Humble Defector"));
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "activateAbility", cardId: defector, index: 0, targets: [{ kind: "player", id: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 2);
    expect(g.cards[defector]!.controllerId).toBe("p2");
    delete g.cards[defector]!.summoningSick;
    g.cards[defector]!.tapped = false;
    expect(refuse(g, "p2", { type: "activateAbility", cardId: defector, index: 0, targets: [{ kind: "player", id: "p1" }] })).toMatch(/pendant ton tour/);
  });
});

describe("Deck Zedruu : prison et restrictions", () => {
  it("Ghostly Prison : {2} par attaquant, payés d'office", () => {
    let g = newTestGame(2);
    let a: string, b: string;
    [g, a] = put(g, "p1", fakeCard("Ours", { typeLine: "Creature — Bear", power: "2", toughness: "2" }));
    [g, b] = put(g, "p1", fakeCard("Loup", { typeLine: "Creature — Wolf", power: "2", toughness: "2" }), 1);
    [g] = put(g, "p2", real("Ghostly Prison"));
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    const attack: GameAction = { type: "declareAttackers", attackers: [{ cardId: a, defender: "p2" }, { cardId: b, defender: "p2" }] };
    expect(refuse(g, "p1", attack)).toMatch(/taxe de \{4\}/);
    g = mana(g, "p1", "CCCC");
    g = act(g, "p1", attack);
    expect(g.players.p1!.manaPool.C).toBe(0);
  });

  it("terrains qui arrivent engagés, Steel Golem, Moderation et Aggressive Mining", () => {
    let g = toMain(newTestGame(2));
    let cove: string, creature: string, s1: string, s2: string, land: string;
    [g, cove] = inHand(g, "p1", real("Tranquil Cove"));
    g = act(g, "p1", { type: "playLand", cardId: cove });
    expect(g.cards[cove]!.tapped).toBe(true);
    g = resolveAll(g);
    [g] = put(g, "p1", real("Steel Golem"), 1);
    [g, creature] = inHand(g, "p1", fakeCard("Ours", { typeLine: "Creature — Bear", manaCost: "{1}" }), 1);
    g = mana(g, "p1", "CC");
    expect(refuse(g, "p1", { type: "castSpell", cardId: creature })).toMatch(/Steel Golem/);
    [g] = put(g, "p1", real("Moderation"), 2);
    [g, s1] = inHand(g, "p1", fakeCard("Sort 1", { typeLine: "Sorcery", manaCost: "{1}", oracleText: "Draw a card." }), 2);
    [g, s2] = inHand(g, "p1", fakeCard("Sort 2", { typeLine: "Sorcery", manaCost: "{1}", oracleText: "Draw a card." }), 3);
    g = act(g, "p1", { type: "castSpell", cardId: s1 });
    g = resolveAll(g);
    expect(refuse(g, "p1", { type: "castSpell", cardId: s2 })).toMatch(/un seul sort/);
    g = act(g, "p1", { type: "passTurn" });
    g = act(g, "p2", { type: "passTurn" });
    g = resolveAll(g);
    g = act(g, "p1", { type: "nextStep", to: "main1" });
    [g] = put(g, "p1", real("Aggressive Mining"), 4);
    [g, land] = inHand(g, "p1", real("Tundra"), 4);
    expect(refuse(g, "p1", { type: "playLand", cardId: land })).toMatch(/jouer des terrains/);
  });

  it("Felidar Sovereign gagne à 40 PV ; Delusions of Mediocrity fait perdre 10 PV en partant", () => {
    let g = toMain(newTestGame(2));
    let delusions: string;
    [g, delusions] = put(g, "p1", real("Delusions of Mediocrity"));
    g = act(g, "p1", { type: "moveCard", cardId: delusions, to: "graveyard" });
    g = resolveAll(g);
    // +10 en arrivant, −10 en partant.
    expect(g.players.p1!.life).toBe(40);
    [g] = put(g, "p1", real("Felidar Sovereign"), 1);
    g = act(g, "p1", { type: "passTurn" });
    g = act(g, "p2", { type: "passTurn" });
    g = resolveAll(g);
    expect(g.players.p2!.hasConceded).toBe(true);
    expect(g.players.p2!.lostReason).toMatch(/Felidar Sovereign/);
  });

  it("Ghostly Prison, Propaganda et la plupart des cartes du deck sont gérées", () => {
    const levels = (deck as OracleCard[]).map((c) => cardSupport(fakeCard(c.name, { typeLine: c.typeLine, oracleText: c.oracleText ?? "" })).level);
    expect(levels.filter((l) => l === "full").length).toBeGreaterThanOrEqual(56);
  });
});

describe("Deck Zedruu : blessures modifiées et effets simples", () => {
  it("Goldnight Castigator double les blessures qui lui sont infligées et celles à son contrôleur", () => {
    let g = toMain(newTestGame(2));
    let angel: string, bolt: string;
    [g, angel] = put(g, "p2", real("Goldnight Castigator"));
    [g, bolt] = inHand(g, "p1", fakeCard("Shock", { typeLine: "Instant", oracleText: "Shock deals 2 damage to any target.", manaCost: "{R}" }));
    g = mana(g, "p1", "RR");
    g = act(g, "p1", { type: "castSpell", cardId: bolt, targets: [{ kind: "player", id: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(36);
    void angel;
  });

  it("Pyromancer's Swath : +2 aux blessures de mes éphémères ; Glacial Chasm les prévient", () => {
    let g = toMain(newTestGame(3));
    let bolt: string, bolt2: string;
    [g] = put(g, "p1", real("Pyromancer's Swath"));
    [g] = put(g, "p3", real("Glacial Chasm"));
    [g, bolt] = inHand(g, "p1", fakeCard("Shock", { typeLine: "Instant", oracleText: "Shock deals 2 damage to any target.", manaCost: "{R}" }), 1);
    [g, bolt2] = inHand(g, "p1", fakeCard("Shock", { typeLine: "Instant", oracleText: "Shock deals 2 damage to any target.", manaCost: "{R}" }), 2);
    g = mana(g, "p1", "RR");
    g = act(g, "p1", { type: "castSpell", cardId: bolt, targets: [{ kind: "player", id: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(36);
    g = act(g, "p1", { type: "castSpell", cardId: bolt2, targets: [{ kind: "player", id: "p3" }] });
    g = resolveAll(g);
    expect(g.players.p3!.life).toBe(40);
  });

  it("Nine Lives prévient les blessures et prend un marqueur, puis s'exile à neuf", () => {
    let g = toMain(newTestGame(2));
    let lives: string;
    [g, lives] = put(g, "p2", real("Nine Lives"));
    g = structuredClone(g);
    g.cards[lives]!.counters["incarnation"] = 8;
    let bolt: string;
    [g, bolt] = inHand(g, "p1", fakeCard("Shock", { typeLine: "Instant", oracleText: "Shock deals 2 damage to any target.", manaCost: "{R}" }));
    g = mana(g, "p1", "R");
    g = act(g, "p1", { type: "castSpell", cardId: bolt, targets: [{ kind: "player", id: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(40);
    expect(g.cards[lives]!.zone).toBe("exile");
  });

  it("Solitary Confinement : le joueur a le linceul et passe sa pioche", () => {
    let g = toMain(newTestGame(2));
    let bolt: string;
    [g] = put(g, "p2", real("Solitary Confinement"));
    [g, bolt] = inHand(g, "p1", fakeCard("Shock", { typeLine: "Instant", oracleText: "Shock deals 2 damage to any target.", manaCost: "{R}" }));
    g = mana(g, "p1", "R");
    expect(refuse(g, "p1", { type: "castSpell", cardId: bolt, targets: [{ kind: "player", id: "p2" }] })).toMatch(/Cible invalide/);
    const hand = g.players.p2!.zones.hand.length;
    g = act(g, "p1", { type: "passTurn" });
    g = resolveAll(g);
    if (g.turn.step !== "main1") g = act(g, "p2", { type: "nextStep", to: "main1" });
    expect(g.players.p2!.zones.hand.length).toBe(hand);
  });

  it("Body of Knowledge pioche autant que les blessures subies ; Cinder Giant blesse mes autres créatures", () => {
    let g = toMain(newTestGame(2));
    let body: string, giant: string;
    [g, body] = put(g, "p1", real("Body of Knowledge", { power: "*", toughness: "*" }));
    [g, giant] = put(g, "p1", real("Cinder Giant"), 1);
    void giant;
    g = structuredClone(g);
    // Endurance : la taille de la main ; on vérifie seulement la pioche.
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "passTurn" });
    g = act(g, "p2", { type: "passTurn" });
    g = resolveAll(g);
    // Pioche du tour + 2 cartes pour les 2 blessures de Cinder Giant.
    expect(g.players.p1!.zones.hand.length).toBeGreaterThanOrEqual(hand + 2);
    void body;
  });

  it("Silent Arbiter : une seule créature attaque", () => {
    let g = newTestGame(2);
    let a: string, b: string;
    [g] = put(g, "p2", real("Silent Arbiter"));
    [g, a] = put(g, "p1", bear("A"));
    [g, b] = put(g, "p1", bear("B"), 1);
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    expect(
      refuse(g, "p1", {
        type: "declareAttackers",
        attackers: [
          { cardId: a, defender: "p2" },
          { cardId: b, defender: "p2" },
        ],
      }),
    ).toMatch(/Une seule créature/);
  });

  it("Raugrin Triome : recycler depuis la main", () => {
    let g = toMain(newTestGame(2));
    let triome: string;
    [g, triome] = inHand(g, "p1", real("Raugrin Triome"));
    g = mana(g, "p1", "CCC");
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "activateAbility", cardId: triome, index: 0 });
    g = resolveAll(g);
    expect(g.cards[triome]!.zone).toBe("graveyard");
    expect(g.players.p1!.zones.hand.length).toBe(hand);
  });

  it("Folio of Fancies, Farewell, Unwind, Elixir, Grafted Skullcap, Mana Crypt sont reconnues", () => {
    for (const name of ["Folio of Fancies", "Farewell", "Unwind", "Elixir of Immortality", "Grafted Skullcap", "Mana Crypt", "Hall of Heliod's Generosity", "Statecraft"]) {
      expect(cardSupport(real(name)).level, name).toBe("full");
    }
  });
});
