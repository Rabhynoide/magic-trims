import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport, parseSpellEffects, type Target } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { fakeCard, newTestGame } from "./helpers.js";

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

const spell = (name: string, oracleText: string, typeLine = "Instant") => fakeCard(name, { typeLine, oracleText, manaCost: "" });
const bear = (name = "Bear", extra: Partial<CardData> = {}) =>
  fakeCard(name, { typeLine: "Creature — Bear", power: "2", toughness: "2", ...extra });

/** Donne les données `card` à la n-ième carte de la main du joueur. */
function inHand(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  return [g, id];
}

function onBattlefield(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  let id: string;
  [g, id] = inHand(g, playerId, card, n);
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  return [g, id];
}

/** Tout le monde passe : le dessus de la pile se résout. */
function resolve(g: GameState): GameState {
  while (g.priority && g.stack.length > 0) {
    const before = g.stack.length;
    g = act(g, g.priority.playerId, { type: "passPriority" });
    if (g.stack.length < before) break;
  }
  return g;
}

function start(players = 3): GameState {
  const g = newTestGame(players);
  return act(g, "p1", { type: "nextStep", to: "main1" });
}

const card = (id: string): Target => ({ kind: "card", id });
const player = (id: string): Target => ({ kind: "player", id });

describe("Lecture des effets", () => {
  it("reconnaît les formules courantes", () => {
    const parse = (text: string, name = "Spell") => parseSpellEffects(text, name);
    expect(parse("Destroy target nonartifact creature.")).toMatchObject({
      targets: [{ label: "créature non-artefact" }],
      effects: [{ type: "destroy", target: 0 }],
      unknown: [],
    });
    expect(parse("You draw two cards and you lose 2 life.").effects).toEqual([
      { type: "draw", who: "you", count: 2 },
      { type: "life", who: "you", amount: -2 },
    ]);
    expect(parse("Target player draws X cards and loses X life.").effects).toEqual([
      { type: "draw", who: { target: 0 }, count: "X" },
      { type: "life", who: { target: 0 }, amount: "-X" },
    ]);
    expect(parse("Add {B}{B}{B}.").effects).toEqual([{ type: "mana", mana: ["B", "B", "B"] }]);
    expect(parse("Scry 2, then draw two cards. You lose 2 life.")).toMatchObject({
      effects: [{ type: "draw" }, { type: "life" }],
      unknown: ["Scry 2"],
    });
    expect(parse("Lightning Bolt deals 3 damage to any target.", "Lightning Bolt")).toMatchObject({
      targets: [{ label: "n'importe quelle cible", player: true }],
      effects: [{ type: "damage", amount: 3 }],
    });
    expect(parse("Destroy all creatures. They can't be regenerated.")).toMatchObject({
      effects: [{ type: "destroyAll" }],
      unknown: [],
    });
    expect(parse("Create two 1/1 white Soldier creature tokens.").effects).toEqual([
      {
        type: "token",
        count: 2,
        tapped: false,
        token: { power: "1", toughness: "1", colors: ["W"], subtypes: ["Soldier"], keywords: [], artifact: false },
      },
    ]);
    expect(parse("Destroy target creature or enchantment an opponent controls. You lose life equal to that permanent's mana value.")).toMatchObject({
      targets: [{ permanent: { types: ["creature", "enchantment"], controller: "notYou" } }],
      unknown: ["You lose life equal to that permanent's mana value."],
    });
    expect(parse("Destroy target creature with total power and toughness 5 or less.").effects).toEqual([]);
  });

  it("dit ce que le moteur gère de chaque carte", () => {
    expect(cardSupport(bear())).toEqual({ level: "full", unknown: [] });
    expect(cardSupport(fakeCard("Sol Ring", { oracleText: "{T}: Add {C}{C}." })).level).toBe("full");
    expect(cardSupport(spell("Go for the Throat", "Destroy target nonartifact creature.")).level).toBe("full");
    const sheoldred = cardSupport(
      bear("Sheoldred", {
        oracleText: "Deathtouch\nWhenever you draw a card, you gain 2 life.\nWhenever an opponent draws a card, they lose 2 life.",
      }),
    );
    expect(sheoldred.level).toBe("partial");
    expect(sheoldred.unknown).toHaveLength(2);
    expect(cardSupport(spell("Village Rites", "As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.")).level).toBe(
      "partial",
    );
    expect(cardSupport(spell("Bubbling Muck", "Until end of turn, whenever a player taps a Swamp for mana, that player adds an additional {B}.")).level).toBe(
      "manual",
    );
  });
});

