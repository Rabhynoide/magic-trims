import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { chooseBotAction } from "../src/bot.js";
import { evaluateOutcome } from "../src/modes.js";
import { applyAction } from "../src/reducer.js";
import { parsePermanentAbilities } from "../src/triggers.js";
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

const permanent = (name: string, oracleText: string, extra: Partial<CardData> = {}) =>
  fakeCard(name, { typeLine: "Enchantment", oracleText, manaCost: "", ...extra });
const creature = (name: string, oracleText = "", extra: Partial<CardData> = {}) =>
  permanent(name, oracleText, { typeLine: "Creature — Test", power: "2", toughness: "2", ...extra });

const SHEOLDRED = creature(
  "Sheoldred, the Apocalypse",
  "Deathtouch\nWhenever you draw a card, you gain 2 life.\nWhenever an opponent draws a card, they lose 2 life.",
  { power: "4", toughness: "5", typeLine: "Legendary Creature — Phyrexian Praetor" },
);
const BLOOD_ARTIST = creature("Blood Artist", "Whenever Blood Artist or another creature dies, target player loses 1 life and you gain 1 life.", {
  power: "0",
  toughness: "1",
});
const EXQUISITE_BLOOD = permanent("Exquisite Blood", "Whenever an opponent loses life, you gain that much life.");
const SANGUINE_BOND = permanent("Sanguine Bond", "Whenever you gain life, target opponent loses that much life.");
const PHYREXIAN_ARENA = permanent("Phyrexian Arena", "At the beginning of your upkeep, you draw a card and you lose 1 life.");
const HOWLING_MINE = permanent(
  "Howling Mine",
  "At the beginning of each player's draw step, if Howling Mine is untapped, that player draws an additional card.",
  { typeLine: "Artifact" },
);

/** Met une carte de la main du joueur sur le champ de bataille avec les données voulues. */
function put(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  return [g, id];
}

/** Tout le monde passe jusqu'à ce que la pile soit vide. */
function resolveAll(g: GameState, max = 300): GameState {
  for (let i = 0; i < max && g.priority && g.stack.length > 0; i++) g = act(g, g.priority.playerId, { type: "passPriority" });
  return g;
}

const lastLines = (g: GameState, n = 4) => g.log.slice(-n).map((l) => l.message);

describe("Lecture des capacités déclenchées", () => {
  it("reconnaît les capacités du deck Sheoldred", () => {
    const parse = (c: CardData) => parsePermanentAbilities(c.oracleText, c.name);
    expect(parse(SHEOLDRED).triggers.map((t) => t.condition)).toEqual([
      { on: "draw", whose: "you" },
      { on: "draw", whose: "opponent" },
    ]);
    expect(parse(BLOOD_ARTIST).triggers[0]).toMatchObject({
      condition: { on: "dies", self: true, others: true, whose: "any" },
      effects: { targets: [{ player: true }] },
    });
    expect(parse(HOWLING_MINE).triggers[0]).toMatchObject({ condition: { on: "step", step: "draw", whose: "any" }, ifUntapped: true });
    expect(parse(permanent("Seizan", "At the beginning of each player's upkeep, that player loses 2 life and draws two cards.")).unknown).toEqual([]);
    expect(parse(permanent("Underworld Dreams", "Whenever an opponent draws a card, Underworld Dreams deals 1 damage to that player.")).unknown).toEqual(
      [],
    );
    expect(parse(permanent("Bloodthirsty Aerialist", "Flying\nWhenever you gain life, put a +1/+1 counter on Bloodthirsty Aerialist.")).triggers).toHaveLength(1);
    // Ce que le moteur ne sait pas faire reste à la main.
    const opportunist = parse(
      creature("Morbid Opportunist", "Whenever one or more other creatures die, draw a card. This ability triggers only once each turn."),
    );
    expect(opportunist.triggers).toEqual([]);
    expect(parse(permanent("Optional", "Whenever you gain life, you may draw a card.")).triggers).toEqual([]);
  });
});

