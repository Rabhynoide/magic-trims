/**
 * Import direct depuis un lien Archidekt (https://archidekt.com/decks/123456/nom).
 * Archidekt a une API publique en lecture : on récupère le deck en JSON et on le
 * transforme en liste texte, lue ensuite comme un export collé.
 */

export const ARCHIDEKT_API = "https://archidekt.com/api";

/** Numéro du deck si le texte est (seulement) un lien Archidekt. */
export function archidektDeckId(text: string): string | null {
  const m = /^\s*(?:https?:\/\/)?(?:www\.)?archidekt\.com\/(?:api\/)?decks\/(\d+)\b\S*\s*$/i.exec(text);
  return m ? m[1]! : null;
}

/** Champs de l'API Archidekt utilisés (le reste est ignoré). */
export interface ArchidektDeck {
  name?: string;
  categories?: { name: string; includedInDeck?: boolean; isPremier?: boolean }[];
  cards?: {
    quantity: number;
    categories?: string[] | null;
    card?: {
      collectorNumber?: string;
      edition?: { editioncode?: string };
      oracleCard?: { name?: string };
    };
  }[];
}

/** Transforme un deck Archidekt en liste texte (format d'export Archidekt). */
export function archidektToText(deck: ArchidektDeck): string {
  const outside = new Set(
    (deck.categories ?? []).filter((c) => c.includedInDeck === false).map((c) => c.name.toLowerCase()),
  );
  const lines: string[] = [];
  for (const entry of deck.cards ?? []) {
    const name = entry.card?.oracleCard?.name;
    if (!name || !(entry.quantity > 0)) continue;
    const categories = (entry.categories ?? []).map((c) => c.replace(/[[\],{}]/g, ""));
    const tags = categories.map((c) => (outside.has(c.toLowerCase()) ? `${c}{noDeck}` : c));
    const set = entry.card?.edition?.editioncode;
    const num = entry.card?.collectorNumber;
    const printing = set ? ` (${set})${num ? ` ${num}` : ""}` : "";
    lines.push(`${entry.quantity}x ${name}${printing}${tags.length ? ` [${tags.join(",")}]` : ""}`);
  }
  return lines.join("\n");
}

export async function fetchArchidektDeck(
  id: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<{ name: string; text: string }> {
  const response = await fetchFn(`${ARCHIDEKT_API}/decks/${id}/`, { headers: { Accept: "application/json" } });
  if (response.status === 404) throw new Error("Deck Archidekt introuvable (est-il privé ?).");
  if (!response.ok) throw new Error(`Archidekt ne répond pas (${response.status}). Colle plutôt l'export texte.`);
  const deck = (await response.json()) as ArchidektDeck;
  return { name: deck.name ?? "", text: archidektToText(deck) };
}
