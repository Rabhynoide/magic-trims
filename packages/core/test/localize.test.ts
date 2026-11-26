import { describe, expect, it } from "vitest";
import { applyLocalization, ScryfallClient, toCardData, type ScryfallCard } from "../src/deck/scryfall.js";

const solRingEn: ScryfallCard = {
  id: "sol-en",
  oracle_id: "o-sol",
  name: "Sol Ring",
  type_line: "Artifact",
  set: "c21",
  collector_number: "263",
};

const frenchPrints: ScryfallCard[] = [
  {
    id: "sol-fr-c21",
    oracle_id: "o-sol",
    lang: "fr",
    name: "Sol Ring",
    printed_name: "Anneau solaire",
    printed_type_line: "Artefact",
    printed_text: "{T} : Ajoutez {C}{C}.",
    set: "c21",
    collector_number: "263",
    image_uris: { small: "fr-s", normal: "fr-n", large: "fr-l" },
  },
  {
    id: "delver-fr",
    oracle_id: "o-delver",
    lang: "fr",
    name: "Delver of Secrets // Insectile Aberration",
    set: "isd",
    collector_number: "51",
    card_faces: [
      { name: "Delver of Secrets", printed_name: "Fouineur des secrets", image_uris: { small: "a", normal: "b", large: "c" } },
      { name: "Insectile Aberration", printed_name: "Aberration insectile", image_uris: { small: "d", normal: "e", large: "f" } },
    ],
  },
];

function fakeScryfall() {
  const queries: string[] = [];
  const fetch = async (url: string) => {
    const q = decodeURIComponent(/q=([^&]*)/.exec(url)![1]!);
    queries.push(q);
    const exact = url.includes("unique=prints");
    const data = frenchPrints.filter((card) => {
      if (!q.includes(`oracleid:${card.oracle_id}`)) return false;
      return !exact || q.includes(`oracleid:${card.oracle_id} set:${card.set} cn:${card.collector_number})`);
    });
    return data.length
      ? new Response(JSON.stringify({ data }))
      : new Response(JSON.stringify({ details: "aucune carte" }), { status: 404 });
  };
  return { client: new ScryfallClient({ fetch, delayMs: 0 }), queries };
}

describe("cartes traduites", () => {
  it("prend la même impression dans la langue voulue, sinon une autre, sinon rien", async () => {
    const { client, queries } = fakeScryfall();
    const cards = [
      toCardData(solRingEn),
      { id: "delver-en", oracleId: "o-delver", set: "mid", collectorNumber: "999" },
      { id: "nope", oracleId: "o-inconnue", set: "xyz", collectorNumber: "1" },
    ];
    const result = await client.localize(cards, "fr");

    expect(result.get("sol-en")).toMatchObject({
      lang: "fr",
      name: "Anneau solaire",
      typeLine: "Artefact",
      oracleText: "{T} : Ajoutez {C}{C}.",
      image: { normal: "fr-n" },
    });
    // Pas d'impression française dans cette édition : on prend une autre.
    expect(result.get("delver-en")).toMatchObject({
      name: "Fouineur des secrets // Aberration insectile",
      faces: [{ name: "Fouineur des secrets" }, { name: "Aberration insectile", image: { normal: "e" } }],
    });
    // Jamais imprimée en français : on garde l'anglais.
    expect(result.get("nope")).toBeNull();

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("lang:fr");
  });

  it("ajoute la traduction sans toucher aux champs anglais", () => {
    const card = toCardData(solRingEn);
    const localized = applyLocalization(card, { lang: "fr", name: "Anneau solaire", typeLine: "Artefact" });
    expect(localized.name).toBe("Sol Ring");
    expect(localized.typeLine).toBe("Artifact");
    expect(localized.localized?.name).toBe("Anneau solaire");
    expect(applyLocalization(card, null)).toBe(card);
  });

  it("refuse une langue mal formée", async () => {
    const { client } = fakeScryfall();
    await expect(client.localize([], "fr) or (x")).rejects.toThrow();
  });
});
