import type { CardData, GameModeType } from "../types.js";
import type { ResolvedDeck } from "./resolve.js";

export interface DeckIssue {
  /** "error" empêche de jouer ; "warning" est seulement signalé (parties entre amis). */
  level: "error" | "warning";
  message: string;
}

export const COMMANDER_DECK_SIZE = 100;

/** Liste de bannies à appliquer : Commander multijoueur ou Duel Commander. */
export type DeckFormat = "commander" | "duel";

export function formatForMode(mode: GameModeType): DeckFormat {
  return mode === "duel" ? "duel" : "commander";
}

/** Un deck est légal s'il ne présente aucun problème, même mineur. */
export function isDeckLegal(issues: DeckIssue[]): boolean {
  return issues.length === 0;
}

/** Vérifie les règles de construction Commander (ou Duel Commander). */
export function validateCommanderDeck(deck: ResolvedDeck, format: DeckFormat = "commander"): DeckIssue[] {
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
  if (commanders.length === 2 && !commanders.every(hasPairingAbility) && !isDoctorPair(commanders)) {
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
    const legality = format === "duel" ? card.duelLegality : card.commanderLegality;
    if (legality === "banned") {
      issues.push({
        level: "warning",
        message: `${card.name} est bannie en ${format === "duel" ? "Duel Commander" : "Commander"}.`,
      });
    }
  }

  return issues;
}

function canBeCommander(card: CardData): boolean {
  const type = card.faces?.[0]?.typeLine ?? card.typeLine;
  if (/legendary/i.test(type) && /creature/i.test(type)) return true;
  // Depuis Edge of Eternities (2025) : Véhicules et Vaisseaux légendaires avec force/endurance.
  const power = card.faces?.[0]?.power ?? card.power;
  if (/legendary/i.test(type) && /\b(vehicle|spacecraft)\b/i.test(type) && power !== undefined) return true;
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

/** « Compagnon du Docteur » : la paire est un Docteur Seigneur du Temps et son compagnon. */
function isDoctorPair(commanders: CardData[]): boolean {
  const companion = commanders.findIndex((c) => /doctor's companion/i.test(c.oracleText) || c.keywords.some((k) => /doctor's companion/i.test(k)));
  if (companion < 0) return false;
  const other = commanders[1 - companion]!;
  return /time lord doctor/i.test(other.faces?.[0]?.typeLine ?? other.typeLine);
}

function allowsMultipleCopies(card: CardData): boolean {
  return /\bbasic\b/i.test(card.typeLine) || /a deck can have (any number|up to)/i.test(card.oracleText);
}

/** Légalité d'un deck pour chacun des modes de jeu proposés. */
export function deckLegalityByMode(deck: ResolvedDeck, modes: readonly GameModeType[]): Record<string, DeckIssue[]> {
  const byFormat = new Map<DeckFormat, DeckIssue[]>();
  const result: Record<string, DeckIssue[]> = {};
  for (const mode of modes) {
    const format = formatForMode(mode);
    if (!byFormat.has(format)) byFormat.set(format, validateCommanderDeck(deck, format));
    result[mode] = byFormat.get(format)!;
  }
  return result;
}

const COLOR_ORDER = ["W", "U", "B", "R", "G"];

/** Identité couleur du deck (celle de ses commandants), dans l'ordre WUBRG. */
export function deckColorIdentity(deck: ResolvedDeck): string[] {
  const colors = new Set(deck.commanders.flatMap((c) => c.colorIdentity));
  return COLOR_ORDER.filter((c) => colors.has(c));
}
