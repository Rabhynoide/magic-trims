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
  if (commanders.length === 2) {
    const problem = pairingProblem(commanders[0]!, commanders[1]!);
    if (problem) issues.push({ level: "warning", message: problem });
  } else if (commanders.length === 1 && isBackground(commanders[0]!)) {
    issues.push({
      level: "warning",
      message: `${commanders[0]!.name} est un Historique : il accompagne un commandant avec « Choisissez un historique ».`,
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

/** Capacités qui permettent d'avoir deux commandants (règles 702.124, 702.172, 702.124i…). */
interface Pairing {
  /** « Partner » seul. */
  partner: boolean;
  /** « Partner with [nom] » : le nom du partenaire désigné. */
  partnerWith?: string;
  /** « Partner—[genre] » (Survivants, Père et fils…) : le genre, en minuscules. */
  partnerKind?: string;
  friendsForever: boolean;
  chooseBackground: boolean;
  doctorsCompanion: boolean;
}

/** Lignes de texte Oracle sans texte de rappel (une capacité par ligne). */
function oracleLines(card: CardData): string[] {
  const text = card.faces?.[0]?.oracleText ?? card.oracleText;
  return text
    .split("\n")
    .map((l) => l.replace(/\([^)]*\)/g, "").trim())
    .filter(Boolean);
}

export function pairingOf(card: CardData): Pairing {
  const result: Pairing = { partner: false, friendsForever: false, chooseBackground: false, doctorsCompanion: false };
  for (const line of oracleLines(card)) {
    let m: RegExpMatchArray | null;
    if (/^partner$/i.test(line)) result.partner = true;
    else if ((m = line.match(/^partner with (.+?)\.?$/i))) result.partnerWith = m[1]!.trim();
    else if ((m = line.match(/^partner\s*[—–-]\s*(.+?)\.?$/i))) result.partnerKind = m[1]!.trim().toLowerCase();
    else if (/^friends forever$/i.test(line)) result.friendsForever = true;
    else if (/^choose a background$/i.test(line)) result.chooseBackground = true;
    else if (/^doctor's companion$/i.test(line)) result.doctorsCompanion = true;
  }
  // Repli sur les mots-clés Scryfall si le texte est absent ou traduit.
  for (const k of card.keywords) {
    if (/^partner$/i.test(k) && !result.partnerWith && !result.partnerKind) result.partner = true;
    if (/^friends forever$/i.test(k)) result.friendsForever = true;
    if (/^doctor's companion$/i.test(k)) result.doctorsCompanion = true;
  }
  return result;
}

function isBackground(card: CardData): boolean {
  return /\bbackground\b/i.test(card.faces?.[0]?.typeLine ?? card.typeLine);
}

function isTimeLordDoctor(card: CardData): boolean {
  return /time lord doctor/i.test(card.faces?.[0]?.typeLine ?? card.typeLine);
}

function sameName(card: CardData, name: string): boolean {
  const n = name.toLowerCase();
  return card.name.toLowerCase() === n || (card.faces ?? []).some((f) => f.name?.toLowerCase() === n);
}

/** Les deux cartes peuvent-elles être commandants ensemble ? Sinon, pourquoi. */
function pairingProblem(a: CardData, b: CardData): string | null {
  const pa = pairingOf(a);
  const pb = pairingOf(b);
  if (pa.partner && pb.partner) return null;
  if (pa.friendsForever && pb.friendsForever) return null;
  if (pa.partnerKind && pa.partnerKind === pb.partnerKind) return null;
  if ((pa.chooseBackground && isBackground(b)) || (pb.chooseBackground && isBackground(a))) return null;
  if ((pa.doctorsCompanion && isTimeLordDoctor(b)) || (pb.doctorsCompanion && isTimeLordDoctor(a))) return null;
  if (pa.partnerWith || pb.partnerWith) {
    if (pa.partnerWith && pb.partnerWith && sameName(b, pa.partnerWith) && sameName(a, pb.partnerWith)) return null;
    const [card, p] = pa.partnerWith ? [a, pa] : [b, pb];
    return `${card.name} ne peut faire équipe qu'avec ${p.partnerWith} (« Partenaire avec »).`;
  }
  if (pa.partnerKind || pb.partnerKind) {
    return `${a.name} et ${b.name} n'ont pas la même capacité « Partenaire — … ».`;
  }
  if (pa.chooseBackground || pb.chooseBackground) {
    const other = pa.chooseBackground ? b : a;
    return `${other.name} n'est pas un Historique (« Choisissez un historique »).`;
  }
  if (pa.doctorsCompanion || pb.doctorsCompanion) {
    const other = pa.doctorsCompanion ? b : a;
    return `${other.name} n'est pas un Docteur Seigneur du Temps (« Compagnon du Docteur »).`;
  }
  const any = (p: Pairing) => p.partner || p.friendsForever;
  if (any(pa) && any(pb)) return "« Partenaire » et « Amis pour toujours » ne se combinent pas entre eux.";
  if (any(pa) !== any(pb)) {
    const missing = any(pa) ? b : a;
    return `${missing.name} n'a pas « Partenaire » : les deux commandants doivent l'avoir.`;
  }
  return "Deux commandants nécessitent « Partenaire », « Choisissez un historique » ou une capacité similaire.";
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
