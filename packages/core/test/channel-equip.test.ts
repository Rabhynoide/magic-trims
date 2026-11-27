import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { cardSupport } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import type { CardData, GameState } from "../src/types.js";
import { endTurn, fakeCard, newTestGame } from "./helpers.js";

// Texte Oracle exact (deck Jodah).
const OTAWARA = fakeCard("Otawara, Soaring City", {
  typeLine: "Legendary Land",
  manaCost: "",
  oracleText:
    "{T}: Add {U}.\nChannel — {3}{U}, Discard this card: Return target artifact, creature, enchantment, or planeswalker to its owner's hand. This ability costs {1} less to activate for each legendary creature you control.",
});
const ROBE = fakeCard("Robe of the Archmagi", {
  typeLine: "Artifact — Equipment",
  manaCost: "{2}{U}",
  oracleText: "Whenever equipped creature deals combat damage to a player, you draw that many cards.\nEquip {4}\nEquip Shaman, Warlock, or Wizard {1}",
});
const creature = (name: string, type: string, legendary = false) =>
  fakeCard(name, { typeLine: `${legendary ? "Legendary " : ""}Creature — ${type}`, power: "2", toughness: "2", manaCost: "{1}{G}" });

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
function resolveAll(g: GameState): GameState {
  for (let i = 0; i < 50 && g.priority && g.stack.length > 0; i++) g = act(g, g.priority.playerId, { type: "passPriority" });
  return g;
}
const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });

describe("Canalisation (Channel)", () => {
  it("Otawara : se défausse depuis la main pour renvoyer une cible, moins cher par créature légendaire", () => {
    expect(cardSupport(OTAWARA).unknown).toEqual([]);
    let g = structuredClone(toMain(newTestGame(2)));
    const otawara = setCard(g, "p1", OTAWARA, 0);
    let jodah: string, target: string;
    [g, jodah] = put(g, "p1", creature("Jodah", "Human Wizard", true), 1);
    [g] = put(g, "p1", creature("Shanid", "Human Knight", true), 1);
    [g, target] = put(g, "p2", creature("Ours", "Bear"), 0);
    // Deux créatures légendaires : {3}{U} devient {1}{U}.
    g = mana(g, "p1", "UG");
    expect(refuse(g, "p2", { type: "activateAbility", cardId: otawara, index: 0, targets: [{ kind: "card", id: target }] })).toMatch(/main/);
    g = act(g, "p1", { type: "activateAbility", cardId: otawara, index: 0, targets: [{ kind: "card", id: target }] });
    expect(g.cards[otawara]!.zone).toBe("graveyard");
    expect(g.players.p1!.manaPool).toMatchObject({ U: 0, G: 0 });
    g = resolveAll(g);
    expect(g.cards[target]!.zone).toBe("hand");
    expect(g.cards[jodah]!.zone).toBe("battlefield");
  });

  it("Otawara : coût plein sans créature légendaire, et pas depuis le champ de bataille", () => {
    let g = structuredClone(toMain(newTestGame(2)));
    const otawara = setCard(g, "p1", OTAWARA, 0);
    let target: string;
    [g, target] = put(g, "p2", creature("Ours", "Bear"), 0);
    g = mana(g, "p1", "UG");
    expect(refuse(g, "p1", { type: "activateAbility", cardId: otawara, index: 0, targets: [{ kind: "card", id: target }] })).toMatch(/mana/);
    g = mana(g, "p1", "GG");
    g = act(g, "p1", { type: "activateAbility", cardId: otawara, index: 0, targets: [{ kind: "card", id: target }] });
    g = resolveAll(g);
    expect(g.cards[target]!.zone).toBe("hand");
    g = endTurn(g, "p1");
  });
});

describe("Équipement restreint", () => {
  it("Robe of the Archmagi : Equip {1} seulement sur un Shaman, un Warlock ou un Wizard", () => {
    // Le déclencheur de pioche relève d'autres familles (#83, #54) : seules les lignes Equip sont vérifiées ici.
    expect(cardSupport(ROBE).unknown.filter((l) => /^Equip/.test(l))).toEqual([]);
    let g = toMain(newTestGame(2));
    let robe: string, wizard: string, bear: string;
    [g, robe] = put(g, "p1", ROBE, 0);
    [g, wizard] = put(g, "p1", creature("Sorcier", "Human Wizard"), 0);
    [g, bear] = put(g, "p1", creature("Ours", "Bear"), 0);
    g = mana(g, "p1", "G");
    expect(refuse(g, "p1", { type: "activateAbility", cardId: robe, index: 1, targets: [{ kind: "card", id: bear }] })).toMatch(/Cible invalide/);
    g = act(g, "p1", { type: "activateAbility", cardId: robe, index: 1, targets: [{ kind: "card", id: wizard }] });
    g = resolveAll(g);
    expect(g.cards[robe]!.attachedTo).toBe(wizard);
    // Equip {4} : n'importe quelle créature.
    g = mana(g, "p1", "GGGG");
    g = act(g, "p1", { type: "activateAbility", cardId: robe, index: 0, targets: [{ kind: "card", id: bear }] });
    g = resolveAll(g);
    expect(g.cards[robe]!.attachedTo).toBe(bear);
  });

  it("Equip legendary creature : seulement une créature légendaire", () => {
    const blade = fakeCard("Lame", { typeLine: "Artifact — Equipment", oracleText: "Equip legendary creature {3}\nEquip {7}" });
    expect(cardSupport(blade).unknown).toEqual([]);
    let g = toMain(newTestGame(2));
    let lame: string, jodah: string, bear: string;
    [g, lame] = put(g, "p1", blade, 0);
    [g, jodah] = put(g, "p1", creature("Jodah", "Human Wizard", true), 0);
    [g, bear] = put(g, "p1", creature("Ours", "Bear"), 0);
    g = mana(g, "p1", "GGG");
    expect(refuse(g, "p1", { type: "activateAbility", cardId: lame, index: 0, targets: [{ kind: "card", id: bear }] })).toMatch(/Cible invalide/);
    g = act(g, "p1", { type: "activateAbility", cardId: lame, index: 0, targets: [{ kind: "card", id: jodah }] });
    g = resolveAll(g);
    expect(g.cards[lame]!.attachedTo).toBe(jodah);
  });
});
