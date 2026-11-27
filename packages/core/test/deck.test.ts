import { describe, expect, it } from "vitest";
import { parseDeckList } from "../src/deck/parse.js";
import { resolveDeck } from "../src/deck/resolve.js";
import { ScryfallClient, toCardData, type ScryfallCard } from "../src/deck/scryfall.js";
import { deckColorIdentity, deckLegalityByMode, validateCommanderDeck } from "../src/deck/validate.js";
import { fakeCard, fakeDeck } from "./helpers.js";

describe("lecture d'une liste Moxfield", () => {
  it("lit le format Moxfield avec édition, numéro et foil", () => {
    const deck = parseDeckList(`1 Sol Ring (C21) 263
1x Arcane Signet (CMM) 371 *F*
10 Forest
1 Delver of Secrets / Insectile Aberration (ISD) 51`);
    expect(deck.errors).toEqual([]);
    expect(deck.mainboard).toEqual([
      { quantity: 1, name: "Sol Ring", set: "c21", collectorNumber: "263", line: 1 },
      { quantity: 1, name: "Arcane Signet", set: "cmm", collectorNumber: "371", line: 2 },
      { quantity: 10, name: "Forest", line: 3 },
      { quantity: 1, name: "Delver of Secrets // Insectile Aberration", set: "isd", collectorNumber: "51", line: 4 },
    ]);
  });

  it("lit les sections « Commander » et « Deck » (format Arena)", () => {
    const deck = parseDeckList(`Commander
1 Atraxa, Praetors' Voice

Deck
1 Sol Ring
1 Command Tower

Sideboard
1 Swords to Plowshares`);
    expect(deck.commanders.map((e) => e.name)).toEqual(["Atraxa, Praetors' Voice"]);
    expect(deck.mainboard.map((e) => e.name)).toEqual(["Sol Ring", "Command Tower"]);
    expect(deck.other.map((e) => e.name)).toEqual(["Swords to Plowshares"]);
  });

  it("reconnaît le commandant isolé à la fin (format MTGO)", () => {
    const deck = parseDeckList("1 Sol Ring\n1 Command Tower\n\n1 Kenrith, the Returned King\n");
    expect(deck.commanders.map((e) => e.name)).toEqual(["Kenrith, the Returned King"]);
    expect(deck.mainboard).toHaveLength(2);
  });

  it("reconnaît « COMMANDER: » et signale les lignes illisibles", () => {
    const deck = parseDeckList("COMMANDER:\n1 Krenko, Mob Boss\nMAINBOARD:\n1 Sol Ring\nn'importe quoi\n");
    expect(deck.commanders).toHaveLength(1);
    expect(deck.mainboard).toHaveLength(1);
    expect(deck.errors).toEqual([{ line: 5, text: "n'importe quoi" }]);
  });
});

describe("lecture d'une liste deckstats.net", () => {
  it("lit les éditions entre crochets, le commandant marqué et les sections //", () => {
    const deck = parseDeckList(`//Main
1 [C21#263] Sol Ring
1 [CMM] Arcane Signet
10 Forest
1 [M13#141] Krenko, Mob Boss # !Commander

//Sideboard
1 [2XM] Swords to Plowshares
SB: 1 Path to Exile`);
    expect(deck.errors).toEqual([]);
    expect(deck.commanders).toEqual([{ quantity: 1, name: "Krenko, Mob Boss", set: "m13", collectorNumber: "141", line: 5 }]);
    expect(deck.mainboard.map((e) => [e.name, e.set, e.collectorNumber])).toEqual([
      ["Sol Ring", "c21", "263"],
      ["Arcane Signet", "cmm", undefined],
      ["Forest", undefined, undefined],
    ]);
    expect(deck.other.map((e) => e.name).sort()).toEqual(["Path to Exile", "Swords to Plowshares"]);
  });
});

