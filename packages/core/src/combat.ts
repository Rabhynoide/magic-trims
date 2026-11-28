/**
 * Combat : caractéristiques des créatures et mots-clés reconnus par le moteur.
 * Fonctions pures, sans modification de la partie.
 */
import { CANT_BE_BLOCKED, countValue, creaturesCantAttack, grantedTo, selfStats, staticsOf } from "./statics.js";
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

/** Mots-clés gérés par le moteur (noms anglais de Scryfall). */
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
  "Hexproof",
  "Shroud",
  "Fear",
  "Skulk",
] as const;

const COLOR_NAMES: Record<string, string> = { white: "W", blue: "U", black: "B", red: "R", green: "G" };

/** « Protection from white and from black » : les couleurs dont le permanent est protégé. */
export function protectionColors(g: GameState, card: CardInstance): string[] {
  if (card.faceDown) return [];
  const colors: string[] = [];
  for (const line of faceOf(g, card).oracleText.split("\n")) {
    const clean = line.replace(/\([^)]*\)/g, "").trim();
    if (!/^Protection from /i.test(clean)) continue;
    for (const m of clean.matchAll(/\bfrom (white|blue|black|red|green)\b/gi)) colors.push(COLOR_NAMES[m[1]!.toLowerCase()]!);
  }
  // Protection gagnée (Akroma's Will : « protection from each color until end of turn »).
  for (const k of grantedTo(g, card).keywords) {
    if (k === "protection from each color") colors.push(...Object.values(COLOR_NAMES));
    else if (/^protection from (white|blue|black|red|green)$/.test(k)) colors.push(COLOR_NAMES[k.slice("protection from ".length)]!);
  }
  return colors;
}

/** Couleurs d'un permanent (ou d'une carte). */
export function colorsOf(g: GameState, card: CardInstance): string[] {
  if (card.faceDown) return [];
  return g.cardData[card.cardId]?.colors ?? [];
}

/** Le permanent est-il protégé de cette source ? */
export function protectedFrom(g: GameState, card: CardInstance, sourceColors: string[]): boolean {
  const prot = protectionColors(g, card);
  return prot.length > 0 && sourceColors.some((c) => prot.includes(c));
}
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
  if (grantedTo(g, card).keywords.includes(keyword.toLowerCase())) return true;
  const data = g.cardData[card.cardId];
  const listed = (data?.keywords ?? []).some((k) => k.toLowerCase() === keyword.toLowerCase());
  // Pour une carte double face, la liste de Scryfall couvre les deux faces : on vérifie le texte de la face visible.
  if (listed && !(data?.faces && data.faces.length > 1)) return true;
  const text = faceOf(g, card).oracleText;
  return text.split("\n").some((line) => {
    const clean = line.replace(/\([^)]*\)/g, "").trim();
    // Une ligne de mots-clés n'est pas une phrase (Odric cite « trample » dans une phrase).
    if (clean.includes(".")) return false;
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
  const granted = grantedTo(g, card);
  // « Sa force et son endurance sont égales au nombre de … » ; Faeburrow Elder, Sisay : +1/+1 pour chaque …
  const self = selfStats(g, card);
  return {
    power: (self.base ?? toNumber(face.power)) + plus - minus + (card.ptBoost?.power ?? 0) + granted.power + self.power,
    toughness: (self.base ?? toNumber(face.toughness)) + plus - minus + (card.ptBoost?.toughness ?? 0) + granted.toughness + self.toughness,
  };
}

/** L'endurance imprimée est-elle un nombre (et non « * » ou absente) ? */
export function hasKnownToughness(g: GameState, card: CardInstance): boolean {
  return card.faceDown || /^-?\d+$/.test(faceOf(g, card).toughness ?? "") || staticsOf(g, card).some((s) => s.kind === "ptEquals");
}

/** Blessures qu'il faut encore infliger pour détruire la créature. */
export function lethalDamage(g: GameState, card: CardInstance, sourceHasDeathtouch: boolean): number {
  const remaining = Math.max(0, creatureStats(g, card).toughness - (card.damage ?? 0));
  return sourceHasDeathtouch ? Math.min(1, remaining) : remaining;
}

/** La créature a-t-elle reçu des blessures mortelles (ou une endurance nulle) ? */
export function hasLethalDamage(g: GameState, card: CardInstance): boolean {
  // Endurance inconnue (« * », données manquantes) : on laisse les joueurs gérer à la main.
  if (!hasKnownToughness(g, card)) return false;
  const { toughness } = creatureStats(g, card);
  if (toughness <= 0) return true;
  if (hasKeyword(g, card, "Indestructible")) return false;
  return (card.damage ?? 0) >= toughness || (card.deathtouched === true && (card.damage ?? 0) > 0);
}

