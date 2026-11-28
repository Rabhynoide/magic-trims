import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { creatureStats, hasKeyword, protectionColors } from "../src/combat.js";
import { cardSupport, isLegalTarget } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { endTurn, fakeCard, newTestGame } from "./helpers.js";
import deck from "./jodah-oracle.json" with { type: "json" };

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

/** Une carte du deck Jodah, avec son texte Oracle exact. */
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
    if (g.stack.some((id) => g.cards[id]!.ability?.awaitingDecision || g.cards[id]!.ability?.needsTargets || g.cards[id]!.cardChoice || g.cards[id]!.modes && !g.cards[id]!.modes!.chosen)) break;
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
const legend = (name = "Legend") => fakeCard(name, { typeLine: "Legendary Creature — Human", power: "2", toughness: "2", manaCost: "{1}{G}" });
const kw = (g: GameState, id: string, k: Parameters<typeof hasKeyword>[2]) => hasKeyword(g, g.cards[id]!, k);

describe("Deck Jodah : bonus jusqu'à la fin du tour", () => {
  it("Heroic Intervention : mes permanents gagnent la défense talismanique et l'indestructible jusqu'à la fin du tour", () => {
    let g = toMain(newTestGame(2));
    let mine: string, land: string, theirs: string, spell: string;
    [g, mine] = put(g, "p1", bear());
    [g, land] = put(g, "p1", real("Tundra"), 1);
    [g, theirs] = put(g, "p2", bear("Their Bear"));
    [g, spell] = inHand(g, "p1", real("Heroic Intervention"), 2);
    g = mana(g, "p1", "GG");
    g = act(g, "p1", { type: "castSpell", cardId: spell });
    g = resolveAll(g);
    expect(kw(g, mine, "Hexproof") && kw(g, mine, "Indestructible")).toBe(true);
    expect(kw(g, land, "Hexproof")).toBe(true);
    expect(kw(g, theirs, "Hexproof")).toBe(false);
    g = endTurn(g, "p1");
    expect(kw(g, mine, "Indestructible")).toBe(false);
  });

  it("Tamiyo's Safekeeping cible n'importe quel permanent à moi, et je gagne 2 PV", () => {
    let g = toMain(newTestGame(2));
    let land: string, spell: string;
    [g, land] = put(g, "p1", real("Tundra"));
    [g, spell] = inHand(g, "p1", real("Tamiyo's Safekeeping"), 1);
    g = mana(g, "p1", "G");
    g = act(g, "p1", { type: "castSpell", cardId: spell, targets: [{ kind: "card", id: land }] });
    g = resolveAll(g);
    expect(kw(g, land, "Hexproof") && kw(g, land, "Indestructible")).toBe(true);
    expect(g.players.p1!.life).toBe(42);
    const spec = { label: "permanent", permanent: { types: [], notTypes: [] } };
    expect(isLegalTarget(g, spec, { kind: "card", id: land }, "p2")).toBe(false);
  });

  it("Hajar : en la sacrifiant, mes créatures légendaires gagnent +1/+0 et l'indestructible", () => {
    let g = toMain(newTestGame(2));
    let hajar: string, lg: string, other: string;
    [g, hajar] = put(g, "p1", real("Hajar, Loyal Bodyguard"));
    [g, lg] = put(g, "p1", legend());
    [g, other] = put(g, "p1", bear(), 1);
    g = act(g, "p1", { type: "activateAbility", cardId: hajar, index: 0 });
    g = resolveAll(g);
    expect(g.cards[hajar]!.zone).toBe("graveyard");
    expect(creatureStats(g, g.cards[lg]!)).toEqual({ power: 3, toughness: 2 });
    expect(kw(g, lg, "Indestructible")).toBe(true);
    expect(creatureStats(g, g.cards[other]!)).toEqual({ power: 2, toughness: 2 });
    expect(kw(g, other, "Indestructible")).toBe(false);
  });

  it("Plaza of Heroes : {3}, engager, s'exiler : une créature légendaire gagne la défense talismanique et l'indestructible", () => {
    let g = toMain(newTestGame(2));
    let plaza: string, lg: string, other: string;
    [g, plaza] = put(g, "p1", real("Plaza of Heroes"));
    [g, lg] = put(g, "p1", legend());
    [g, other] = put(g, "p1", bear(), 1);
    g = mana(g, "p1", "CCC");
    const index = 1;
    expect(refuse(g, "p1", { type: "activateAbility", cardId: plaza, index, targets: [{ kind: "card", id: other }] })).toMatch(/Cible invalide/);
    g = act(g, "p1", { type: "activateAbility", cardId: plaza, index, targets: [{ kind: "card", id: lg }] });
    expect(g.cards[plaza]!.zone).toBe("exile");
    g = resolveAll(g);
    expect(kw(g, lg, "Hexproof") && kw(g, lg, "Indestructible")).toBe(true);
  });

  it("Unbreakable Formation : addendum seulement pendant ma phase principale", () => {
    let g = toMain(newTestGame(2));
    let a: string, spell: string;
    [g, a] = put(g, "p1", bear());
    [g, spell] = inHand(g, "p1", real("Unbreakable Formation"), 1);
    g = mana(g, "p1", "WCC");
    g = act(g, "p1", { type: "castSpell", cardId: spell });
    g = resolveAll(g);
    expect(kw(g, a, "Indestructible") && kw(g, a, "Vigilance")).toBe(true);
    expect(g.cards[a]!.counters["+1/+1"]).toBe(1);

    // Pendant le tour de l'adversaire : seulement l'indestructible.
    let h = endTurn(g, "p1");
    let b: string, other: string;
    [h, b] = put(h, "p1", bear("Bear 2"));
    [h, other] = inHand(h, "p1", real("Unbreakable Formation"), 1);
    h = act(h, "p2", { type: "nextStep", to: "main1" });
    h = mana(h, "p1", "WCC");
    h.priority = { ...h.priority!, playerId: "p1" };
    h = act(h, "p1", { type: "castSpell", cardId: other });
    h = resolveAll(h);
    expect(kw(h, b, "Indestructible")).toBe(true);
    expect(kw(h, b, "Vigilance")).toBe(false);
    expect(h.cards[b]!.counters["+1/+1"]).toBeUndefined();
  });

  it("Dihada +2 : vigilance, lien de vie et indestructible jusqu'à mon prochain tour", () => {
    let g = toMain(newTestGame(2));
    let dihada: string, lg: string;
    [g, dihada] = put(g, "p1", real("Dihada, Binder of Wills"));
    [g, lg] = put(g, "p1", legend(), 1);
    g = act(g, "p1", { type: "activateAbility", cardId: dihada, index: 0, targets: [{ kind: "card", id: lg }] });
    g = resolveAll(g);
    expect(kw(g, lg, "Lifelink") && kw(g, lg, "Indestructible") && kw(g, lg, "Vigilance")).toBe(true);
    g = endTurn(g, "p1");
    expect(g.turn.activePlayerId).toBe("p2");
    expect(kw(g, lg, "Indestructible")).toBe(true);
    g = endTurn(g, "p2");
    expect(g.turn.activePlayerId).toBe("p1");
    expect(kw(g, lg, "Indestructible")).toBe(false);
  });

  it("Akroma's Will : les deux modes seulement si je contrôle un commandant ; protection contre chaque couleur", () => {
    let g = toMain(newTestGame(2));
    let a: string, spell: string;
    [g, a] = put(g, "p1", bear());
    [g, spell] = inHand(g, "p1", real("Akroma's Will"), 1);
    g = mana(g, "p1", "WCCC");
    expect(refuse(g, "p1", { type: "castSpell", cardId: spell, modes: [0, 1] })).toMatch(/Choisis 1 mode/);
    g.cards[a]!.isCommander = true;
    g = act(g, "p1", { type: "castSpell", cardId: spell, modes: [0, 1] });
    g = resolveAll(g);
    for (const k of ["Flying", "Vigilance", "Double strike", "Lifelink", "Indestructible"] as const) expect(kw(g, a, k)).toBe(true);
    expect(protectionColors(g, g.cards[a]!).sort()).toEqual(["B", "G", "R", "U", "W"]);
    g = endTurn(g, "p1");
    expect(protectionColors(g, g.cards[a]!)).toEqual([]);
  });

  it("ces cartes du deck sont entièrement gérées", () => {
    for (const name of ["Heroic Intervention", "Tamiyo's Safekeeping", "Hajar, Loyal Bodyguard", "Plaza of Heroes", "Unbreakable Formation", "Akroma's Will"]) {
      expect(cardSupport(real(name)).level, name).toBe("full");
    }
    expect(cardSupport(real("Dihada, Binder of Wills")).unknown.some((u) => u.startsWith("+2"))).toBe(false);
  });
});
