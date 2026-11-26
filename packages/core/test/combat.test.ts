import { describe, expect, it } from "vitest";
import { applyAction } from "../src/reducer.js";
import type { GameAction } from "../src/actions.js";
import { createGame } from "../src/setup.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, fakeDeck, newTestGame } from "./helpers.js";

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

/** Met une créature sur le champ de bataille du joueur, déjà prête à attaquer. */
function creature(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  const cardId = g.cards[id]!.cardId;
  g.cardData[cardId] = { ...card, id: cardId };
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  delete g.cards[id]!.summoningSick;
  return [g, id];
}

const bear = (name = "Bear", extra: Partial<CardData> = {}) =>
  fakeCard(name, { typeLine: "Creature — Bear", power: "2", toughness: "2", ...extra });

function toAttackers(g: GameState, playerId = "p1"): GameState {
  return act(g, playerId, { type: "nextStep", to: "declareAttackers" });
}

describe("Combat", () => {
  it("une créature non bloquée blesse le joueur attaqué", () => {
    let g = newTestGame(3);
    let a: string;
    [g, a] = creature(g, "p1", bear());
    g = toAttackers(g);
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p2" }] });
    expect(g.cards[a]!.tapped).toBe(true);
    // Bruno n'a pas de créature : rien à déclarer, on va directement aux blessures.
    g = act(g, "p1", { type: "nextStep", to: "combatDamage" });
    expect(g.players.p2!.life).toBe(38);
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    expect(g.combat).toBeNull();
  });

  it("attend les bloqueurs, et une créature bloquée meurt", () => {
    let g = newTestGame(3);
    let a: string, b: string;
    [g, a] = creature(g, "p1", bear("Attaquant"));
    [g, b] = creature(g, "p2", bear("Défenseur", { power: "3", toughness: "3" }));
    g = toAttackers(g);
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p2" }] });
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    // Arrêt à l'étape des bloqueurs.
    expect(g.turn.step).toBe("declareBlockers");
    expect(g.log.at(-1)!.message).toMatch(/En attente des bloqueurs de Bruno/);
    expect(refuse(g, "p1", { type: "nextStep" })).toMatch(/En attente des bloqueurs/);
    expect(refuse(g, "p3", { type: "declareBlockers", blocks: [] })).toMatch(/pas de bloqueurs/);
    g = act(g, "p2", { type: "declareBlockers", blocks: [{ cardId: b, attackerId: a }] });
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    expect(g.players.p1!.zones.graveyard).toContain(a);
    expect(g.cards[b]!.damage).toBe(2);
    expect(g.players.p2!.life).toBe(40);
    // Les blessures disparaissent au nettoyage.
    g = act(g, "p1", { type: "passTurn" });
    expect(g.cards[b]!.damage).toBeUndefined();
  });

  it("refuse les attaquants malades, engagés, ou contre son camp", () => {
    let g = newTestGame(3);
    let a: string;
    [g, a] = creature(g, "p1", bear());
    g.cards[a]!.summoningSick = true;
    g = toAttackers(g);
    expect(refuse(g, "p1", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p2" }] })).toMatch(/mal d'invocation/);
    g.cards[a]!.summoningSick = false;
    expect(refuse(g, "p1", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p1" }] })).toMatch(/propre camp/);
    expect(refuse(g, "p2", { type: "declareAttackers", attackers: [] })).toMatch(/pas ton tour/);
  });

  it("la célérité permet d'attaquer tout de suite ; la vigilance n'engage pas", () => {
    let g = newTestGame(3);
    let a: string;
    [g, a] = creature(g, "p1", bear("Rapide", { keywords: ["Haste", "Vigilance"] }));
    g.cards[a]!.summoningSick = true;
    g = toAttackers(g);
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p2" }] });
    expect(g.cards[a]!.tapped).toBe(false);
  });

  it("vol et portée", () => {
    let g = newTestGame(3);
    let a: string, b: string, c: string;
    [g, a] = creature(g, "p1", bear("Oiseau", { keywords: ["Flying"] }));
    [g, b] = creature(g, "p2", bear("Ours"));
    [g, c] = creature(g, "p2", bear("Araignée", { keywords: ["Reach"] }), 1);
    g = toAttackers(g);
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p2" }] });
    g = act(g, "p1", { type: "nextStep" });
    expect(refuse(g, "p2", { type: "declareBlockers", blocks: [{ cardId: b, attackerId: a }] })).toMatch(/vole/);
    g = act(g, "p2", { type: "declareBlockers", blocks: [{ cardId: c, attackerId: a }] });
  });

  it("menace, piétinement, contact mortel et lien de vie", () => {
    let g = newTestGame(3);
    let a: string, b1: string, b2: string;
    [g, a] = creature(g, "p1", bear("Brute", { power: "5", toughness: "5", keywords: ["Menace", "Trample", "Lifelink"] }));
    [g, b1] = creature(g, "p2", bear("Ours A"));
    [g, b2] = creature(g, "p2", bear("Ours B", { power: "1", toughness: "1", keywords: ["Deathtouch"] }), 1);
    g = toAttackers(g);
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p2" }] });
    g = act(g, "p1", { type: "nextStep" });
    expect(refuse(g, "p2", { type: "declareBlockers", blocks: [{ cardId: b1, attackerId: a }] })).toMatch(/menace/);
    g = act(g, "p2", {
      type: "declareBlockers",
      blocks: [
        { cardId: b1, attackerId: a },
        { cardId: b2, attackerId: a },
      ],
    });
    g = act(g, "p1", { type: "nextStep", to: "combatDamage" });
    // 2 pour l'ours A, 1 pour l'ours B, 2 piétinent sur Bruno ; la brute meurt du contact mortel.
    expect(g.players.p2!.life).toBe(38);
    expect(g.players.p1!.life).toBe(45);
    expect(g.players.p2!.zones.graveyard).toEqual(expect.arrayContaining([b1, b2]));
    expect(g.players.p1!.zones.graveyard).toContain(a);
  });

  it("initiative : la créature tuée d'abord ne riposte pas", () => {
    let g = newTestGame(3);
    let a: string, b: string;
    [g, a] = creature(g, "p1", bear("Chevalier", { keywords: ["First strike"] }));
    [g, b] = creature(g, "p2", bear("Ours"));
    g = toAttackers(g);
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p2" }] });
    g = act(g, "p1", { type: "nextStep" });
    g = act(g, "p2", { type: "declareBlockers", blocks: [{ cardId: b, attackerId: a }] });
    g = act(g, "p1", { type: "nextStep" });
    expect(g.players.p2!.zones.graveyard).toContain(b);
    expect(g.cards[a]!.zone).toBe("battlefield");
    expect(g.cards[a]!.damage).toBeUndefined();
  });

  it("blessures de commandant et infection", () => {
    let g = newTestGame(3);
    const commander = g.players.p1!.zones.command[0]!;
    g = structuredClone(g);
    g.cardData[g.cards[commander]!.cardId] = {
      ...g.cardData[g.cards[commander]!.cardId]!,
      power: "4",
      toughness: "4",
    };
    g = act(g, "p1", { type: "moveCard", cardId: commander, to: "battlefield", force: true });
    delete g.cards[commander]!.summoningSick;
    let toxic: string;
    [g, toxic] = creature(g, "p1", bear("Toxique", { keywords: ["Infect"] }));
    g = toAttackers(g);
    g = act(g, "p1", {
      type: "declareAttackers",
      attackers: [
        { cardId: commander, defender: "p2" },
        { cardId: toxic, defender: "p3" },
      ],
    });
    g = act(g, "p1", { type: "nextStep", to: "combatDamage" });
    expect(g.players.p2!.commanderDamage[commander]).toBe(4);
    expect(g.players.p2!.life).toBe(36);
    expect(g.players.p3!.poison).toBe(2);
    expect(g.players.p3!.life).toBe(40);
  });

  it("bonus jusqu'à la fin du tour", () => {
    let g = newTestGame(3);
    let a: string;
    [g, a] = creature(g, "p1", bear());
    g = act(g, "p1", { type: "boostCreature", cardId: a, power: 3, toughness: 3 });
    g = toAttackers(g);
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p2" }] });
    g = act(g, "p1", { type: "nextStep", to: "main2" });
    expect(g.players.p2!.life).toBe(35);
    g = act(g, "p1", { type: "passTurn" });
    expect(g.cards[a]!.ptBoost).toBeUndefined();
  });

  it("Géant à deux têtes : l'un ou l'autre coéquipier peut bloquer", () => {
    const names = ["Alice", "Bruno", "Chloé", "David"];
    let g = createGame({
      id: "t",
      seed: 1,
      mode: "twoHeadedGiant",
      randomTurnOrder: false,
      players: names.map((name, i) => ({ id: `p${i + 1}`, name, deck: fakeDeck(name) })),
    });
    const [a1] = g.teams[0]!;
    const [d1, d2] = g.teams[1]!;
    let att: string, blk: string;
    [g, att] = creature(g, a1!, bear("Attaquant"));
    [g, blk] = creature(g, d2!, bear("Bloqueur"));
    g = act(g, a1!, { type: "nextStep", to: "declareAttackers" });
    g = act(g, a1!, { type: "declareAttackers", attackers: [{ cardId: att, defender: d1! }] });
    g = act(g, a1!, { type: "nextStep" });
    g = act(g, d2!, { type: "declareBlockers", blocks: [{ cardId: blk, attackerId: att }] });
    g = act(g, a1!, { type: "nextStep" });
    expect(g.cards[att]!.zone).toBe("graveyard");
  });
});
