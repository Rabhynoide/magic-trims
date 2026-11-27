import { describe, expect, it } from "vitest";
import { applyAction } from "../src/reducer.js";
import type { GameAction } from "../src/actions.js";
import { parseManaCost, payFromPool, emptyPool } from "../src/mana.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame, endTurn } from "./helpers.js";

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

/** Donne les données de `card` à la n-ième carte de la main du joueur. */
function inHand(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  const cardId = g.cards[id]!.cardId;
  g.cardData[cardId] = { ...card, id: cardId };
  return [g, id];
}

function onBattlefield(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  let id: string;
  [g, id] = inHand(g, playerId, card, n);
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  return [g, id];
}

const forest = fakeCard("Forest", { typeLine: "Basic Land — Forest", oracleText: "({T}: Add {G}.)", manaCost: "" });
const mountain = fakeCard("Mountain", { typeLine: "Basic Land — Mountain", oracleText: "({T}: Add {R}.)", manaCost: "" });
const solRing = fakeCard("Sol Ring", { typeLine: "Artifact", oracleText: "{T}: Add {C}{C}.", manaCost: "{1}" });
const bear = fakeCard("Grizzly Bears", { typeLine: "Creature — Bear", manaCost: "{1}{G}" });
const bolt = fakeCard("Lightning Bolt", { typeLine: "Instant", manaCost: "{R}" });
const fireball = fakeCard("Fireball", { typeLine: "Sorcery", manaCost: "{X}{R}" });

function mainPhase(): GameState {
  return act(newTestGame(3), "p1", { type: "nextStep", to: "main1" });
}

describe("Coûts de mana", () => {
  it("lit les coûts et paie avec la réserve", () => {
    expect(parseManaCost("{2}{G}{G}")).toEqual([
      { kind: "generic", amount: 2 },
      { kind: "color", mana: "G" },
      { kind: "color", mana: "G" },
    ]);
    expect(parseManaCost("{G/W}{U/P}{2/B}{X}")).toEqual([
      { kind: "hybrid", options: ["G", "W"] },
      { kind: "phyrexian", mana: "U" },
      { kind: "twoOrColor", mana: "B" },
      { kind: "x" },
    ]);
    const pool = { ...emptyPool(), G: 2, C: 1 };
    const paid = payFromPool(pool, parseManaCost("{1}{G}"));
    expect(paid).toMatchObject({ ok: true, spent: ["G", "C"], pool: { G: 1, C: 0 } });
    expect(payFromPool(pool, parseManaCost("{R}"))).toEqual({ ok: false, need: { kind: "color", options: ["R"] } });
    expect(payFromPool(pool, parseManaCost("{3}{G}"))).toEqual({ ok: false, need: { kind: "any" } });
    expect(payFromPool(emptyPool(), parseManaCost("{G/P}"))).toMatchObject({ ok: true, life: 2 });
  });
});

