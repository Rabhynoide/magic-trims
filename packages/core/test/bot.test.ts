import { describe, expect, it } from "vitest";
import { applyAction } from "../src/reducer.js";
import { chooseBotAction } from "../src/bot.js";
import { createGame } from "../src/setup.js";
import type { CardData, GameState } from "../src/types.js";
import type { ResolvedDeck } from "../src/deck/resolve.js";
import { fakeCard } from "./helpers.js";

/** Un deck jouable : 40 forêts et des créatures de 1 à 4 manas. */
function greenDeck(prefix: string): ResolvedDeck {
  const forest = fakeCard(`${prefix} Forest`, {
    typeLine: "Basic Land — Forest",
    oracleText: "({T}: Add {G}.)",
    manaCost: "",
    manaValue: 0,
  });
  const creatures: CardData[] = Array.from({ length: 59 }, (_, i) => {
    const mv = 1 + (i % 4);
    return fakeCard(`${prefix} Beast ${i}`, {
      typeLine: "Creature — Beast",
      manaCost: `{${mv - 1}}{G}`.replace("{0}", ""),
      manaValue: mv,
      power: String(mv),
      toughness: String(mv),
      keywords: i % 7 === 0 ? ["Flying"] : [],
    });
  });
  return {
    commanders: [
      fakeCard(`${prefix} Commander`, {
        typeLine: "Legendary Creature — Elf",
        manaCost: "{2}{G}",
        manaValue: 3,
        power: "3",
        toughness: "3",
      }),
    ],
    cards: [{ card: forest, quantity: 40 }, ...creatures.map((card) => ({ card, quantity: 1 }))],
  };
}

function botGame(): GameState {
  return createGame({
    id: "bots",
    seed: 7,
    mode: "duel",
    randomTurnOrder: false,
    players: [
      { id: "b1", name: "Bot 1", deck: greenDeck("A") },
      { id: "b2", name: "Bot 2", deck: greenDeck("B") },
    ],
  });
}

/** Fait jouer les bots jusqu'à ce que plus aucun n'ait d'action, ou `max` actions. */
function run(g: GameState, bots: string[], max: number, until?: (g: GameState) => boolean): { g: GameState; actions: number } {
  let actions = 0;
  for (; actions < max && !until?.(g); actions++) {
    let acted = false;
    for (const id of bots) {
      const action = chooseBotAction(g, id);
      if (!action) continue;
      const r = applyAction(g, { actorId: id, action });
      if (!r.ok) throw new Error(`${id} : action refusée ${JSON.stringify(action)} : ${r.error}`);
      g = r.state;
      acted = true;
      break;
    }
    if (!acted) break;
  }
  return { g, actions };
}

describe("Bot", () => {
  it("deux bots jouent une partie sans se bloquer", { timeout: 30000 }, () => {
    const { g } = run(botGame(), ["b1", "b2"], 3000, (s) => s.turn.number > 10);
    // La partie avance : plusieurs tours, des terrains et des créatures en jeu, des points de vie perdus.
    expect(g.turn.number).toBeGreaterThan(8);
    const lands = g.players.b1!.zones.battlefield.filter((id) => /Forest/.test(g.cardData[g.cards[id]!.cardId]!.name));
    expect(lands.length).toBeGreaterThan(3);
    expect(g.players.b1!.life + g.players.b2!.life).toBeLessThan(40);
  });

  it("attend son tour, et passe la priorité sur les sorts adverses", () => {
    let g = botGame();
    expect(chooseBotAction(g, "b2")).toBeNull();
    g = run(g, ["b1", "b2"], 100, (s) => s.turn.activePlayerId === "b2").g;
    // Le bot 1 a joué un terrain et fini son tour : c'est au joueur 2.
    expect(g.turn.activePlayerId).toBe("b2");
    expect(g.players.b1!.zones.battlefield.length).toBeGreaterThan(0);
  });

  it("bloque une attaque mortelle", () => {
    let g = botGame();
    g = structuredClone(g);
    // Le bot 2 n'a plus que 3 PV et une créature ; le bot 1 attaque avec une 4/4.
    g.players.b2!.life = 3;
    const put = (owner: string, name: string, p: string) => {
      const id = g.players[owner]!.zones.hand[0]!;
      g.cardData[g.cards[id]!.cardId] = fakeCard(name, { typeLine: "Creature — Beast", power: p, toughness: p });
      const r = applyAction(g, { actorId: owner, action: { type: "moveCard", cardId: id, to: "battlefield", force: true } });
      if (!r.ok) throw new Error(r.error);
      g = r.state;
      delete g.cards[id]!.summoningSick;
      return id;
    };
    const big = put("b1", "Big", "4");
    const small = put("b2", "Small", "1");
    const step = (actor: string, action: Parameters<typeof applyAction>[1]["action"]) => {
      const r = applyAction(g, { actorId: actor, action });
      if (!r.ok) throw new Error(r.error);
      g = r.state;
    };
    step("b1", { type: "nextStep", to: "declareAttackers" });
    step("b1", { type: "declareAttackers", attackers: [{ cardId: big, defender: "b2" }] });
    step("b1", { type: "nextStep" });
    expect(chooseBotAction(g, "b2")).toEqual({ type: "declareBlockers", blocks: [{ cardId: small, attackerId: big }] });
  });
});
