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

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const spell = (name: string, typeLine: string, manaCost: string, colors: string[]) =>
  fakeCard(name, { typeLine, manaCost, colors, oracleText: "You gain 1 life." });
const LEGENDARY_SORCERY = spell("Legendary Ritual", "Legendary Sorcery", "{G}", ["G"]);
const SORCERY = spell("Plain Ritual", "Sorcery", "{G}", ["G"]);

/** Lance une carte de la main de p1 (n-ième) avec les données voulues, puis résout la pile. */
function cast(g: GameState, card: CardData, pool: string, playerId = "p1"): GameState {
  let id: string;
  [g, id] = inHand(g, playerId, card);
  g = mana(g, playerId, pool);
  g = act(g, playerId, { type: "castSpell", cardId: id });
  return resolveAll(g);
}

describe("Déclencheurs « quand vous lancez un sort » filtrés : lecture", () => {
  it("lit la couleur, le légendaire, l'historique, le rang dans le tour et la provenance", () => {
    expect(parseTriggerCondition("you cast a legendary spell")).toMatchObject({ on: "cast", whose: "you", legendary: true });
    expect(parseTriggerCondition("you cast a historic spell")).toMatchObject({ historic: true });
    expect(parseTriggerCondition("you cast a white spell")).toMatchObject({ colors: ["W"] });
    expect(parseTriggerCondition("you cast a legendary spell from your hand")).toMatchObject({ legendary: true, from: "hand" });
    expect(parseTriggerCondition("an opponent casts their first noncreature spell each turn")).toMatchObject({
      whose: "opponent",
      notTypes: ["creature"],
      nth: 1,
    });
    expect(parseTriggerCondition("you cast your second spell each turn")).toMatchObject({ nth: 2, types: [] });
    expect(parseTriggerCondition("you cast a spell from anywhere other than your hand")).toMatchObject({ from: "notHand" });
    expect(parseTriggerCondition("you cast a creature spell with mana value 5 or greater")).toMatchObject({ types: ["creature"], minManaValue: 5 });
    expect(parseTriggerCondition("you cast a multicolored spell")).toMatchObject({ multicolored: true });
    expect(parseTriggerCondition("you cast a Merfolk spell")).toMatchObject({ subtypes: ["Merfolk"] });
    expect(parseTriggerCondition("you cast an Aura or Equipment spell")).toMatchObject({ subtypes: ["Aura", "Equipment"] });
    expect(parseTriggerCondition("you cast an instant or sorcery spell")).toMatchObject({ types: ["instant", "sorcery"] });
    expect(parseTriggerCondition("you cast your first spell during each opponent's turn")).toMatchObject({ nth: 1, opponentsTurn: true });
    expect(parseTriggerCondition("you cast your first spell with {X} in its mana cost each turn")).toMatchObject({ nth: 1, hasX: true });
    // Ce que le moteur ne sait pas lire reste à la main.
    expect(parseTriggerCondition("you cast a spell that targets ~")).toBeNull();
    expect(parseTriggerCondition("you cast your first spell")).toBeNull();
  });

  it("Shanid : un terrain légendaire joué ou un sort légendaire lancé, deux déclencheurs", () => {
    const shanid = real("Shanid, Sleepers' Scourge");
    const triggers = parsePermanentAbilities(shanid.oracleText, shanid.name, shanid.typeLine).triggers;
    expect(triggers.map((t) => t.condition)).toEqual([
      { on: "landPlayed", whose: "you", legendary: true },
      { on: "cast", whose: "you", types: [], notTypes: [], legendary: true },
    ]);
  });

  it("les cartes du deck Jodah de cette famille sont reconnues en entier", () => {
    for (const name of ["Reki, the History of Kamigawa", "Shanid, Sleepers' Scourge", "Aragorn, the Uniter", "Esper Sentinel"]) {
      expect(cardSupport(real(name)), name).toMatchObject({ level: "full" });
    }
    // Traxos : il reste « ne se dégage pas pendant votre étape de dégagement ».
    expect(cardSupport(real("Traxos, Scourge of Kroog")).unknown).toEqual(["Traxos enters tapped and doesn't untap during your untap step."]);
    // Jodah : la condition est lue ; l'effet (cascade légendaire) est géré depuis la famille 8.
    const jodah = real("Jodah, the Unifier");
    expect(parseTriggerCondition("you cast a legendary spell from your hand")).not.toBeNull();
    expect(cardSupport(jodah).level).toBe("full");
  });
});