describe("Jouer un terrain", () => {
  it("un terrain par tour, pendant sa phase principale", () => {
    let g = newTestGame(3);
    let a: string, b: string;
    [g, a] = inHand(g, "p1", forest, 0);
    [g, b] = inHand(g, "p1", forest, 1);
    expect(refuse(g, "p1", { type: "playLand", cardId: a })).toMatch(/phase principale/);
    g = act(g, "p1", { type: "nextStep", to: "main1" });
    g = act(g, "p1", { type: "playLand", cardId: a });
    expect(g.players.p1!.zones.battlefield).toContain(a);
    expect(refuse(g, "p1", { type: "playLand", cardId: b })).toMatch(/déjà joué un terrain/);
    g = endTurn(g, "p1");
    g = endTurn(g, "p2");
    g = endTurn(g, "p3");
    g = act(g, "p1", { type: "nextStep", to: "main1" });
    g = act(g, "p1", { type: "playLand", cardId: b });
  });

  it("refuse un sort, ou le terrain d'un autre joueur", () => {
    let g = mainPhase();
    let id: string;
    [g, id] = inHand(g, "p1", bear);
    expect(refuse(g, "p1", { type: "playLand", cardId: id })).toMatch(/n'est pas un terrain/);
    expect(refuse(g, "p2", { type: "playLand", cardId: id })).toMatch(/ta main/);
  });
});

describe("Lancer un sort", () => {
  it("engage les terrains qu'il faut, paie et met le sort sur la pile", () => {
    let g = mainPhase();
    let f1: string, m1: string, bearId: string;
    [g, f1] = onBattlefield(g, "p1", forest, 0);
    [g, m1] = onBattlefield(g, "p1", mountain, 0);
    [g, bearId] = inHand(g, "p1", bear);
    g = act(g, "p1", { type: "castSpell", cardId: bearId });
    expect(g.stack).toEqual([bearId]);
    expect(g.cards[f1]!.tapped).toBe(true);
    expect(g.cards[m1]!.tapped).toBe(true);
    expect(g.players.p1!.manaPool).toEqual(emptyPool());
    expect(g.priority).toEqual({ playerId: "p1", passed: [] });
    expect(g.log.at(-1)!.message).toBe("Alice lance Grizzly Bears en payant {G}{R}.");
  });

  it("utilise d'abord la réserve et refuse quand le mana manque", () => {
    let g = mainPhase();
    let bearId: string;
    [g, bearId] = inHand(g, "p1", bear);
    expect(refuse(g, "p1", { type: "castSpell", cardId: bearId })).toMatch(/il manque \{G\}/);
    g = act(g, "p1", { type: "adjustMana", mana: "G", delta: 1 });
    expect(refuse(g, "p1", { type: "castSpell", cardId: bearId })).toMatch(/il manque du mana/);
    g = act(g, "p1", { type: "adjustMana", mana: "C", delta: 1 });
    g = act(g, "p1", { type: "castSpell", cardId: bearId });
    expect(g.stack).toEqual([bearId]);
  });

  it("préfère les sources incolores pour le générique et garde le reste dans la réserve", () => {
    let g = mainPhase();
    let ring: string, f1: string, bearId: string;
    [g, ring] = onBattlefield(g, "p1", solRing, 0);
    [g, f1] = onBattlefield(g, "p1", forest, 0);
    [g, bearId] = inHand(g, "p1", bear);
    g = act(g, "p1", { type: "castSpell", cardId: bearId });
    expect(g.cards[ring]!.tapped).toBe(true);
    expect(g.cards[f1]!.tapped).toBe(true);
    expect(g.players.p1!.manaPool.C).toBe(1);
  });

  it("respecte la vitesse : rituel pendant son tour, éphémère avec la priorité", () => {
    let g = mainPhase();
    let bearId: string, boltId: string;
    [g, bearId] = inHand(g, "p2", bear);
    g = act(g, "p2", { type: "adjustMana", mana: "G", delta: 2 });
    expect(refuse(g, "p2", { type: "castSpell", cardId: bearId })).toMatch(/pendant ton tour/);
    [g, boltId] = inHand(g, "p2", bolt, 1);
    g = act(g, "p2", { type: "adjustMana", mana: "R", delta: 1 });
    g = act(g, "p2", { type: "castSpell", cardId: boltId });
    expect(g.stack).toEqual([boltId]);
    // Sur la pile, c'est p2 qui a la priorité : p1 ne peut pas lancer de rituel.
    let p1Bear: string;
    [g, p1Bear] = inHand(g, "p1", bear);
    g = act(g, "p1", { type: "adjustMana", mana: "G", delta: 2 });
    expect(refuse(g, "p1", { type: "castSpell", cardId: p1Bear })).toMatch(/pile est vide/);
  });

  it("gère X et la taxe de commandant", () => {
    let g = mainPhase();
    let fb: string;
    [g, fb] = inHand(g, "p1", fireball);
    g = act(g, "p1", { type: "adjustMana", mana: "R", delta: 4 });
    g = act(g, "p1", { type: "castSpell", cardId: fb, x: 3 });
    expect(g.log.at(-1)!.message).toMatch(/Fireball \(X = 3\) en payant \{R\}\{R\}\{R\}\{R\}/);
    g = act(g, "p1", { type: "passPriority" });
    g = act(g, "p2", { type: "passPriority" });
    g = act(g, "p3", { type: "passPriority" });

    const commander = g.players.p1!.zones.command[0]!;
    g = act(g, "p1", { type: "adjustMana", mana: "G", delta: 1 });
    g = act(g, "p1", { type: "castSpell", cardId: commander });
    g = act(g, "p1", { type: "moveCard", cardId: commander, to: "command" });
    // Deuxième lancer : {1} + {2} de taxe.
    g = act(g, "p1", { type: "adjustMana", mana: "G", delta: 2 });
    expect(refuse(g, "p1", { type: "castSpell", cardId: commander })).toMatch(/il manque du mana/);
    g = act(g, "p1", { type: "adjustMana", mana: "G", delta: 1 });
    g = act(g, "p1", { type: "castSpell", cardId: commander });
    expect(g.log.at(-1)!.message).toMatch(/taxe de commandant \{2\}/);
  });

  it("lance la face choisie d'une carte scindée", () => {
    let g = mainPhase();
    const fireIce = fakeCard("Fire // Ice", {
      typeLine: "Instant // Instant",
      manaCost: "{1}{R} // {1}{U}",
      faces: [
        { name: "Fire", manaCost: "{1}{R}", typeLine: "Instant", oracleText: "" },
        { name: "Ice", manaCost: "{1}{U}", typeLine: "Instant", oracleText: "" },
      ],
    });
    let id: string;
    [g, id] = inHand(g, "p1", fireIce);
    g = act(g, "p1", { type: "adjustMana", mana: "U", delta: 2 });
    g = act(g, "p1", { type: "castSpell", cardId: id, face: 1 });
    expect(g.cards[id]!.faceIndex).toBe(1);
    expect(g.log.at(-1)!.message).toMatch(/lance Ice/);
  });
});

describe("Respect des règles pour jouer ses cartes", () => {
  it("refuse de poser une carte de sa main sans la jouer, sauf déplacement forcé", () => {
    let g = newTestGame(3);
    let id: string;
    [g, id] = inHand(g, "p1", forest);
    // Pendant l'entretien, glisser un terrain sur le champ de bataille est refusé.
    expect(refuse(g, "p1", { type: "moveCard", cardId: id, to: "battlefield" })).toMatch(/double-clic/);
    expect(refuse(g, "p1", { type: "moveCard", cardId: id, to: "stack" })).toMatch(/double-clic/);
    expect(refuse(g, "p1", { type: "playLand", cardId: id })).toMatch(/phase principale/);
    const commander = g.players.p1!.zones.command[0]!;
    expect(refuse(g, "p1", { type: "moveCard", cardId: commander, to: "stack" })).toMatch(/double-clic/);
    // Un effet (« mets un terrain de ta main sur le champ de bataille ») passe en forçant.
    g = act(g, "p1", { type: "moveCard", cardId: id, to: "battlefield", force: true });
    expect(g.players.p1!.zones.battlefield).toContain(id);
    // Les autres déplacements restent libres.
    g = act(g, "p1", { type: "moveCard", cardId: g.players.p1!.zones.hand[0]!, to: "graveyard" });
  });

  it("l'hôte peut désactiver cette vérification", () => {
    let g = newTestGame(3);
    g.settings.enforceRules = false;
    let id: string;
    [g, id] = inHand(g, "p1", forest);
    g = act(g, "p1", { type: "moveCard", cardId: id, to: "battlefield" });
    expect(g.players.p1!.zones.battlefield).toContain(id);
  });
});
