/**
 * Génère la liste des decks préconstruits Commander officiels
 * (packages/app/src/renderer/src/data/precons.json) à partir de mtg.wtf.
 *
 *   npm run precons
 *
 * 1. Lit https://mtg.wtf/deck et garde les decks de type « Commander Deck ».
 * 2. Lit chaque deck (commandant, cartes avec édition et numéro de collection).
 *    Les sections « Display Commander », « Tokens » et « Scheme Deck » sont
 *    laissées de côté : ce ne sont pas des cartes du deck.
 * 3. Quand une édition collector existe, elle remplace la classique, sauf si elle
 *    pose problème à l'import Scryfall (cartes différentes, impressions que
 *    Scryfall ne trouve pas par édition + numéro) : on garde alors la classique
 *    et la raison est notée dans le champ `note`.
 * 4. Passe chaque deck par Scryfall avec le même code que l'import de l'appli,
 *    pour enregistrer ses couleurs et sa légalité (Commander et Duel) : le
 *    tableau des decks s'affiche ainsi sans attendre Scryfall.
 *
 * Les pages de mtg.wtf sont gardées en cache dans le dossier temporaire du
 * système : relancer le script ne les retélécharge pas (option --refresh).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deckColorIdentity,
  identifierKey,
  MemoryCardCache,
  parseDeckList,
  resolveDeck,
  ScryfallClient,
  validateCommanderDeck,
  type CardIdentifier,
} from "../packages/core/src/index.ts";
import type { Precon, PreconFile } from "../packages/app/src/renderer/src/data/precon-types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages/app/src/renderer/src/data/precons.json");
const SITE = "https://mtg.wtf";
const CACHE = join(tmpdir(), "magic-trims-precons");
const REFRESH = process.argv.includes("--refresh");
const USER_AGENT = "MagicTrims/0.1 (precon list generator)";

interface Entry {
  quantity: number;
  name: string;
  set: string;
  number: string;
}

interface RawDeck {
  slug: string;
  name: string;
  setName: string;
  setCode: string;
  commanders: Entry[];
  cards: Entry[];
}

function decodeHtml(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

let lastFetch = 0;
async function get(path: string): Promise<string> {
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, path.replace(/[^a-z0-9]+/gi, "_") + ".html");
  if (!REFRESH && existsSync(file)) return readFile(file, "utf8");
  const wait = lastFetch + 300 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();
  const res = await fetch(SITE + path, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${path} : ${res.status}`);
  const html = await res.text();
  await writeFile(file, html);
  return html;
}

/** Decks « Commander Deck » de la page d'index, dans l'ordre du site (récents d'abord). */
async function listDecks(): Promise<{ slug: string; name: string; setName: string; setCode: string }[]> {
  const html = await get("/deck");
  const out: { slug: string; name: string; setName: string; setCode: string }[] = [];
  let set = { name: "", code: "" };
  const re = /<div>([^<]*)<\/div>|<a href="\/deck\/([^"]+)">([^<]*)\n<\/a>\(([^,]+), \d+ cards\)/g;
  for (const m of html.matchAll(re)) {
    if (m[1] !== undefined) {
      const title = decodeHtml(m[1]);
      const code = /\(([A-Z0-9]+)\)$/.exec(title);
      set = { name: title.replace(/\s*\([A-Z0-9]+\)$/, ""), code: code?.[1] ?? "" };
    } else if (decodeHtml(m[4]!) === "Commander Deck") {
      out.push({ slug: m[2]!, name: decodeHtml(m[3]!), setName: set.name, setCode: set.code });
    }
  }
  return out;
}

const SKIPPED_SECTIONS = /^(display commander|tokens?|scheme deck|planar deck|sideboard)/i;

async function readDeck(info: { slug: string; name: string; setName: string; setCode: string }): Promise<RawDeck> {
  const html = await get(`/deck/${info.slug}`);
  const deck: RawDeck = { ...info, commanders: [], cards: [] };
  let section = "";
  const re =
    /<h6>([^<(]+)\(\d+\)<\/h6>|<div class="card_entry">\s*(\d+)\s*<span[^>]*>\s*<a href="\/card\/([^/]+)\/([^/]+)\/[^"]*">([^<]+)/g;
  for (const m of html.matchAll(re)) {
    if (m[1] !== undefined) {
      section = m[1].trim();
      continue;
    }
    if (SKIPPED_SECTIONS.test(section)) continue;
    const entry: Entry = {
      quantity: Number(m[2]),
      set: m[3]!,
      number: decodeURIComponent(m[4]!),
      name: decodeHtml(m[5]!),
    };
    if (/^commander$/i.test(section)) deck.commanders.push(entry);
    else deck.cards.push(entry);
  }
  if (deck.commanders.length === 0) throw new Error(`${info.slug} : aucun commandant trouvé`);
  return deck;
}

