import type { CardData } from "../types.js";
import type { ResolvedDeck } from "./resolve.js";

export interface DeckIssue {
  /** "error" empêche de jouer ; "warning" est seulement signalé (parties entre amis). */
  level: "error" | "warning";
  message: string;
}

export const COMMANDER_DECK_SIZE = 100;

/** Vérifie les règles de construction Commander. */
export function validateCommanderDeck(deck: ResolvedDeck): DeckIssue[] {
  const issues: DeckIssue[] = [];
  const { commanders, cards } = deck;

  if (commanders.length === 0) {
    issues.push({ level: "error", message: "Aucun commandant n'est désigné." });
  } else if (commanders.length > 2) {
    issues.push({ level: "error", message: "Un deck a au plus deux commandants." });
  }

  for (const c of commanders) {
    if (!canBeCommander(c)) {
      issues.push({ level: "warning", message: `${c.name} n'est pas une créature légendaire.` });
    }
  }
  if (commanders.length === 2 && !commanders.every(hasPairingAbility)) {
    issues.push({
      level: "warning",
      message: "Deux commandants nécessitent « Partenaire », « Choisissez un historique » ou une capacité similaire.",
    });
  }

  const total = commanders.length + cards.reduce((n, c) => n + c.quantity, 0);
  if (total !== COMMANDER_DECK_SIZE) {
    issues.push({ level: "warning", message: `Le deck compte ${total} cartes au lieu de ${COMMANDER_DECK_SIZE}.` });
  }

  const copies = new Map<string, { card: CardData; count: number }>();
  for (const { card, quantity } of [...cards, ...commanders.map((card) => ({ card, quantity: 1 }))]) {
    const entry = copies.get(card.oracleId) ?? { card, count: 0 };
    entry.count += quantity;
    copies.set(card.oracleId, entry);
  }
  for (const { card, count } of copies.values()) {
    if (count > 1 && !allowsMultipleCopies(card)) {
      issues.push({ level: "warning", message: `${card.name} est présent en ${count} exemplaires (singleton).` });
    }
  }

  const identity = new Set(commanders.flatMap((c) => c.colorIdentity));
  if (commanders.length > 0) {
    for (const { card } of cards) {
      const outside = card.colorIdentity.filter((color) => !identity.has(color));
      if (outside.length > 0) {
        issues.push({
          level: "warning",
          message: `${card.name} sort de l'identité couleur du commandant (${outside.join("")}).`,
        });
      }
    }
  }

  for (const card of [...commanders, ...cards.map((c) => c.card)]) {
    if (card.commanderLegality === "banned") {
      issues.push({ level: "warning", message: `${card.name} est bannie en Commander.` });
    }
  }

  return issues;
}

function canBeCommander(card: CardData): boolean {
  const type = card.faces?.[0]?.typeLine ?? card.typeLine;
  if (/legendary/i.test(type) && /creature/i.test(type)) return true;
  if (/background/i.test(type)) return true;
  return /can be your commander/i.test(card.oracleText);
}

function hasPairingAbility(card: CardData): boolean {
  return (
    /\bpartner\b/i.test(card.oracleText) ||
    /choose a background/i.test(card.oracleText) ||
    /background/i.test(card.typeLine) ||
    /friends forever/i.test(card.oracleText) ||
    /doctor's companion/i.test(card.oracleText) ||
    card.keywords.some((k) => /partner|friends forever|doctor's companion/i.test(k))
  );
}

function allowsMultipleCopies(card: CardData): boolean {
  return /\bbasic\b/i.test(card.typeLine) || /a deck can have (any number|up to)/i.test(card.oracleText);
}
