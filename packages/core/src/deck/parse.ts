/**
 * Lecture d'une liste de deck exportée depuis Moxfield, deckstats.net ou un autre site.
 *
 * Moxfield n'a pas d'API publique officielle : on importe le texte obtenu avec
 * « Export » → « Copy for Moxfield / MTGO / Arena » ou « Download as text ».
 * Formats reconnus :
 *
 *   1 Sol Ring (C21) 263
 *   1x Atraxa, Praetors' Voice (C16) 28 *F*
 *   Arena : sections « Commander » / « Deck » / « Sideboard »
 *   MTGO : commandant isolé après une ligne vide à la fin de la liste
 *   deckstats.net : « 1 [C21#263] Sol Ring », commandant marqué « # !Commander »,
 *                   sections « //Main », « //Sideboard »
 */

export interface DeckEntry {
  quantity: number;
  name: string;
  set?: string;
  collectorNumber?: string;
  /** Numéro de ligne dans le texte d'origine (pour les messages d'erreur). */
  line: number;
}

export interface ParsedDeck {
  commanders: DeckEntry[];
  mainboard: DeckEntry[];
  /** Sideboard, maybeboard… : ignorés en partie mais conservés. */
  other: DeckEntry[];
  /** Lignes qui n'ont pas pu être lues. */
  errors: { line: number; text: string }[];
}

type Section = "commander" | "main" | "other";

const SECTION_HEADERS: [RegExp, Section][] = [
  [/^(commanders?|commandant|commandants)\b/i, "commander"],
  [/^(deck|main|mainboard|main deck|bibliothèque)\b/i, "main"],
  [/^(sideboard|maybeboard|considering|companion|compagnon|tokens?|attractions?|stickers?)\b/i, "other"],
];

/** Format deckstats.net : édition (et numéro) entre crochets avant le nom. */
const DECKSTATS_RE = /^(?<qty>\d+)\s*x?\s+\[(?<set>[A-Za-z0-9]{2,6})(?:#(?<num>[^\]]+))?\]\s+(?<name>.+)$/;

const LINE_RE =
  /^(?<qty>\d+)\s*x?\s+(?<name>.+?)(?:\s+\((?<set>[A-Za-z0-9]{2,6})\)(?:\s+(?<num>[^\s*]+))?)?(?:\s+\*[A-Z]+\*)*\s*$/;

export function parseDeckList(text: string): ParsedDeck {
  const result: ParsedDeck = { commanders: [], mainboard: [], other: [], errors: [] };
  // Blocs séparés par des lignes vides, pour l'heuristique MTGO.
  const blocks: { section: Section | null; entries: DeckEntry[] }[] = [];
  let current: { section: Section | null; entries: DeckEntry[] } = { section: null, entries: [] };
  let sawHeader = false;

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (line === "" ) {
      if (current.entries.length > 0) {
        blocks.push(current);
        current = { section: current.section, entries: [] };
      }
      return;
    }
    const isComment = line.startsWith("//") || line.startsWith("#");

    // « SIDEBOARD: », « Commander » ou « //Main » seul sur la ligne.
    const header = line
      .replace(/^(\/\/|#)\s*/, "")
      .replace(/:$/, "")
      .replace(/\s*\(\d+\)$/, "");
    const matched = SECTION_HEADERS.find(([re]) => re.test(header) && !/^\d/.test(header) && header.split(/\s+/).length <= 2);
    if (matched) {
      if (current.entries.length > 0) blocks.push(current);
      current = { section: matched[1], entries: [] };
      sawHeader = true;
      return;
    }
    if (isComment) return;

    // Sideboard au format MTGO : « SB: 1 Carte ».
    let body = line;
    let forced: Section | null = null;
    if (/^SB:\s*/i.test(body)) {
      body = body.replace(/^SB:\s*/i, "");
      forced = "other";
    }
    // Commentaire en fin de ligne (deckstats) : « # !Commander » désigne le commandant.
    const comment = /\s#\s*(.*)$/.exec(body);
    if (comment) {
      if (/!commander/i.test(comment[1]!)) forced = "commander";
      body = body.slice(0, comment.index).trim();
    }

    const m = DECKSTATS_RE.exec(body) ?? LINE_RE.exec(body);
    if (!m?.groups) {
      result.errors.push({ line: lineNo, text: raw });
      return;
    }
    const entry: DeckEntry = {
      quantity: Number(m.groups.qty),
      name: normalizeName(m.groups.name!),
      line: lineNo,
    };
    if (m.groups.set) entry.set = m.groups.set.toLowerCase();
    if (m.groups.num) entry.collectorNumber = m.groups.num;
    if (entry.quantity < 1) {
      result.errors.push({ line: lineNo, text: raw });
      return;
    }
    if (forced === "commander") {
      result.commanders.push(entry);
      sawHeader = true;
    } else if (forced === "other") {
      result.other.push(entry);
    } else {
      current.entries.push(entry);
    }
  });
  if (current.entries.length > 0) blocks.push(current);

  // Format MTGO : pas d'en-tête, le commandant est seul dans le dernier bloc.
  if (!sawHeader && blocks.length >= 2) {
    const last = blocks[blocks.length - 1]!;
    const count = last.entries.reduce((n, e) => n + e.quantity, 0);
    if (count <= 2) last.section = "commander";
  }

  for (const block of blocks) {
    const target =
      block.section === "commander" ? result.commanders : block.section === "other" ? result.other : result.mainboard;
    target.push(...block.entries);
  }
  return result;
}

function normalizeName(name: string): string {
  // Moxfield écrit les cartes double face « Recto / Verso » ; Scryfall attend « Recto // Verso ».
  return name.replace(/\s+\/\/?\s+/g, " // ").trim();
}