const line = (e: Entry) => `${e.quantity} ${e.name} (${e.set}) ${e.number}`;
const deckText = (d: RawDeck) => `Commander\n${d.commanders.map(line).join("\n")}\n\nDeck\n${d.cards.map(line).join("\n")}\n`;

/** Liste triée des cartes (nom × quantité), pour comparer deux versions d'un deck. */
function signature(d: RawDeck): string {
  const counts = new Map<string, number>();
  for (const e of [...d.commanders, ...d.cards]) counts.set(e.name, (counts.get(e.name) ?? 0) + e.quantity);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, q]) => `${q} ${n}`)
    .join("\n");
}

const cache = new MemoryCardCache();
/** Scryfall limite /cards/collection à 2 requêtes par seconde : on reste en dessous et on patiente si besoin. */
async function politeFetch(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= 5) return res;
    console.warn("  Scryfall demande de ralentir, pause d'une minute…");
    await new Promise((r) => setTimeout(r, 65_000));
  }
}
const scryfall = new ScryfallClient({ cache, userAgent: USER_AGENT, delayMs: 600, fetch: politeFetch });

/** Cartes que Scryfall ne trouve pas par édition + numéro (l'import se rabattrait sur le nom). */
async function preciseMisses(d: RawDeck): Promise<string[]> {
  const entries = [...d.commanders, ...d.cards];
  const ids: CardIdentifier[] = entries.map((e) => ({ set: e.set, collector_number: e.number }));
  const { found } = await scryfall.getCollection(ids);
  return entries.filter((e, i) => !found.has(identifierKey(ids[i]!))).map(line);
}

async function main() {
  const listed = await listDecks();
  console.log(`${listed.length} decks « Commander Deck » sur mtg.wtf`);

  const collectorRe = /-collectors-edition/;
  const bySlug = new Map(listed.map((d) => [d.slug, d]));
  const precons: Precon[] = [];

  for (const info of listed) {
    if (collectorRe.test(info.slug)) continue; // traité avec sa version classique
    const classic = await readDeck(info);
    const collectorSlug = [...bySlug.keys()].find(
      (s) => collectorRe.test(s) && s.replace(collectorRe, "") === info.slug,
    );

    let chosen = classic;
    let edition: Precon["edition"] = "classic";
    let note: string | undefined;
    if (collectorSlug) {
      const collector = await readDeck(bySlug.get(collectorSlug)!);
      const classicMisses = await preciseMisses(classic);
      const collectorMisses = await preciseMisses(collector);
      if (signature(collector) !== signature(classic)) {
        note = "Édition collector écartée : ses cartes diffèrent de la version classique.";
      } else if (collectorMisses.length > classicMisses.length) {
        note = `Édition collector écartée : Scryfall ne trouve pas ${collectorMisses.length - classicMisses.length} de ses impressions (${collectorMisses.slice(0, 3).join(" ; ")}).`;
      } else {
        chosen = collector;
        edition = "collector";
      }
      if (note) console.log(`  ${info.slug} : ${note}`);
    }

    const text = deckText(chosen);
    const parsed = parseDeckList(text);
    const { deck, unresolved } = await resolveDeck(parsed, scryfall);
    if (unresolved.length > 0) {
      console.warn(`  ${chosen.slug} : introuvable sur Scryfall → ${unresolved.map((e) => e.name).join(", ")}`);
    }
    precons.push({
      id: chosen.slug,
      name: info.name,
      set: info.setCode,
      setName: info.setName,
      edition,
      url: `${SITE}/deck/${chosen.slug}`,
      commanders: chosen.commanders.map(line),
      cards: chosen.cards.map(line),
      colors: deckColorIdentity(deck),
      issues: { commander: validateCommanderDeck(deck, "commander"), duel: validateCommanderDeck(deck, "duel") },
      ...(note ? { note } : {}),
    });
    console.log(`${precons.length}. ${info.setCode} ${info.name} (${edition})`);
  }

  const file: PreconFile = { generatedAt: new Date().toISOString().slice(0, 10), source: `${SITE}/deck`, decks: precons };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(file, null, 0).replace(/\},\{"id"/g, '},\n{"id"') + "\n");
  console.log(`\n${precons.length} decks écrits dans ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
