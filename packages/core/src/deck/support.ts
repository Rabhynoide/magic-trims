import { cardSupport } from "../effects.js";
import type { CardData } from "../types.js";
import type { ResolvedDeck } from "./resolve.js";

/**
 * Ce que le moteur gère d'un deck entier, carte par carte (exemplaires
 * compris, commandants inclus), d'après la même analyse du texte Oracle que
 * les pastilles « non géré » de la table.
 */
export interface DeckSupport {
  /** Nombre total de cartes (exemplaires compris). */
  total: number;
  /** Cartes entièrement gérées par le moteur. */
  full: number;
  /** Cartes dont une partie seulement est gérée. */
  partial: number;
  /** Cartes que le moteur ne gère pas du tout (à jouer à la main). */
  manual: number;
  /** Noms des cartes gérées en partie (une fois chacune). */
  partialNames: string[];
  /** Noms des cartes à jouer à la main (une fois chacune). */
  manualNames: string[];
}

export function deckSupport(deck: ResolvedDeck): DeckSupport {
  const result: DeckSupport = { total: 0, full: 0, partial: 0, manual: 0, partialNames: [], manualNames: [] };
  const entries: { card: CardData; quantity: number }[] = [
    ...deck.commanders.map((card) => ({ card, quantity: 1 })),
    ...deck.cards,
  ];
  const cache = new Map<string, ReturnType<typeof cardSupport>["level"]>();
  for (const { card, quantity } of entries) {
    let level = cache.get(card.name);
    if (!level) {
      level = cardSupport(card).level;
      cache.set(card.name, level);
      if (level === "partial") result.partialNames.push(card.name);
      if (level === "manual") result.manualNames.push(card.name);
    }
    result.total += quantity;
    result[level] += quantity;
  }
  return result;
}

/** Part des cartes entièrement gérées, en pour cent arrondi (null pour un deck vide). */
export function deckSupportPercent(s: DeckSupport): number | null {
  return s.total === 0 ? null : Math.floor((s.full / s.total) * 100);
}
