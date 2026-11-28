import { cardSupport, type CardSupport, type SupportCardData } from "../effects.js";
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
  return cardsSupport([...deck.commanders.map((card) => ({ card, quantity: 1 })), ...deck.cards]);
}

/**
 * Même calcul pour une simple liste de cartes (nom, type et texte Oracle
 * suffisent). `levels` garde le niveau de chaque carte d'un appel à l'autre,
 * pour ne pas relire le texte d'une carte présente dans plusieurs decks.
 */
export function cardsSupport(
  entries: { card: SupportCardData; quantity: number }[],
  levels: Map<string, CardSupport["level"]> = new Map(),
): DeckSupport {
  const result: DeckSupport = { total: 0, full: 0, partial: 0, manual: 0, partialNames: [], manualNames: [] };
  const seen = new Set<string>();
  for (const { card, quantity } of entries) {
    let level = levels.get(card.name);
    if (!level) {
      level = cardSupport(card).level;
      levels.set(card.name, level);
    }
    if (!seen.has(card.name)) {
      seen.add(card.name);
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
