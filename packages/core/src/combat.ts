/**
 * Combat : caractéristiques des créatures et mots-clés reconnus par le moteur.
 * Fonctions pures, sans modification de la partie.
 */
import type { CardInstance, CardInstanceId, GameState, PlayerId } from "./types.js";

export interface CombatState {
  /** Les attaquants ont été déclarés (même aucun). */
  attackersDeclared: boolean;
  /** Attaquant → joueur attaqué. */
  attackers: Record<CardInstanceId, PlayerId>;
  /** Bloqueur → attaquant bloqué. */
  blockers: Record<CardInstanceId, CardInstanceId>;
  /** Attaquants bloqués au moment de la déclaration (restent bloqués même si le bloqueur disparaît). */
  blocked: CardInstanceId[];
  /** Joueurs attaqués qui ont déclaré leurs bloqueurs (même aucun). */
  blocksDeclared: PlayerId[];
}

/** Mots-clés de combat gérés par le moteur (noms anglais de Scryfall). */
export const COMBAT_KEYWORDS = [
  "Flying",
  "Reach",
  "Vigilance",
  "Haste",
  "First strike",
  "Double strike",
  "Deathtouch",
  "Lifelink",
  "Trample",
  "Menace",
  "Infect",
  "Wither",
  "Defender",
  "Indestructible",
] as const;
export type CombatKeyword = (typeof COMBAT_KEYWORDS)[number];

function faceOf(g: GameState, card: CardInstance) {
  const data = g.cardData[card.cardId];
  const face = data?.faces?.[card.faceIndex];
  return {
    typeLine: face?.typeLine ?? data?.typeLine ?? "",
    oracleText: face?.oracleText ?? data?.oracleText ?? "",
    power: face?.power ?? data?.power,
    toughness: face?.toughness ?? data?.toughness,
  };
}

export function isCreature(g: GameState, card: CardInstance): boolean {
  return !card.faceDown ? /\bCreature\b/.test(faceOf(g, card).typeLine) : true;
}

/**
 * La carte a-t-elle ce mot-clé ? On regarde la liste de Scryfall et le texte
 * de la face visible (« Flying », « Flying, vigilance »…).
 */
export function hasKeyword(g: GameState, card: CardInstance, keyword: CombatKeyword): boolean {
  if (card.faceDown) return false;
  const data = g.cardData[card.cardId];
  const listed = (data?.keywords ?? []).some((k) => k.toLowerCase() === keyword.toLowerCase());
  // Pour une carte double face, la liste de Scryfall couvre les deux faces : on vérifie le texte de la face visible.
  if (listed && !(data?.faces && data.faces.length > 1)) return true;
  const text = faceOf(g, card).oracleText;
  return text.split("\n").some((line) => {
    const clean = line.replace(/\([^)]*\)/g, "").trim();
    return clean.split(/,\s*/).some((part) => part.toLowerCase() === keyword.toLowerCase());
  });
}

function toNumber(value: string | undefined): number {
  const n = parseInt(value ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

/** Force et endurance actuelles : la carte, ses marqueurs +1/+1 et -1/-1, et les bonus jusqu'à la fin du tour. */
export function creatureStats(g: GameState, card: CardInstance): { power: number; toughness: number } {
  if (card.faceDown) return { power: 2, toughness: 2 };
  const face = faceOf(g, card);
  const plus = card.counters["+1/+1"] ?? 0;
  const minus = card.counters["-1/-1"] ?? 0;
  return {
    power: toNumber(face.power) + plus - minus + (card.ptBoost?.power ?? 0),
    toughness: toNumber(face.toughness) + plus - minus + (card.ptBoost?.toughness ?? 0),
  };
}

/** Blessures qu'il faut encore infliger pour détruire la créature. */
export function lethalDamage(g: GameState, card: CardInstance, sourceHasDeathtouch: boolean): number {
  const remaining = Math.max(0, creatureStats(g, card).toughness - (card.damage ?? 0));
  return sourceHasDeathtouch ? Math.min(1, remaining) : remaining;
}

/** La créature a-t-elle reçu des blessures mortelles (ou une endurance nulle) ? */
export function hasLethalDamage(g: GameState, card: CardInstance): boolean {
  const { toughness } = creatureStats(g, card);
  if (toughness <= 0) return true;
  if (hasKeyword(g, card, "Indestructible")) return false;
  return (card.damage ?? 0) >= toughness || (card.deathtouched === true && (card.damage ?? 0) > 0);
}