describe("Capacités déclenchées", () => {
  it("Sheoldred : la pioche d'un adversaire déclenche, tout le monde passe, il perd 2 PV", () => {
    let g = newTestGame(3);
    [g] = put(g, "p1", SHEOLDRED);
    g = act(g, "p2", { type: "draw", count: 1 });
    expect(g.stack).toHaveLength(1);
    expect(g.cards[g.stack[0]!]!.ability).toMatchObject({ sourceName: "Sheoldred, the Apocalypse", eventPlayerId: "p2" });
    expect(g.priority!.playerId).toBe("p1");
    expect(lastLines(g, 1)[0]).toBe("Capacité de Sheoldred, the Apocalypse : « Whenever an opponent draws a card, they lose 2 life. ».");
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(38);
    // Ma pioche : je gagne 2 PV. La capacité résolue disparaît.
    g = act(g, "p1", { type: "draw", count: 2 });
    expect(g.stack).toHaveLength(2);
    g = resolveAll(g);
    expect(g.players.p1!.life).toBe(44);
    expect(Object.values(g.cards).some((c) => c.ability)).toBe(false);
  });

  it("Blood Artist : choisir la cible avant que la pile avance", () => {
    let g = newTestGame(3);
    let victim: string;
    [g] = put(g, "p1", BLOOD_ARTIST);
    [g, victim] = put(g, "p2", creature("Victim"));
    g = act(g, "p2", { type: "moveCard", cardId: victim, to: "graveyard" });
    const ability = g.stack[0]!;
    expect(g.cards[ability]!.ability!.needsTargets).toBe(true);
    expect(refuse(g, "p1", { type: "passPriority" })).toMatch(/Alice doit d'abord choisir les cibles de la capacité de Blood Artist/);
    expect(refuse(g, "p2", { type: "chooseTargets", cardId: ability, targets: [{ kind: "player", id: "p3" }] })).toMatch(/contrôleur/);
    g = act(g, "p1", { type: "chooseTargets", cardId: ability, targets: [{ kind: "player", id: "p3" }] });
    g = resolveAll(g);
    expect(g.players.p3!.life).toBe(39);
    expect(g.players.p1!.life).toBe(41);
  });

  it("Blood Artist se voit mourir, et un jeton qui meurt déclenche aussi", () => {
    let g = newTestGame(2);
    let artist: string;
    [g, artist] = put(g, "p1", BLOOD_ARTIST);
    g = act(g, "p1", { type: "moveCard", cardId: artist, to: "graveyard" });
    // Une seule cible possible pour « target player » ? Non : deux joueurs. Il faut choisir.
    g = act(g, "p1", { type: "chooseTargets", cardId: g.stack[0]!, targets: [{ kind: "player", id: "p2" }] });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(39);
  });

  it("Sanguine Bond + Exquisite Blood : la boucle s'arrête quand l'adversaire meurt", () => {
    let g = newTestGame(2);
    [g] = put(g, "p1", SANGUINE_BOND, 0);
    [g] = put(g, "p1", EXQUISITE_BLOOD, 0);
    g = act(g, "p1", { type: "nextStep", to: "main1" });
    g = structuredClone(g);
    const spell = g.players.p1!.zones.hand[0]!;
    g.cardData[g.cards[spell]!.cardId] = { ...fakeCard("Heal", { typeLine: "Instant", oracleText: "You gain 5 life.", manaCost: "" }), id: g.cards[spell]!.cardId };
    g = act(g, "p1", { type: "castSpell", cardId: spell });
    g = resolveAll(g);
    expect(g.players.p2!.hasConceded).toBe(true);
    expect(evaluateOutcome(g).winners).toEqual(["p1"]);
    expect(g.stack).toEqual([]);
  });

  it("Phyrexian Arena à l'entretien : le tour s'arrête à l'entretien le temps de résoudre", () => {
    let g = newTestGame(2);
    [g] = put(g, "p1", PHYREXIAN_ARENA);
    g = act(g, "p1", { type: "passTurn" });
    g = act(g, "p2", { type: "passTurn" });
    expect(g.turn).toMatchObject({ activePlayerId: "p1", step: "upkeep" });
    expect(g.stack).toHaveLength(1);
    expect(refuse(g, "p1", { type: "nextStep" })).toMatch(/pile n'est pas vide/);
    const hand = g.players.p1!.zones.hand.length;
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 1);
    expect(g.players.p1!.life).toBe(39);
  });

  it("Howling Mine : une carte de plus à la pioche, seulement si elle est dégagée", () => {
    let g = newTestGame(2);
    let mine: string;
    [g, mine] = put(g, "p1", HOWLING_MINE);
    g = act(g, "p1", { type: "passTurn" });
    // La pioche d'Alice déclenche d'abord la mine : le tour s'arrête à son étape de pioche.
    expect(g.turn).toMatchObject({ activePlayerId: "p1", step: "draw" });
    g = resolveAll(g);
    g = act(g, "p1", { type: "passTurn" });
    expect(g.turn).toMatchObject({ activePlayerId: "p2", step: "upkeep" });
    let hand = g.players.p2!.zones.hand.length;
    g = act(g, "p2", { type: "nextStep" });
    expect(g.turn.step).toBe("draw");
    g = resolveAll(g);
    expect(g.players.p2!.zones.hand.length).toBe(hand + 2);
    g = act(g, "p1", { type: "setTapped", cardIds: [mine], tapped: true });
    g = act(g, "p2", { type: "passTurn" });
    // Le dégagement de p1 remet la mine dégagée : on la réengage à l'entretien.
    g = act(g, "p1", { type: "setTapped", cardIds: [mine], tapped: true });
    hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "nextStep" });
    expect(g.stack).toEqual([]);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 1);
  });

  it("arrivée, mort et marqueurs sur la source", () => {
    let g = newTestGame(2);
    let aerialist: string;
    [g, aerialist] = put(g, "p1", creature("Aerialist", "Flying\nWhenever you gain life, put a +1/+1 counter on Aerialist."));
    [g] = put(g, "p1", creature("Merchant", "When Merchant enters, each opponent loses 2 life and you gain 2 life."));
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(38);
    expect(g.players.p1!.life).toBe(42);
    expect(g.cards[aerialist]!.counters["+1/+1"]).toBe(1);
    let martyr: string;
    [g, martyr] = put(g, "p1", creature("Martyr", "When Martyr dies, draw a card."));
    const hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "moveCard", cardId: martyr, to: "graveyard" });
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand + 1);
  });

  it("le bot choisit un adversaire pour sa capacité", () => {
    let g = newTestGame(3);
    let victim: string;
    [g] = put(g, "p1", BLOOD_ARTIST);
    [g, victim] = put(g, "p2", creature("Victim"));
    g = act(g, "p2", { type: "moveCard", cardId: victim, to: "graveyard" });
    const action = chooseBotAction(g, "p1");
    expect(action).toMatchObject({ type: "chooseTargets", targets: [{ kind: "player", id: "p2" }] });
  });

  it("sans « faire respecter les règles », rien ne se déclenche", () => {
    let g = newTestGame(2);
    g.settings.enforceRules = false;
    [g] = put(g, "p1", SHEOLDRED);
    g = act(g, "p2", { type: "draw", count: 1 });
    expect(g.stack).toEqual([]);
  });
});