describe("Déclencheurs « quand vous lancez un sort » filtrés : en partie", () => {
  it("Reki : pioche pour un sort légendaire, pas pour un autre", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Reki, the History of Kamigawa"));
    let hand = g.players.p1!.zones.hand.length;
    g = cast(g, SORCERY, "G");
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1);
    hand = g.players.p1!.zones.hand.length;
    g = cast(g, LEGENDARY_SORCERY, "G");
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1 + 1);
  });

  it("Shanid : pioche et perd 1 PV pour un terrain légendaire joué et un sort légendaire lancé", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Shanid, Sleepers' Scourge"));
    let land: string;
    [g, land] = inHand(g, "p1", real("Otawara, Soaring City"));
    let hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "playLand", cardId: land });
    g = resolveAll(g);
    expect(g.players.p1!.zones.hand.length).toBe(hand - 1 + 1);
    expect(g.players.p1!.life).toBe(39);
    // Un terrain non légendaire ne déclenche rien (au tour suivant).
    g = endTurn(g, "p1");
    g = endTurn(g, "p2");
    g = resolveAll(act(g, "p1", { type: "nextStep", to: "main1" }));
    let basic: string;
    [g, basic] = inHand(g, "p1", fakeCard("Forest", { typeLine: "Basic Land — Forest", manaCost: "" }));
    hand = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "playLand", cardId: basic });
    expect(g.stack).toEqual([]);
    g = cast(g, LEGENDARY_SORCERY, "G");
    expect(g.players.p1!.zones.hand.length).toBe(hand - 2 + 1);
    // 39 − 1 (Shanid) + 1 (le sort de test fait gagner 1 PV).
    expect(g.players.p1!.life).toBe(39);
    expect(g.log.map((l) => l.message)).toContain("Alice perd 1 PV (38).");
  });

  it("Traxos : se dégage quand on lance un sort historique (artefact), pas pour un rituel", () => {
    let g = toMain(newTestGame(2));
    let traxos: string;
    [g, traxos] = put(g, "p1", real("Traxos, Scourge of Kroog"));
    g = structuredClone(g);
    g.cards[traxos]!.tapped = true;
    g = cast(g, SORCERY, "G");
    expect(g.cards[traxos]!.tapped).toBe(true);
    g = cast(g, real("Sol Ring"), "C");
    expect(g.cards[traxos]!.tapped).toBe(false);
  });

  it("Aragorn : un sort blanc et bleu déclenche le jeton et le regard des 2 cartes du dessus", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p1", real("Aragorn, the Uniter"));
    let id: string;
    [g, id] = inHand(g, "p1", spell("Azorius Thing", "Instant", "{W}{U}", ["W", "U"]));
    g = mana(g, "p1", "WU");
    g = act(g, "p1", { type: "castSpell", cardId: id });
    const texts = g.stack.map((s) => g.cards[s]!.ability?.text).filter(Boolean);
    expect(texts).toEqual(
      expect.arrayContaining(["Whenever you cast a white spell, create a 1/1 white Human Soldier creature token.", "Whenever you cast a blue spell, scry 2."]),
    );
    expect(texts).toHaveLength(2);
    // Le sort vert déclenche le +4/+4, le rouge les 3 blessures (à cibler) ; pas ceux-ci.
    for (let i = 0; i < 5 && g.stack.length > 0; i++) {
      g = resolveAll(g);
      const looking = g.stack.map((s) => g.cards[s]!).find((c) => c.scry);
      if (!looking) continue;
      const top = g.players.p1!.zones.library.slice(0, 2);
      g = act(g, "p1", { type: "scry", cardId: looking.instanceId, top, bottom: [] });
    }
    const soldiers = g.players.p1!.zones.battlefield.filter((c) => g.cardData[g.cards[c]!.cardId]!.typeLine.includes("Soldier"));
    expect(soldiers).toHaveLength(1);
  });

  it("Esper Sentinel : le premier sort non-créature d'un adversaire, à moins qu'il paie {X} (X = force)", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p2", real("Esper Sentinel"));
    // Un sort de créature : rien.
    g = cast(g, fakeCard("Bear", { typeLine: "Creature — Bear", manaCost: "{G}", colors: ["G"], power: "2", toughness: "2" }), "G");
    expect(g.stack).toEqual([]);
    // Le premier non-créature : Alice choisit de payer {1}.
    let id: string;
    [g, id] = inHand(g, "p1", SORCERY);
    g = mana(g, "p1", "GC");
    g = act(g, "p1", { type: "castSpell", cardId: id });
    g = resolveAll(g);
    const pending = g.stack.map((s) => g.cards[s]!).find((c) => c.ability?.awaitingDecision)!;
    expect(pending.ability!.decider).toBe("p1");
    const hand = g.players.p2!.zones.hand.length;
    g = act(g, "p1", { type: "decideOptional", cardId: pending.instanceId, accept: true });
    expect(g.players.p1!.manaPool.C).toBe(0);
    g = resolveAll(g);
    expect(g.players.p2!.zones.hand.length).toBe(hand);
    // Le deuxième non-créature du tour : plus rien.
    g = cast(g, SORCERY, "G");
    expect(g.stack).toEqual([]);
    expect(g.players.p2!.zones.hand.length).toBe(hand);
  });

  it("Esper Sentinel : s'il ne paie pas, je pioche", () => {
    let g = toMain(newTestGame(2));
    [g] = put(g, "p2", real("Esper Sentinel"));
    let id: string;
    [g, id] = inHand(g, "p1", SORCERY);
    g = mana(g, "p1", "G");
    g = act(g, "p1", { type: "castSpell", cardId: id });
    g = resolveAll(g);
    const pending = g.stack.map((s) => g.cards[s]!).find((c) => c.ability?.awaitingDecision)!;
    const hand = g.players.p2!.zones.hand.length;
    g = act(g, "p1", { type: "decideOptional", cardId: pending.instanceId, accept: false });
    g = resolveAll(g);
    expect(g.players.p2!.zones.hand.length).toBe(hand + 1);
  });
});
