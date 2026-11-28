import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { endTurn, fakeCard, newTestGame } from "./helpers.js";

// Texte Oracle exact (deck Jodah).
const RATADRABIK = fakeCard("Ratadrabik of Urborg", {
  typeLine: "Legendary Creature — Zombie Wizard",
  manaCost: "{2}{W}{B}",
  power: "3",
  toughness: "3",
  oracleText:
    "Vigilance, ward {2}\nOther Zombies you control have vigilance.\nWhenever another legendary creature you control dies, create a token that's a copy of that creature, except it's not legendary and it's a 2/2 black Zombie in addition to its other colors and types.",
});
const TRAXOS = fakeCard("Traxos, Scourge of Kroog", {
  typeLine: "Legendary Artifact Creature — Dragon Construct",
  manaCost: "{4}",
  power: "7",
  toughness: "7",
  oracleText:
    "Trample\nTraxos enters tapped and doesn't untap during your untap step.\nWhenever you cast a historic spell, untap Traxos. (Artifacts, legendaries, and Sagas are historic.)",
});
const WARD_LIFE = fakeCard("Garde PV", { typeLine: "Creature — Spirit", manaCost: "{1}{B}", power: "2", toughness: "2", oracleText: "Ward—Pay 3 life." });
const SWORDS = fakeCard("Swords to Plowshares", {
  typeLine: "Instant",
  manaCost: "{W}",
  oracleText: "Exile target creature. Its controller gains life equal to its power.",
});
const CLAUSTRO = fakeCard("Claustrophobia", {
  typeLine: "Enchantment — Aura",
  manaCost: "{1}{U}{U}",
  oracleText: "Enchant creature\nWhen Claustrophobia enters, tap enchanted creature.\nEnchanted creature doesn't untap during its controller's untap step.",
});
const BEAR = fakeCard("Ours", { typeLine: "Creature — Bear", manaCost: "{1}{G}", power: "2", toughness: "2" });
const RELIC = fakeCard("Relique", { typeLine: "Artifact", manaCost: "{0}", oracleText: "" });

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}
function setCard(g: GameState, playerId: string, card: CardData, n: number): string {
  const id = g.players[playerId]!.zones.hand[n]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  return id;
}
function put(g: GameState, playerId: string, card: CardData, n: number): [GameState, string] {
  g = structuredClone(g);
  const id = setCard(g, playerId, card, n);
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  delete g.cards[id]!.summoningSick;
  return [g, id];
}
function mana(g: GameState, playerId: string, pool: string): GameState {
  for (const m of pool.match(/[WUBRGC]/g) ?? []) g = act(g, playerId, { type: "adjustMana", mana: m as "U", delta: 1 });
  return g;
}
function passAll(g: GameState): GameState {
  for (let i = 0; i < 10 && g.priority && g.stack.length > 0 && !g.stack.some((id) => g.cards[id]!.ability?.awaitingDecision); i++) {
    g = act(g, g.priority.playerId, { type: "passPriority" });
  }
  return g;
}
const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });

/** p1 lance Swords to Plowshares sur `target` ; renvoie l'état avec la garde au sommet de la pile. */
function swordOn(g: GameState, target: string): [GameState, string] {
  g = structuredClone(g);
  const swords = setCard(g, "p1", SWORDS, 0);
  g = mana(g, "p1", "W");
  g = act(g, "p1", { type: "castSpell", cardId: swords, targets: [{ kind: "card", id: target }] });
  return [g, swords];
}