describe("Effets des sorts", () => {
  const bolt = spell("Lightning Bolt", "Lightning Bolt deals 3 damage to any target.");

  it("demande les cibles, puis inflige les blessures à la résolution", () => {
    let g = start();
    let target: string, bolted: string;
    [g, target] = onBattlefield(g, "p2", bear());
    [g, bolted] = inHand(g, "p1", bolt);
    expect(refuse(g, "p1", { type: "castSpell", cardId: bolted })).toMatch(/Choisis une cible \(n'importe quelle cible\)/);
    const own = g.players.p1!.zones.library[0]!;
    expect(refuse(g, "p1", { type: "castSpell", cardId: bolted, targets: [card(own)] })).toMatch(/Cible invalide/);
    g = act(g, "p1", { type: "castSpell", cardId: bolted, targets: [card(target)] });
    expect(g.log.at(-1)!.message).toMatch(/lance Lightning Bolt sur Bear/);
    g = resolve(g);
    expect(g.cards[target]!.zone).toBe("graveyard");
    expect(g.cards[bolted]!.zone).toBe("graveyard");

    [g, bolted] = inHand(g, "p1", bolt);
    g = resolve(act(g, "p1", { type: "castSpell", cardId: bolted, targets: [player("p3")] }));
    expect(g.players.p3!.life).toBe(37);
  });

  it("ne fait rien si sa cible a disparu", () => {
    let g = start();
    let target: string, bolted: string;
    [g, target] = onBattlefield(g, "p2", bear());
    [g, bolted] = inHand(g, "p1", bolt);
    g = act(g, "p1", { type: "castSpell", cardId: bolted, targets: [card(target)] });
    g = act(g, "p2", { type: "moveCard", cardId: target, to: "hand" });
    g = resolve(g);
    expect(g.log.map((l) => l.message)).toContain("Lightning Bolt n'a plus de cible valide : il ne fait rien.");
  });

  it("refuse une cible avec la défense talismanique d'un adversaire", () => {
    let g = start();
    let target: string, killer: string;
    [g, target] = onBattlefield(g, "p2", bear("Troll", { keywords: ["Hexproof"] }));
    [g, killer] = inHand(g, "p1", spell("Murder", "Destroy target creature."));
    expect(refuse(g, "p1", { type: "castSpell", cardId: killer, targets: [card(target)] })).toMatch(/Cible invalide/);
  });

  it("pioche et perte de vie, mana, jetons", () => {
    let g = start();
    let id: string;
    [g, id] = inHand(g, "p1", spell("Night's Whisper", "You draw two cards and you lose 2 life.", "Sorcery"));
    const hand = g.players.p1!.zones.hand.length;
    g = resolve(act(g, "p1", { type: "castSpell", cardId: id }));
    expect(g.players.p1!.zones.hand.length).toBe(hand + 1);
    expect(g.players.p1!.life).toBe(38);

    [g, id] = inHand(g, "p1", { ...spell("Damnable Pact", "Target player draws X cards and loses X life.", "Sorcery"), manaCost: "{X}" });
    g = act(g, "p1", { type: "adjustMana", mana: "C", delta: 3 });
    g = resolve(act(g, "p1", { type: "castSpell", cardId: id, x: 3, targets: [player("p2")] }));
    expect(g.players.p2!.life).toBe(37);

    [g, id] = inHand(g, "p1", spell("Dark Ritual", "Add {B}{B}{B}."));
    g = resolve(act(g, "p1", { type: "castSpell", cardId: id }));
    expect(g.players.p1!.manaPool.B).toBe(3);

    [g, id] = inHand(g, "p1", spell("Raise the Alarm", "Create two 1/1 white Soldier creature tokens."));
    g = resolve(act(g, "p1", { type: "castSpell", cardId: id }));
    const tokens = g.players.p1!.zones.battlefield.map((t) => g.cards[t]!).filter((c) => c.isToken);
    expect(tokens).toHaveLength(2);
    expect(g.cardData[tokens[0]!.cardId]).toMatchObject({ name: "Soldier", power: "1", toughness: "1", colors: ["W"] });
  });

  it("contre un sort", () => {
    let g = start();
    let bear1: string, counter: string;
    [g, bear1] = inHand(g, "p1", { ...bear(), manaCost: "" });
    g = act(g, "p1", { type: "castSpell", cardId: bear1 });
    [g, counter] = inHand(g, "p2", spell("Counterspell", "Counter target spell."));
    g = act(g, "p1", { type: "passPriority" });
    g = act(g, "p2", { type: "castSpell", cardId: counter, targets: [card(bear1)] });
    g = resolve(g);
    expect(g.cards[bear1]!.zone).toBe("graveyard");
    expect(g.stack).toEqual([]);
  });

  it("détruit tout, sauf les indestructibles, et signale ce qui reste à faire", () => {
    let g = start();
    let a: string, b: string, wrath: string;
    [g, a] = onBattlefield(g, "p2", bear());
    [g, b] = onBattlefield(g, "p3", bear("Darksteel", { keywords: ["Indestructible"] }));
    [g, wrath] = inHand(g, "p1", spell("Wrath", "Destroy all creatures. Scry 1.", "Sorcery"));
    g = resolve(act(g, "p1", { type: "castSpell", cardId: wrath }));
    expect(g.cards[a]!.zone).toBe("graveyard");
    expect(g.cards[b]!.zone).toBe("battlefield");
    expect(g.log.at(-1)!.message).toBe("À appliquer à la main pour Wrath : « Scry 1. »");
  });

  it("sans « faire respecter les règles », l'effet reste à appliquer à la main", () => {
    let g = start();
    g.settings.enforceRules = false;
    let target: string, bolted: string;
    [g, target] = onBattlefield(g, "p2", bear());
    [g, bolted] = inHand(g, "p1", bolt);
    g = resolve(act(g, "p1", { type: "castSpell", cardId: bolted }));
    expect(g.cards[target]!.zone).toBe("battlefield");
    expect(g.log.at(-1)!.message).toMatch(/appliquez son effet à la main/);
  });
});
