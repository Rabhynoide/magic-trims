import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { hasKeyword } from "../src/combat.js";
import { abilityReport, cardSupport, modesAtCast, parseSpellEffects } from "../src/effects.js";
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

type OracleCard = { name: string; typeLine: string; oracleText?: string; manaCost?: string };

function real(name: string): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, { typeLine: c.typeLine, oracleText: c.oracleText ?? "", manaCost: c.manaCost ?? "" });
}

function put(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  delete g.cards[id]!.summoningSick;
  return [g, id];
}

function inHand(g: GameState, playerId: string, card: CardData, n = 0): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  return [g, id];
}

function resolveAll(g: GameState, max = 100): GameState {
  for (let i = 0; i < max && g.priority && g.stack.length > 0; i++) {
    if (g.stack.some((id) => g.cards[id]!.ability?.awaitingDecision || g.cards[id]!.ability?.needsTargets || g.cards[id]!.cardChoice || (g.cards[id]!.modes && !g.cards[id]!.modes!.chosen))) break;
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
const kw = (g: GameState, id: string, k: Parameters<typeof hasKeyword>[2]) => hasKeyword(g, g.cards[id]!, k);
const pool = (g: GameState) => Object.values(g.players.p1!.manaPool).reduce((a, b) => a + b, 0);

describe("Spree (Trash the Town)", () => {
  it("lit les trois modes, leur coût et leurs effets", () => {
    const parsed = parseSpellEffects(real("Trash the Town").oracleText, "Trash the Town");
    expect(parsed.unknown).toEqual([]);
    expect(parsed.modes).toMatchObject({ min: 1, max: 3 });
    expect(parsed.modes!.list.map((m) => m.cost)).toEqual(["{2}", "{1}", "{1}"]);
    expect(parsed.modes!.list[2]!.effects).toEqual([{ type: "grantTrigger", target: 0, text: "Whenever ~ deals combat damage to a player, draw two cards." }]);
    expect(modesAtCast(parsed)).toBe(true);
    expect(cardSupport(real("Trash the Town")).level).toBe("full");
    expect(abilityReport(real("Trash the Town")).map((i) => i.status)).toEqual(["auto", "auto", "auto", "auto"]);
  });

  it("les modes se choisissent en lançant le sort, et chacun ajoute son coût", () => {
    let g = toMain(newTestGame(2));
    let a: string, spell: string;
    [g, a] = put(g, "p1", bear());
    [g, spell] = inHand(g, "p1", real("Trash the Town"), 1);
    const target = { kind: "card" as const, id: a };
    expect(refuse(g, "p1", { type: "castSpell", cardId: spell })).toMatch(/Choisis entre 1 et 3 modes/);
    // {G} + {2} + {1} : 4 mana, 3 ne suffisent pas.
    g = mana(g, "p1", "GCC");
    expect(refuse(g, "p1", { type: "castSpell", cardId: spell, modes: [0, 2], targets: [target, target] })).toMatch(/Pas assez de mana/);
    g = mana(g, "p1", "C");
    g = act(g, "p1", { type: "castSpell", cardId: spell, modes: [0, 2], targets: [target, target] });
    expect(pool(g)).toBe(0);
    g = resolveAll(g);
    expect(g.cards[a]!.counters["+1/+1"]).toBe(2);
    expect(kw(g, a, "Trample")).toBe(false);
    // Le déclencheur donné : blessures de combat à un joueur, piocher deux cartes.
    const before = g.players.p1!.zones.hand.length;
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    g = act(g, "p1", { type: "declareAttackers", attackers: [{ cardId: a, defender: "p2" }] });
    for (let i = 0; i < 10 && g.turn.step !== "combatDamage"; i++) g = act(g, g.priority?.playerId ?? "p1", g.priority ? { type: "passPriority" } : { type: "nextStep" });
    g = resolveAll(g);
    expect(g.players.p2!.life).toBe(36);
    expect(g.players.p1!.zones.hand.length).toBe(before + 2);
    g = endTurn(g, "p1");
    expect(g.cards[a]!.grantedTriggers ?? []).toEqual([]);
  });

  it("un seul mode : seulement son coût", () => {
    let g = toMain(newTestGame(2));
    let a: string, spell: string;
    [g, a] = put(g, "p1", bear());
    [g, spell] = inHand(g, "p1", real("Trash the Town"), 1);
    g = mana(g, "p1", "GC");
    g = act(g, "p1", { type: "castSpell", cardId: spell, modes: [1], targets: [{ kind: "card", id: a }] });
    g = resolveAll(g);
    expect(kw(g, a, "Trample")).toBe(true);
    expect(g.cards[a]!.counters["+1/+1"] ?? 0).toBe(0);
  });
});

describe("Akroma's Will : « si vous contrôlez un commandant en lançant ce sort »", () => {
  it("les deux modes au lancement si je contrôle un commandant", () => {
    let g = toMain(newTestGame(2));
    let a: string, spell: string;
    [g, a] = put(g, "p1", bear());
    [g, spell] = inHand(g, "p1", real("Akroma's Will"), 1);
    expect(modesAtCast(parseSpellEffects(real("Akroma's Will").oracleText, "Akroma's Will"))).toBe(true);
    g = mana(g, "p1", "WCCC");
    expect(refuse(g, "p1", { type: "castSpell", cardId: spell, modes: [0, 1] })).toMatch(/Choisis 1 mode/);
    g.cards[a]!.isCommander = true;
    g = act(g, "p1", { type: "castSpell", cardId: spell, modes: [0, 1] });
    g = resolveAll(g);
    expect(kw(g, a, "Double strike") && kw(g, a, "Indestructible")).toBe(true);
  });

  it("le commandant compte au lancement, pas à la résolution", () => {
    let g = toMain(newTestGame(2));
    let a: string, spell: string;
    [g, a] = put(g, "p1", bear());
    [g, spell] = inHand(g, "p1", real("Akroma's Will"), 1);
    g = mana(g, "p1", "WCCC");
    // Sans choix envoyé (le bot), les modes se choisissent à la résolution.
    g = act(g, "p1", { type: "castSpell", cardId: spell });
    g.cards[a]!.isCommander = true;
    g = resolveAll(g);
    expect(refuse(g, "p1", { type: "chooseModes", cardId: spell, modes: [0, 1] })).toMatch(/Choisis 1 mode/);
    g = act(g, "p1", { type: "chooseModes", cardId: spell, modes: [1] });
    g = resolveAll(g);
    expect(kw(g, a, "Indestructible")).toBe(true);
    expect(kw(g, a, "Flying")).toBe(false);
  });
});
