/**
 * Génère le texte Oracle des cartes des préconstruits
 * (packages/app/src/renderer/src/data/precon-oracle.json), pour que l'onglet
 * « Préconstruits officiels » affiche la colonne « Auto » sans passer par
 * Scryfall.
 *
 *   npm run precons:oracle      (lancé aussi à la fin de `npm run precons`)
 *
 * Seuls le type et le texte Oracle de chaque carte sont gardés : l'appli
 * calcule le pourcentage avec `cardSupport` à l'affichage, il suit donc
 * l'évolution du moteur sans regénérer ce fichier. Il ne faut le relancer
 * que quand la liste des préconstruits change (ou un errata Oracle).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { identifierKey, MemoryCardCache, parseDeckList, ScryfallClient, type CardData } from "../packages/core/src/index.ts";
import type { PreconFile, PreconOracle, PreconOracleCard } from "../packages/app/src/renderer/src/data/precon-types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "packages/app/src/renderer/src/data");
const USER_AGENT = "MagicTrims/0.1 (precon list generator)";

function compact(card: CardData): PreconOracleCard {
  const out: PreconOracleCard = { t: card.typeLine, o: card.oracleText };
  if (card.faces && card.faces.length > 0) {
    out.f = card.faces.map((f) => ({ n: f.name, t: f.typeLine, o: f.oracleText }));
    delete out.o;
  }
  return out;
}

/** Scryfall limite /cards/collection à 2 requêtes par seconde : on patiente s'il demande de ralentir. */
async function politeFetch(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= 5) return res;
    console.warn("  Scryfall demande de ralentir, pause d'une minute…");
    await new Promise((r) => setTimeout(r, 65_000));
  }
}

async function main() {
  const file = JSON.parse(await readFile(join(DATA, "precons.json"), "utf8")) as PreconFile;
  const names = new Set<string>();
  for (const p of file.decks) {
    const parsed = parseDeckList(`Commander\n${p.commanders.join("\n")}\n\nDeck\n${p.cards.join("\n")}\n`);
    for (const e of [...parsed.commanders, ...parsed.mainboard]) names.add(e.name);
  }
  console.log(`${names.size} cartes différentes dans ${file.decks.length} préconstruits`);

  const scryfall = new ScryfallClient({ cache: new MemoryCardCache(), userAgent: USER_AGENT, delayMs: 600, fetch: politeFetch });
  const list = [...names].sort((a, b) => a.localeCompare(b));
  const { found } = await scryfall.getCollection(list.map((name) => ({ name })));
  const cards: Record<string, PreconOracleCard> = {};
  const missing: string[] = [];
  for (const name of list) {
    let card = found.get(identifierKey({ name }));
    if (!card) {
      console.log(`  « ${name} » introuvable par son nom exact, recherche approximative`);
      card = await scryfall.getByFuzzyName(name);
      // Carte à nom alternatif (« Slash Clone (Steelbane Hydra) ») : même texte que la carte entre parenthèses.
      const original = /\(([^)]+)\)$/.exec(name)?.[1];
      if (!card && original) card = await scryfall.getByFuzzyName(original);
    }
    if (!card) {
      missing.push(name);
      continue;
    }
    const entry = compact(card);
    if (card.name !== name) entry.n = card.name;
    cards[name] = entry;
  }
  if (missing.length > 0) console.warn(`Introuvables sur Scryfall : ${missing.join(", ")}`);

  const out: PreconOracle = { generatedAt: new Date().toISOString().slice(0, 10), cards };
  const json = JSON.stringify(out).replace(/\},"/g, '},\n"');
  await writeFile(join(DATA, "precon-oracle.json"), json + "\n");
  console.log(`${Object.keys(cards).length} cartes écrites dans precon-oracle.json (${Math.round(json.length / 1024)} Ko)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