function scryfallCard(name: string, extra: Partial<ScryfallCard> = {}): ScryfallCard {
  return {
    id: `sf-${name}`,
    oracle_id: `or-${name}`,
    name,
    set: "tst",
    collector_number: "1",
    type_line: "Artifact",
    image_uris: { small: "s", normal: "n", large: "l" },
    ...extra,
  };
}

/** Faux Scryfall : connaît quelques cartes, répond comme /cards/collection. */
function fakeScryfall(known: ScryfallCard[]) {
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith("/cards/collection")) {
      const { identifiers } = JSON.parse(String(init?.body)) as { identifiers: { name?: string; set?: string; collector_number?: string }[] };
      const data: ScryfallCard[] = [];
      const notFound: unknown[] = [];
      for (const id of identifiers) {
        const card = known.find((c) =>
          id.collector_number
            ? c.set === id.set && c.collector_number === id.collector_number
            : c.name.toLowerCase() === id.name!.toLowerCase(),
        );
        if (card) data.push(card);
        else notFound.push(id);
      }
      return new Response(JSON.stringify({ data, not_found: notFound }));
    }
    const fuzzy = /named\?fuzzy=(.*)$/.exec(url);
    if (fuzzy) {
      const wanted = decodeURIComponent(fuzzy[1]!).toLowerCase().replace(/\s/g, "");
      const card = known.find((c) => c.name.toLowerCase().replace(/\s/g, "").startsWith(wanted.slice(0, 5)));
      return card ? new Response(JSON.stringify(card)) : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 404 });
  };
  return { client: new ScryfallClient({ fetch, delayMs: 0 }), calls };
}

describe("résolution Scryfall", () => {
  it("convertit une carte double face", () => {
    const card = toCardData({
      id: "x",
      name: "Delver of Secrets // Insectile Aberration",
      set: "isd",
      collector_number: "51",
      card_faces: [
        { name: "Delver of Secrets", type_line: "Creature — Human Wizard", image_uris: { small: "a", normal: "b", large: "c" } },
        { name: "Insectile Aberration", type_line: "Creature — Human Insect", image_uris: { small: "d", normal: "e", large: "f" } },
      ],
    });
    expect(card.image?.normal).toBe("b");
    expect(card.faces?.map((f) => f.image?.normal)).toEqual(["b", "e"]);
    expect(card.typeLine).toBe("Creature — Human Wizard");
  });

  it("résout un deck, se rabat sur le nom puis la recherche approximative", async () => {
    const { client } = fakeScryfall([
      scryfallCard("Krenko, Mob Boss", { type_line: "Legendary Creature — Goblin" }),
      scryfallCard("Sol Ring", { set: "c21", collector_number: "263" }),
      scryfallCard("Mountain"),
      scryfallCard("Goblin Matron"),
    ]);
    const parsed = parseDeckList(`Commander
1 Krenko, Mob Boss

Deck
1 Sol Ring (C21) 263
1 Mountain (XXX) 999
30 Mountain
1 Goblin Matrone
1 Carte Inexistante`);
    const { deck, unresolved } = await resolveDeck(parsed, client);
    expect(deck.commanders.map((c) => c.name)).toEqual(["Krenko, Mob Boss"]);
    expect(deck.cards.map((c) => [c.card.name, c.quantity])).toEqual([
      ["Sol Ring", 1],
      ["Mountain", 31],
      ["Goblin Matron", 1],
    ]);
    expect(unresolved.map((e) => e.name)).toEqual(["Carte Inexistante"]);
  });

  it("regroupe les requêtes par 75 et utilise le cache", async () => {
    const known = Array.from({ length: 160 }, (_, i) => scryfallCard(`Card ${i}`));
    const { client, calls } = fakeScryfall(known);
    const ids = known.map((c) => ({ name: c.name }));
    const first = await client.getCollection(ids);
    expect(first.found.size).toBe(160);
    expect(calls).toHaveLength(3);
    await client.getCollection(ids);
    expect(calls).toHaveLength(3);
  });
});

