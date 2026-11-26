import type { CardData } from "../types.js";
import type { DeckEntry, ParsedDeck } from "./parse.js";
import { identifierKey, type CardIdentifier, type ScryfallClient } from "./scryfall.js";

export interface ResolvedDeck {
  commanders: CardData[];
  cards: { card: CardData; quantity: number }[];
}

export interface ResolveResult {
  deck: ResolvedDeck;
  /** Lignes dont la carte n'a pas été trouvée sur Scryfall. */
  unresolved: DeckEntry[];
}

/**
 * Transforme une liste lue (noms, éditions) en cartes Scryfall complètes.
 * On cherche d'abord l'impression exacte (édition + numéro), puis le nom seul,
 * puis une recherche approximative pour rattraper les petites fautes.
 */
export async function resolveDeck(parsed: ParsedDeck, client: ScryfallClient): Promise<ResolveResult> {
  const entries = [...parsed.commanders, ...parsed.mainboard];
  const preciseId = (e: DeckEntry): CardIdentifier =>
    e.set && e.collectorNumber
      ? { set: e.set, collector_number: e.collectorNumber }
      : e.set
        ? { name: e.name, set: e.set }
        : { name: e.name };

  const resolved = new Map<DeckEntry, CardData>();
  const first = await client.getCollection(entries.map(preciseId));
  const retry: DeckEntry[] = [];
  for (const e of entries) {
    const card = first.found.get(identifierKey(preciseId(e)));
    if (card) resolved.set(e, card);
    else retry.push(e);
  }

  if (retry.length > 0) {
    const second = await client.getCollection(retry.map((e) => ({ name: e.name })));
    for (const e of retry) {
      const card = second.found.get(identifierKey({ name: e.name })) ?? (await client.getByFuzzyName(e.name));
      if (card) resolved.set(e, card);
    }
  }

  const unresolved = entries.filter((e) => !resolved.has(e));
  const commanders = parsed.commanders.flatMap((e) => {
    const card = resolved.get(e);
    return card ? [card] : [];
  });

  const byId = new Map<string, { card: CardData; quantity: number }>();
  for (const e of parsed.mainboard) {
    const card = resolved.get(e);
    if (!card) continue;
    const existing = byId.get(card.id);
    if (existing) existing.quantity += e.quantity;
    else byId.set(card.id, { card, quantity: e.quantity });
  }

  return { deck: { commanders, cards: [...byId.values()] }, unresolved };
}