describe("Garde (ward)", () => {
  it("Ratadrabik : la ligne « Vigilance, ward {2} » est gérée", () => {
    expect(cardSupport(RATADRABIK).unknown).not.toContain("Vigilance, ward {2}");
    expect(cardSupport(WARD_LIFE).level).toBe("full");
  });

  it("un sort adverse qui la cible est contré si son contrôleur ne paie pas", () => {
    let g = toMain(newTestGame(2));
    let rata: string;
    [g, rata] = put(g, "p2", RATADRABIK, 0);
    let swords: string;
    [g, swords] = swordOn(g, rata);
    expect(g.stack.length).toBe(2);
    const ward = g.stack[1]!;
    expect(g.cards[ward]!.ability!.text).toBe("Ward {2}");
    g = passAll(g);
    expect(g.cards[ward]!.ability!.awaitingDecision).toBe(true);
    g = act(g, "p1", { type: "decideOptional", cardId: ward, accept: false });
    expect(g.stack).not.toContain(swords);
    g = passAll(g);
    expect(g.stack).toEqual([]);
    expect(g.cards[rata]!.zone).toBe("battlefield");
  });

  it("le sort résout si son contrôleur paie {2}", () => {
    let g = toMain(newTestGame(2));
    let rata: string;
    [g, rata] = put(g, "p2", RATADRABIK, 0);
    let ward: string;
    [g] = swordOn(g, rata);
    ward = g.stack[1]!;
    g = passAll(g);
    g = mana(g, "p1", "CC");
    g = act(g, "p1", { type: "decideOptional", cardId: ward, accept: true });
    g = passAll(g);
    expect(g.stack).toEqual([]);
    expect(g.cards[rata]?.zone).not.toBe("battlefield");
  });

  it("« Ward—Pay 3 life » : payer 3 PV laisse le sort résoudre", () => {
    let g = toMain(newTestGame(2));
    let spirit: string;
    [g, spirit] = put(g, "p2", WARD_LIFE, 0);
    [g] = swordOn(g, spirit);
    const ward = g.stack[1]!;
    const life = g.players.p1!.life;
    g = passAll(g);
    g = act(g, "p1", { type: "decideOptional", cardId: ward, accept: true });
    expect(g.players.p1!.life).toBe(life - 3);
    g = passAll(g);
    expect(g.cards[spirit]?.zone).not.toBe("battlefield");
  });

  it("ses propres sorts ne déclenchent pas la garde", () => {
    let g = toMain(newTestGame(2));
    let rata: string;
    [g, rata] = put(g, "p1", RATADRABIK, 1);
    [g] = swordOn(g, rata);
    expect(g.stack.length).toBe(1);
  });
});

describe("Ne se dégage pas", () => {
  it("Traxos arrive engagé, ne se dégage pas à l'étape de dégagement, mais un sort historique le dégage", () => {
    expect(cardSupport(TRAXOS).level).toBe("full");
    let g = toMain(newTestGame(2));
    let traxos: string;
    [g, traxos] = put(g, "p1", TRAXOS, 0);
    expect(g.cards[traxos]!.tapped).toBe(true);
    g = endTurn(g, "p1");
    g = endTurn(g, "p2");
    g = toMain(g);
    expect(g.turn.activePlayerId).toBe("p1");
    expect(g.cards[traxos]!.tapped).toBe(true);
    g = structuredClone(g);
    const relic = setCard(g, "p1", RELIC, 0);
    g = act(g, "p1", { type: "castSpell", cardId: relic });
    g = passAll(g);
    expect(g.cards[traxos]!.tapped).toBe(false);
  });

  it("Claustrophobia : la créature enchantée ne se dégage pas", () => {
    expect(cardSupport(CLAUSTRO).unknown).not.toContain("Enchanted creature doesn't untap during its controller's untap step.");
    let g = toMain(newTestGame(2));
    let bear: string;
    [g, bear] = put(g, "p2", BEAR, 0);
    g = structuredClone(g);
    const aura = setCard(g, "p1", CLAUSTRO, 0);
    g = mana(g, "p1", "UUU");
    g = act(g, "p1", { type: "castSpell", cardId: aura, targets: [{ kind: "card", id: bear }] });
    g = passAll(g);
    g = passAll(g);
    expect(g.cards[aura]!.attachedTo).toBe(bear);
    // « tap enchanted creature » à l'arrivée n'est pas l'objet de ce test : on l'engage d'office.
    g = structuredClone(g);
    g.cards[bear]!.tapped = true;
    g = endTurn(g, "p1");
    expect(g.turn.activePlayerId).toBe("p2");
    expect(g.cards[bear]!.tapped).toBe(true);
  });
});
