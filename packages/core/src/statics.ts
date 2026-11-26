/**
 * Effets statiques des permanents : ce qu'ils changent tant qu'ils sont sur
 * le champ de bataille (mots-clés et bonus donnés par un équipement, une aura
 * ou à toutes ses créatures, réductions de coût, taille de main…).
 *
 * Ce module ne dépend que des types : le combat et les effets le consultent.
 */
import { areTeammates } from "./modes.js";
import { keywordList, oracleLines, selfToTilde } from "./text.js";
import type { CardData, CardInstance, GameState, PlayerId } from "./types.js";

export type StaticAbility =
  /** « You have no maximum hand size. » */
  | { kind: "noMaxHandSize" }
  /** « Your opponents can't gain life. » */
  | { kind: "opponentsCantGainLife" }
  /** « This creature can't block. » (appliqué par le combat) */
  | { kind: "restriction" }
  /** « Black creature spells you cast cost {1} less to cast. » */
  | { kind: "costReduction"; amount: number; colors: string[]; types: string[]; notTypes: string[] }
  /** « Equipped creature has haste and shroud. », « Enchanted creature gets +2/+2. » */
  | { kind: "attached"; keywords: string[]; power: number; toughness: number }
  /** « Creatures you control get +1/+1. », « Other creatures you control have flying. » */
  | { kind: "anthem"; others: boolean; keywords: string[]; power: number; toughness: number }
  /** « ~'s power and toughness are each equal to the number of cards in your hand. » */
  | { kind: "ptEqualsHand" };

const COLOR_WORDS: Record<string, string> = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
const SPELL_TYPES = ["creature", "artifact", "enchantment", "instant", "sorcery", "planeswalker", "battle"];

/** « gets +1/+1 », « has flying », « gets +1/+1 and has flying ». */
function grant(text: string): { keywords: string[]; power: number; toughness: number } | null {
  let power = 0;
  let toughness = 0;
  let keywords: string[] = [];
  let rest = text.trim();
  const pt = /^gets? ([+-]\d+)\/([+-]\d+)(?: and (.+))?$/i.exec(rest);
  if (pt) {
    power = parseInt(pt[1]!, 10);
    toughness = parseInt(pt[2]!, 10);
    rest = pt[3] ?? "";
  }
  if (rest) {
    const has = /^(?:has|have) (.+)$/i.exec(rest);
    if (!has) return null;
    keywords = keywordList(has[1]!);
    if (keywords.some((k) => !/^[a-z]+( [a-z]+)?$/.test(k))) return null;
  }
  return { keywords, power, toughness };
}