describe("validation Commander", () => {
  it("accepte un deck correct", () => {
    expect(validateCommanderDeck(fakeDeck("A"))).toEqual([]);
  });

  it("signale les problèmes courants", () => {
    const deck = fakeDeck("A");
    deck.commanders[0]!.colorIdentity = ["R"];
    deck.cards[0] = { card: fakeCard("Counterspell", { colorIdentity: ["U"] }), quantity: 1 };
    deck.cards[1] = { card: fakeCard("Lightning Bolt", { colorIdentity: ["R"] }), quantity: 2 };
    deck.cards[2] = { card: fakeCard("Mountain", { typeLine: "Basic Land — Mountain" }), quantity: 10 };
    deck.cards[3] = {
      card: fakeCard("Relentless Rats", { oracleText: "A deck can have any number of cards named Relentless Rats." }),
      quantity: 5,
    };
    deck.cards[4] = { card: fakeCard("Mana Crypt", { commanderLegality: "banned" }), quantity: 1 };
    const messages = validateCommanderDeck(deck).map((i) => i.message);
    expect(messages).toEqual([
      "Le deck compte 114 cartes au lieu de 100.",
      "Lightning Bolt est présent en 2 exemplaires (singleton).",
      "Counterspell sort de l'identité couleur du commandant (U).",
      "Mana Crypt est bannie en Commander.",
    ]);
  });

  it("applique la liste de bannies du Duel Commander en duel", () => {
    const deck = fakeDeck("A");
    deck.cards[0] = { card: fakeCard("Sol Ring", { duelLegality: "banned" }), quantity: 1 };
    expect(validateCommanderDeck(deck)).toEqual([]);
    expect(validateCommanderDeck(deck, "duel")).toEqual([{ level: "warning", message: "Sol Ring est bannie en Duel Commander." }]);
  });

  it("accepte un Vaisseau ou un Véhicule légendaire avec force/endurance comme commandant", () => {
    const deck = fakeDeck("A");
    deck.commanders[0] = fakeCard("Inspirit", { typeLine: "Legendary Artifact — Spacecraft", power: "5", toughness: "5" });
    expect(validateCommanderDeck(deck)).toEqual([]);
    deck.commanders[0] = fakeCard("Station", { typeLine: "Legendary Artifact — Spacecraft" });
    expect(validateCommanderDeck(deck).map((i) => i.message)).toEqual(["Station n'est pas une créature légendaire."]);
  });

  it("accepte un Docteur et son compagnon comme paire de commandants", () => {
    const deck = fakeDeck("A");
    deck.cards.pop();
    deck.commanders = [
      fakeCard("The Fourth Doctor", { typeLine: "Legendary Creature — Time Lord Doctor" }),
      fakeCard("Sarah Jane Smith", { typeLine: "Legendary Creature — Human Detective", keywords: ["Doctor's companion"] }),
    ];
    expect(validateCommanderDeck(deck)).toEqual([]);
  });

  it("exige un commandant", () => {
    const issues = validateCommanderDeck({ commanders: [], cards: [] });
    expect(issues[0]).toEqual({ level: "error", message: "Aucun commandant n'est désigné." });
  });

  it("donne la légalité pour chaque mode de jeu", () => {
    const deck = fakeDeck("A");
    deck.cards[0] = { card: fakeCard("Sol Ring", { duelLegality: "banned" }), quantity: 1 };
    const byMode = deckLegalityByMode(deck, ["freeForAll", "duel", "teams"]);
    expect(byMode.freeForAll).toEqual([]);
    expect(byMode.teams).toEqual([]);
    expect(byMode.duel).toHaveLength(1);
  });

  it("range l'identité couleur dans l'ordre WUBRG", () => {
    const deck = fakeDeck("A");
    deck.commanders = [
      fakeCard("Zedruu", { colorIdentity: ["R", "W", "U"] }),
    ];
    expect(deckColorIdentity(deck)).toEqual(["W", "U", "R"]);
    expect(deckColorIdentity(fakeDeck("B"))).toEqual([]);
  });
});
