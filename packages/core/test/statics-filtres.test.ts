import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/actions.js";
import { canAttack, creatureStats, hasKeyword } from "../src/combat.js";
import { cardSupport, isLegalTarget, parseSpellEffects } from "../src/effects.js";
import { applyAction } from "../src/reducer.js";
import { parseStaticLine } from "../src/statics.js";
import type { CardData, GameState } from "../src/types.js";
import { endTurn, fakeCard, newTestGame } from "./helpers.js";
import deck from "./jodah-oracle.json" with { type: "json" };

function act(g: GameState, actorId: string, action: GameAction): GameState {
  const r = applyAction(g, { actorId, action });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

type OracleCard = { name: string; typeLine: string; oracleText?: string; manaCost?: string; power?: string; toughness?: string; colors?: string[] };

/** Une carte du deck Jodah, avec son texte Oracle exact. */
function real(name: string): CardData {
  const c = (deck as OracleCard[]).find((d) => d.name === name);
  if (!c) throw new Error(`Carte absente : ${name}`);
  return fakeCard(c.name, {
    typeLine: c.typeLine,
    oracleText: c.oracleText ?? "",
    manaCost: c.manaCost ?? "",
    colors: c.colors ?? [],
    ...(c.power ? { power: c.power, toughness: c.toughness } : {}),
  });
}

/** Met une carte de la main du joueur sur le champ de bataille. */
function put(g: GameState, playerId: string, card: CardData, sick = false): [GameState, string] {
  g = structuredClone(g);
  const id = g.players[playerId]!.zones.hand[0]!;
  g.cardData[g.cards[id]!.cardId] = { ...card, id: g.cards[id]!.cardId };
  g = act(g, playerId, { type: "moveCard", cardId: id, to: "battlefield", force: true });
  if (!sick) delete g.cards[id]!.summoningSick;
  return [g, id];
}

const toMain = (g: GameState) => act(g, "p1", { type: "nextStep", to: "main1" });
const legend = (name: string, colors: string[], subtype = "Human") =>
  fakeCard(name, { typeLine: `Legendary Creature — ${subtype}`, power: "1", toughness: "1", colors });

describe("Seigneurs et bonus statiques filtrés", () => {
  it("Jodah : les créatures légendaires ont +X/+X, X = nombre de créatures légendaires", () => {
    let g = toMain(newTestGame(2));
    let jodah: string, other: string, bear: string;
    [g, jodah] = put(g, "p1", real("Jodah, the Unifier"));
    expect(creatureStats(g, g.cards[jodah]!)).toEqual({ power: 6, toughness: 6 });
    [g, other] = put(g, "p1", legend("Héros", ["W"]));
    [g, bear] = put(g, "p1", fakeCard("Ours", { typeLine: "Creature — Bear", power: "2", toughness: "2" }));
    expect(creatureStats(g, g.cards[jodah]!)).toEqual({ power: 7, toughness: 7 });
    expect(creatureStats(g, g.cards[other]!)).toEqual({ power: 3, toughness: 3 });
    expect(creatureStats(g, g.cards[bear]!)).toEqual({ power: 2, toughness: 2 });
    // Les légendaires de l'adversaire ne comptent pas et ne reçoivent rien.
    let theirs: string;
    [g, theirs] = put(g, "p2", legend("Rival", ["B"]));
    expect(creatureStats(g, g.cards[theirs]!)).toEqual({ power: 1, toughness: 1 });
    expect(creatureStats(g, g.cards[jodah]!)).toEqual({ power: 7, toughness: 7 });
  });

  it("Sisay : +1/+1 par couleur parmi les autres permanents légendaires", () => {
    let g = toMain(newTestGame(2));
    let sisay: string;
    [g, sisay] = put(g, "p1", real("Sisay, Weatherlight Captain"));
    // Sisay est blanche, mais elle ne compte pas elle-même.
    expect(creatureStats(g, g.cards[sisay]!)).toEqual({ power: 2, toughness: 2 });
    [g] = put(g, "p1", legend("Duo", ["U", "B"]));
    [g] = put(g, "p1", fakeCard("Relique", { typeLine: "Legendary Artifact", colors: [] }));
    [g] = put(g, "p1", fakeCard("Rouge", { typeLine: "Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }));
    expect(creatureStats(g, g.cards[sisay]!)).toEqual({ power: 4, toughness: 4 });
  });

  it("Shalai : défense talismanique pour moi, mes planeswalkers et mes autres créatures", () => {
    let g = toMain(newTestGame(2));
    let shalai: string, bear: string, theirs: string;
    [g, shalai] = put(g, "p1", real("Shalai, Voice of Plenty"));
    [g, bear] = put(g, "p1", fakeCard("Ours", { typeLine: "Creature — Bear", power: "2", toughness: "2" }));
    [g, theirs] = put(g, "p2", fakeCard("Loup", { typeLine: "Creature — Wolf", power: "2", toughness: "2" }));
    expect(hasKeyword(g, g.cards[bear]!, "Hexproof")).toBe(true);
    expect(hasKeyword(g, g.cards[shalai]!, "Hexproof")).toBe(false);
    expect(hasKeyword(g, g.cards[theirs]!, "Hexproof")).toBe(false);
    const bolt = parseSpellEffects("Lightning Bolt deals 3 damage to any target.", "Lightning Bolt").targets[0]!;
    // L'adversaire ne peut cibler ni moi ni l'ours, mais Shalai oui.
    expect(isLegalTarget(g, bolt, { kind: "player", id: "p1" }, "p2")).toBe(false);
    expect(isLegalTarget(g, bolt, { kind: "card", id: bear }, "p2")).toBe(false);
    expect(isLegalTarget(g, bolt, { kind: "card", id: shalai }, "p2")).toBe(true);
    // Moi, je peux toujours me cibler.
    expect(isLegalTarget(g, bolt, { kind: "player", id: "p1" }, "p1")).toBe(true);
    expect(isLegalTarget(g, bolt, { kind: "player", id: "p2" }, "p1")).toBe(true);
  });

  it("Shadowfax : les Chevaux ont la célérité", () => {
    let g = toMain(newTestGame(2));
    let horse: string, bear: string;
    [g] = put(g, "p1", real("Shadowfax, Lord of Horses"));
    [g, horse] = put(g, "p1", fakeCard("Poney", { typeLine: "Creature — Horse", power: "1", toughness: "1" }), true);
    [g, bear] = put(g, "p1", fakeCard("Ours", { typeLine: "Creature — Bear", power: "2", toughness: "2" }), true);
    expect(hasKeyword(g, g.cards[horse]!, "Haste")).toBe(true);
    expect(hasKeyword(g, g.cards[bear]!, "Haste")).toBe(false);
    g = act(g, "p1", { type: "nextStep", to: "declareAttackers" });
    expect(canAttack(g, g.cards[horse]!)).toBe(true);
    expect(canAttack(g, g.cards[bear]!)).toBe(false);
  });

  it("Ratadrabik : les autres Zombies ont la vigilance", () => {
    let g = toMain(newTestGame(2));
    let rata: string, zombie: string;
    [g, rata] = put(g, "p1", real("Ratadrabik of Urborg"));
    [g, zombie] = put(g, "p1", fakeCard("Zombie", { typeLine: "Creature — Zombie", power: "2", toughness: "2" }));
    expect(hasKeyword(g, g.cards[zombie]!, "Vigilance")).toBe(true);
    expect(hasKeyword(g, g.cards[rata]!, "Vigilance")).toBe(true);
    g = endTurn(g, "p1");
    expect(hasKeyword(g, g.cards[zombie]!, "Vigilance")).toBe(true);
  });

  it("lit les variantes courantes (seigneurs, « pour chaque », « le nombre de »)", () => {
    expect(parseStaticLine("Commander creatures you control get +2/+2 and have indestructible.")).toMatchObject({
      kind: "anthem",
      filters: [{ commander: true, types: ["creature"], whose: "you" }],
      power: 2,
      keywords: ["indestructible"],
    });
    expect(parseStaticLine("Other Elves you control get +1/+1.")).toMatchObject({ filters: [{ others: true, subtype: "Elf" }] });
    expect(parseStaticLine("Other Elemental creatures you control get +1/+1.")).toMatchObject({ filters: [{ others: true, subtype: "Elemental", types: ["creature"] }] });
    expect(parseStaticLine("Other creatures you control of the chosen type get +1/+1.")).toMatchObject({ filters: [{ others: true, chosenType: true }] });
    expect(parseStaticLine("Creatures your opponents control get -1/-0.")).toMatchObject({ filters: [{ whose: "opponents" }], power: -1, toughness: 0 });
    expect(parseStaticLine("Artifact creatures you control get +1/+1.")).toMatchObject({ filters: [{ types: ["creature", "artifact"] }] });
    expect(parseStaticLine("Equipped creature gets +1/+1 for each artifact you control.")).toMatchObject({ kind: "attached", perCount: { kind: "permanents" } });
    expect(parseStaticLine("~ gets +1/+1 for each other creature you control.")).toMatchObject({ kind: "selfPump", count: { filter: { others: true } } });
    expect(parseStaticLine("~'s power and toughness are each equal to the number of creature cards in your graveyard.")).toMatchObject({
      kind: "ptEquals",
      count: { kind: "graveyard", types: ["creature"] },
    });
    expect(parseStaticLine("You have hexproof.")).toMatchObject({ kind: "anthem", player: ["hexproof"] });
    // Pas de bonus deviné : un groupe inconnu reste non géré.
    expect(parseStaticLine("Attacking creatures you control get +1/+0.")).toBeNull();
    expect(parseStaticLine("Each creature you control gets +1/+1.")).toBeNull();
  });

  it("un équipement « pour chaque artefact » et une créature « égale au nombre de »", () => {
    let g = toMain(newTestGame(2));
    let bear: string, sword: string, tally: string;
    [g, bear] = put(g, "p1", fakeCard("Ours", { typeLine: "Creature — Bear", power: "2", toughness: "2" }));
    [g, sword] = put(g, "p1", fakeCard("Lame", { typeLine: "Artifact — Equipment", oracleText: "Equipped creature gets +1/+1 for each artifact you control." }));
    g = structuredClone(g);
    g.cards[sword]!.attachedTo = bear;
    [g] = put(g, "p1", fakeCard("Babiole", { typeLine: "Artifact" }));
    expect(creatureStats(g, g.cards[bear]!)).toEqual({ power: 4, toughness: 4 });
    [g, tally] = put(g, "p1", fakeCard("Compteur", { typeLine: "Creature — Construct", power: "*", toughness: "*", oracleText: "Compteur's power and toughness are each equal to the number of creatures you control." }));
    expect(creatureStats(g, g.cards[tally]!)).toEqual({ power: 2, toughness: 2 });
  });

  it("la famille 6 du deck Jodah passe en « géré » (sauf les autres familles)", () => {
    for (const name of ["Shalai, Voice of Plenty", "Faeburrow Elder"]) expect(cardSupport(real(name)).level, name).toBe("full");
    // Ces cartes ont encore une ligne d'une autre famille ; la ligne statique, elle, est lue.
    expect(cardSupport(real("Jodah, the Unifier")).unknown.some((l) => /^Legendary creatures you control/.test(l))).toBe(false);
    expect(cardSupport(real("Sisay, Weatherlight Captain")).unknown.some((l) => /^Sisay gets/.test(l))).toBe(false);
    expect(cardSupport(real("Shadowfax, Lord of Horses")).unknown.some((l) => /^Horses/.test(l))).toBe(false);
    expect(cardSupport(real("Ratadrabik of Urborg")).unknown.some((l) => /^Other Zombies/.test(l))).toBe(false);
  });
});