/** Lit une ligne d'effet statique (le nom de la carte déjà remplacé par « ~ »). */
export function parseStaticLine(line: string): StaticAbility | null {
  const l = line.replace(/\.$/, "").trim();
  let m: RegExpExecArray | null;
  if (/^you have no maximum hand size$/i.test(l)) return { kind: "noMaxHandSize" };
  if (/^your opponents can't gain life$/i.test(l)) return { kind: "opponentsCantGainLife" };
  if (/^~ can't (attack|block)( or (attack|block))?$/i.test(l)) return { kind: "restriction" };
  if (/^~'s power and toughness are each equal to the number of cards in your hand$/i.test(l)) return { kind: "ptEqualsHand" };
  if ((m = /^((?:white|blue|black|red|green) )?((?:non)?[a-z]+ )?spells you cast cost \{(\d+)\} less to cast$/i.exec(l))) {
    const color = m[1]?.trim().toLowerCase();
    const type = m[2]?.trim().toLowerCase();
    const types: string[] = [];
    const notTypes: string[] = [];
    if (type) {
      const base = type.replace(/^non/, "");
      if (!SPELL_TYPES.includes(base)) return null;
      (type.startsWith("non") ? notTypes : types).push(base);
    }
    return { kind: "costReduction", amount: parseInt(m[3]!, 10), colors: color ? [COLOR_WORDS[color]!] : [], types, notTypes };
  }
  if ((m = /^(?:equipped|enchanted) creature (.+)$/i.exec(l))) {
    const g = grant(m[1]!);
    return g ? { kind: "attached", ...g } : null;
  }
  if ((m = /^(other )?creatures you control (.+)$/i.exec(l))) {
    const g = grant(m[2]!);
    return g ? { kind: "anthem", others: !!m[1], ...g } : null;
  }
  return null;
}

const cache = new Map<string, StaticAbility[]>();

/** Les effets statiques reconnus d'une face. */
export function parseStatics(oracleText: string, cardName: string): StaticAbility[] {
  const key = `${cardName}\u0000${oracleText}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const result: StaticAbility[] = [];
  for (const line of oracleLines(selfToTilde(oracleText, cardName))) {
    const s = parseStaticLine(line);
    if (s) result.push(s);
  }
  cache.set(key, result);
  return result;
}

export function staticsOfData(data: CardData | undefined, faceIndex = 0): StaticAbility[] {
  if (!data) return [];
  const face = data.faces?.[faceIndex];
  return parseStatics(face?.oracleText ?? data.oracleText, face?.name ?? data.name);
}

/** Effets statiques de la face visible d'un permanent. */
export function staticsOf(g: GameState, card: CardInstance): StaticAbility[] {
  if (card.faceDown || card.zone !== "battlefield") return [];
  return staticsOfData(g.cardData[card.cardId], card.faceIndex);
}

function battlefield(g: GameState): CardInstance[] {
  return g.turnOrder.flatMap((id) => g.players[id]!.zones.battlefield).map((id) => g.cards[id]!);
}

/** Ce que les autres permanents donnent à cette créature : mots-clés (minuscules) et bonus. */
export function grantedTo(g: GameState, card: CardInstance): { keywords: string[]; power: number; toughness: number } {
  const out = { keywords: [...(card.grants ?? [])], power: 0, toughness: 0 };
  if (card.zone !== "battlefield") return out;
  for (const other of battlefield(g)) {
    for (const s of staticsOf(g, other)) {
      const applies =
        (s.kind === "attached" && card.instanceId === other.attachedTo) ||
        (s.kind === "anthem" && other.controllerId === card.controllerId && !(s.others && other.instanceId === card.instanceId));
      if (!applies || (s.kind !== "attached" && s.kind !== "anthem")) continue;
      out.keywords.push(...s.keywords);
      out.power += s.power;
      out.toughness += s.toughness;
    }
  }
  return out;
}

/** Un permanent de ce joueur a-t-il cet effet ? */
function controls(g: GameState, playerId: PlayerId, kind: StaticAbility["kind"]): boolean {
  return g.players[playerId]!.zones.battlefield.some((id) => staticsOf(g, g.cards[id]!).some((s) => s.kind === kind));
}

/** Le joueur n'a pas de taille maximale de main. */
export function hasNoMaxHandSize(g: GameState, playerId: PlayerId): boolean {
  return controls(g, playerId, "noMaxHandSize");
}

/** Un adversaire du joueur l'empêche-t-il de gagner des points de vie ? */
export function cantGainLife(g: GameState, playerId: PlayerId): boolean {
  return g.turnOrder.some((id) => id !== playerId && !areTeammates(g, id, playerId) && !g.players[id]!.hasConceded && controls(g, id, "opponentsCantGainLife"));
}

/** Réduction du coût générique d'un sort lancé par ce joueur. */
export function costReduction(g: GameState, playerId: PlayerId, spell: { typeLine: string; colors: string[] }): number {
  let total = 0;
  const type = spell.typeLine.toLowerCase();
  const has = (t: string) => new RegExp(`\\b${t}\\b`).test(type);
  for (const id of g.players[playerId]!.zones.battlefield) {
    for (const s of staticsOf(g, g.cards[id]!)) {
      if (s.kind !== "costReduction") continue;
      if (s.colors.length > 0 && !s.colors.some((c) => spell.colors.includes(c))) continue;
      if (s.types.length > 0 && !s.types.some(has)) continue;
      if (s.notTypes.some(has)) continue;
      total += s.amount;
    }
  }
  return total;
}
