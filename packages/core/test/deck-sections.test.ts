import { describe, expect, it } from "vitest";
import { parseDeckList } from "../src/deck/parse.js";

/** Liste exportée de Moxfield par l'utilisateur (sections par type de carte). */
const ASHLING = `//Commander
1 Ashling, the Limitless (ECC) 1

//Lands
1 Abundant Countryside (ECC) 22
1 Command Tower (ECC) 59
1 Exotic Orchard (ECC) 148
1 Flamekin Village (ECC) 149
4 Forest (ECL) 273
1 Island (ECL) 270
1 Mountain (ECL) 272
1 Plains (ECL) 269
1 Primal Beyond (ECC) 159
1 Secluded Courtyard (ECC) 62
1 Swamp (ECL) 271
1 Unclaimed Territory (ECC) 175
1 Bayou (3ED) 283
1 Misty Rainforest (SLU) 5
1 Tundra (3ED) 289
1 Volcanic Island (3ED) 291
1 Plateau (3ED) 284
1 Tropical Island (3ED) 288
1 Taiga (3ED) 287
1 Raffine's Tower (SNC) 254
1 Savai Triome (IKO) 253
1 Indatha Triome (IKO) 248
1 Windswept Heath (KTK) 248
1 Badlands (3ED) 282
1 Volrath's Stronghold (STH) 143
1 Overgrown Tomb (ECL) 266
1 Savannah (3ED) 285
1 Prismatic Vista (H1R) 40
1 Sodden Verdure (ECC) 24
1 Flooded Strand (KTK) 233
1 Scalding Tarn (SLU) 2
1 Bloodstained Mire (KTK) 230
1 Ziatora's Proving Ground (SNC) 261
1 Raugrin Triome (IKO) 251
1 Xander's Lounge (SNC) 260
1 Zagoth Triome (IKO) 259
1 Ashling's Command (ECL) 205
1 Twinflame Travelers (ECL) 248
1 Utopia Sprawl (RVR) 159
1 Titan of Industry (ECC) 117
1 Tyrant of Discord (AVR) 162
1 Shroudstomper (DSK) 233
1 Shriekmaw (ECC) 85
1 Yarok, the Desecrated (ECC) 136
1 Selvala, Heart of the Wilds (ECC) 116
1 Subterfuge (ECC) 6
1 Risen Reef (ECC) 132
1 Smokebraider (ECC) 96

//Artifacts
1 Arcane Signet (ECC) 55
1 Cloud Key (EOC) 54
1 Sol Ring (ECC) 57
1 Herald's Horn (M3C) 296
1 Pyre of Heroes (KHM) 241
1 Urza's Incubator (DMR) 239

//Enchantments
1 Cream of the Crop (ECC) 102
1 Descendants' Fury (ECC) 93
1 Elemental Bond (TDC) 254
1 Fertile Ground (ECC) 106
1 Heartless Summoning (INR) 117
1 Land Tax (CMM) 37

//Instants
1 Path to Exile (ECC) 65
1 Wake the Dead (CMM) 197
1 Ephemerate (MAR) 44

//Sorceries
1 Cultivate (ECC) 103
1 Haunting Voyage (ECC) 75
1 Kodama's Reach (ECC) 113
1 Living Death (TDC) 185
1 Farseek (EOC) 50
1 Rampant Growth (TDC) 265

//Creatures
1 Animar, Soul of Elements (2X2) 171
1 Avenger of Zendikar (TDC) 247
1 Bane of Progress (ECC) 99
1 Cavalier of Dawn (M20) 10
1 Cavalier of Gales (M20) 52
1 Cavalier of Thorns (ECC) 100
1 Endurance (ECC) 51
1 Faeburrow Elder (ECC) 53
1 Flamebraider (ECL) 139
1 Foundation Breaker (ECC) 108
1 Fury (ECC) 50
1 Greenwarden of Murasa (ECC) 110
1 Havoc Eater (MKC) 31
1 Honest Rutstein (OTJ) 207
1 Horde of Notions (ECC) 124
1 Incandescent Soulstoke (ECC) 94
1 Ingot Chewer (ECC) 95
1 Lamentation (ECC) 10
1 Maelstrom Wanderer (ECC) 127
1 Mass of Mysteries (ECC) 3
1 Mulldrifter (MKC) 111
1 Omnath, Locus of Rage (ECC) 129
1 Omnath, Locus of the Roil (ECC) 130
1 Morophon, the Boundless (M3C) 157
1 Nulldrifter (MH3) 13
1 Bloom Tender (ECL) 166
1 Goblin Anarchomancer (MH2) 200

//Maybeboard
1 Cavalier of Flame (M20) 125
1 Grave Sifter (CMA) 112
`;

const count = (entries: { quantity: number }[]) => entries.reduce((n, e) => n + e.quantity, 0);

describe("sections par catégorie (export Moxfield « //Lands », « //Creatures »…)", () => {
  it("garde seulement Ashling en commandant et met le Maybeboard de côté", () => {
    const deck = parseDeckList(ASHLING);
    expect(deck.errors).toEqual([]);
    expect(deck.commanders.map((c) => c.name)).toEqual(["Ashling, the Limitless"]);
    expect(count(deck.mainboard)).toBe(99);
    expect(deck.mainboard.map((c) => c.name)).toContain("Goblin Anarchomancer");
    expect(deck.other.map((c) => c.name)).toEqual(["Cavalier of Flame", "Grave Sifter"]);
  });

  it("accepte les catégories sans ligne vide ni « // » (« Creatures (2) », « Ramp: »)", () => {
    const deck = parseDeckList(`Commander (1)
1 Atraxa, Praetors' Voice (C16) 28
Creatures (2)
1 Llanowar Elves
1 Birds of Paradise
Ramp:
1 Sol Ring
Sideboard (1)
1 Swords to Plowshares`);
    expect(deck.errors).toEqual([]);
    expect(deck.commanders.map((c) => c.name)).toEqual(["Atraxa, Praetors' Voice"]);
    expect(deck.mainboard.map((c) => c.name)).toEqual(["Llanowar Elves", "Birds of Paradise", "Sol Ring"]);
    expect(deck.other.map((c) => c.name)).toEqual(["Swords to Plowshares"]);
  });

  it("n'avale pas le format MTGO pour un simple commentaire en tête", () => {
    const deck = parseDeckList(`// Deck de test
1 Sol Ring
1 Arcane Signet

1 Atraxa, Praetors' Voice`);
    expect(deck.commanders.map((c) => c.name)).toEqual(["Atraxa, Praetors' Voice"]);
    expect(deck.mainboard).toHaveLength(2);
  });
});