/**
 * « ~ can't block », « ~ can't attack or block unless you control three or more creatures » (Bast) : la
 * restriction s'applique-t-elle maintenant ?
 */
function hasRestriction(g: GameState, card: CardInstance, what: "attack" | "block"): boolean {
  return staticsOf(g, card).some((s) => s.kind === "restriction" && s[what] === true && !(s.unless && countValue(g, s.unless.count, card) >= s.unless.min));
}

/** « This creature can't block. » */
export function cantBlock(g: GameState, card: CardInstance): boolean {
  return hasRestriction(g, card, "block");
}

/** « This creature can't attack. » */
export function cantAttack(g: GameState, card: CardInstance): boolean {
  return hasRestriction(g, card, "attack") || creaturesCantAttack(g, card.controllerId);
}

/**
 * La créature ne peut pas être bloquée par ce bloqueur : « ~ can't be blocked » (éventuellement « by creatures with
 * power 2 or less »), ou donné par un équipement ou un effet (Whispersilk Cloak, « can't be blocked this turn »).
 */
export function unblockableBy(g: GameState, attacker: CardInstance, blocker?: CardInstance): boolean {
  if (grantedTo(g, attacker).keywords.includes(CANT_BE_BLOCKED)) return true;
  return staticsOf(g, attacker).some((s) => {
    if (s.kind !== "cantBeBlocked") return false;
    if (!s.by) return true;
    if (!blocker) return false;
    const v = creatureStats(g, blocker)[s.by.stat];
    return s.by.cmp === "le" ? v <= s.by.n : v >= s.by.n;
  });
}

/**
 * Pourquoi la créature ne peut pas attaquer ce joueur, ou null : Queen Mother Ramonda (« As long as you're the
 * monarch, creatures with power 2 or less can't attack you »).
 */
export function cantAttackPlayer(g: GameState, card: CardInstance, defenderId: PlayerId): string | null {
  const defender = g.players[defenderId];
  if (!defender) return null;
  const power = creatureStats(g, card).power;
  for (const id of defender.zones.battlefield) {
    const source = g.cards[id]!;
    for (const s of staticsOf(g, source)) {
      if (s.kind !== "cantAttackYou" || power > s.maxPower) continue;
      if (s.monarch && monarchOf(g) !== defenderId) continue;
      const data = g.cardData[source.cardId];
      return `${data?.name ?? "Un permanent"} : les créatures de force ${s.maxPower} ou moins ne peuvent pas attaquer ${defender.name}.`;
    }
  }
  return null;
}

/** Le monarque de la partie (champ posé par la gestion du monarque), ou undefined. */
function monarchOf(g: GameState): PlayerId | undefined {
  return (g as GameState & { monarch?: PlayerId | null }).monarch ?? undefined;
}

/** La créature peut-elle attaquer maintenant (dégagée, sans mal d'invocation, sans défenseur) ? */
export function canAttack(g: GameState, card: CardInstance): boolean {
  return (
    card.zone === "battlefield" &&
    isCreature(g, card) &&
    !card.tapped &&
    (!card.summoningSick || hasKeyword(g, card, "Haste")) &&
    !hasKeyword(g, card, "Defender") &&
    !cantAttack(g, card)
  );
}

/** La créature peut-elle bloquer cet attaquant ? Sans attaquant : peut-elle bloquer tout court ? */
export function canBlock(g: GameState, card: CardInstance, attacker?: CardInstance): boolean {
  if (card.zone !== "battlefield" || !isCreature(g, card) || card.tapped || cantBlock(g, card)) return false;
  if (!attacker) return true;
  if (unblockableBy(g, attacker, card)) return false;
  if (hasKeyword(g, attacker, "Flying") && !hasKeyword(g, card, "Flying") && !hasKeyword(g, card, "Reach")) return false;
  // Peur : seulement par des créatures-artefacts et/ou noires.
  if (hasKeyword(g, attacker, "Fear") && !colorsOf(g, card).includes("B") && !/\bArtifact\b/.test(faceOf(g, card).typeLine)) return false;
  // Rôder : pas par des créatures de plus grande force.
  if (hasKeyword(g, attacker, "Skulk") && creatureStats(g, card).power > creatureStats(g, attacker).power) return false;
  if (protectedFrom(g, attacker, colorsOf(g, card))) return false;
  return true;
}
