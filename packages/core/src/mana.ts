/**
 * Mana : réserve des joueurs et capacités de mana des cartes (règle 106).
 */

export const MANA_TYPES = ["W", "U", "B", "R", "G", "C"] as const;
export type ManaType = (typeof MANA_TYPES)[number];
export type ManaPool = Record<ManaType, number>;

export const MANA_LABELS: Record<ManaType, string> = {
  W: "blanc",
  U: "bleu",
  B: "noir",
  R: "rouge",
  G: "vert",
  C: "incolore",
};

export function emptyPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

export function isManaType(value: unknown): value is ManaType {
  return typeof value === "string" && (MANA_TYPES as readonly string[]).includes(value);
}

/** Écrit du mana sous forme de symboles : {G}{G}{C}. */
export function formatMana(mana: ManaType[]): string {
  return mana.map((m) => `{${m}}`).join("");
}

const BASIC_LAND_TYPES: Record<string, ManaType> = {
  Plains: "W",
  Island: "U",
  Swamp: "B",
  Mountain: "R",
  Forest: "G",
};

/**
 * Ce qu'une carte peut produire en s'engageant, sans autre coût : une liste
 * de choix, chacun étant le mana ajouté. Vide si le moteur ne reconnaît pas
 * de capacité de mana (le joueur ajoute alors son mana à la main).
 *
 * Exemples : Forêt → [[G]] ; Sol Ring → [[C, C]] ; Karplusan Forest →
 * [[C], [R], [G]] ; Command Tower → les cinq couleurs.
 */
export function manaOptions(typeLine: string, oracleText: string): ManaType[][] {
  return manaOptionsDetailed(typeLine, oracleText).map((o) => o.mana);
}

/** Restriction d'un mana : seulement pour les sorts (et capacités) d'un type de créature, ou du type choisi. */
export interface ManaRestriction {
  /** Un type de créature, ou « chosen » : le type choisi en arrivant. */
  subtype: string;
  /** Aussi pour activer les capacités de ces sources. */
  abilities: boolean;
  /** Aussi pour activer n'importe quelle capacité (Vibranium : « can't be spent to cast a nonartifact spell »). */
  anyAbility?: boolean;
}

/** Les choix de mana d'une carte, avec leur restriction (Primal Beyond, Smokebraider, Secluded Courtyard). */
export function manaOptionsDetailed(typeLine: string, oracleText: string): { mana: ManaType[]; only?: ManaRestriction }[] {
  const options: { mana: ManaType[]; only?: ManaRestriction }[] = [];
  let only: ManaRestriction | undefined;
  const add = (mana: ManaType[]) => {
    if (mana.length > 0 && !options.some((o) => o.mana.join() === mana.join() && !!o.only === !!only)) options.push({ mana, ...(only ? { only } : {}) });
  };

  // Types de terrain de base : capacité intrinsèque (règle 305.6).
  const subtypes = typeLine.split("—")[1] ?? "";
  for (const [type, mana] of Object.entries(BASIC_LAND_TYPES)) {
    if (new RegExp(`\\b${type}\\b`).test(subtypes)) add([mana]);
  }
  if (/\bWastes\b/.test(typeLine) && /\bBasic\b/.test(typeLine)) add(["C"]);

  for (const raw of oracleText.split("\n")) {
    const line = raw.replace(/^\(|\)$/g, "").trim();
    const match = /^\{T\}: Add ([^.]+)\./.exec(line);
    if (!match) continue;
    const effect = match[1]!.trim();
    only = manaRestriction(line);
    if (/^two mana in any combination of colors$/i.test(effect)) {
      const colors = ["W", "U", "B", "R", "G"] as const;
      colors.forEach((a, i) => colors.slice(i).forEach((b) => add([a, b])));
      continue;
    }
    if (/^one mana of any color\b/i.test(effect)) {
      for (const m of ["W", "U", "B", "R", "G"] as const) add([m]);
      continue;
    }
    // « three mana of any one color » (Somberwald Sage) : n fois la même couleur.
    const same = /^(two|three|four|five) mana of any one color$/i.exec(effect);
    if (same) {
      const n = NUMBER_WORDS[same[1]!.toLowerCase()]!;
      for (const m of ["W", "U", "B", "R", "G"] as const) add(Array<ManaType>(n).fill(m));
      continue;
    }
    // « {R} or {G} », « {W}, {U}, or {B} » : un choix par groupe de symboles.
    for (const part of effect.split(/,? or |, /)) {
      const symbols = [...part.matchAll(/\{([WUBRGC])\}/g)].map((m) => m[1] as ManaType);
      if (symbols.length > 0 && /^(\{[WUBRGC]\})+$/.test(part.trim())) add(symbols);
    }
  }
  return options;
}

const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };

/**
 * Capacité de mana donnée à d'autres permanents : « Lands you control have
 * "{T}: Add one mana of any color." » (Chromatic Lantern), « Enchanted land
 * has "…" » (Abundant Growth), « Creatures you control have "…" ».
 */
export interface GrantedManaAbility {
  /** « enchanted » : le permanent enchanté ; sinon un type de carte (Land, Creature…) parmi les permanents du contrôleur. */
  to: "enchanted" | "Land" | "Creature" | "Artifact" | "permanent";
  /** La capacité donnée, telle quelle (« {T}: Add one mana of any color. »). */
  ability: string;
}

export function grantedManaAbility(line: string): GrantedManaAbility | null {
  const m =
    /^(Lands|Creatures|Artifacts|Permanents) you control have "(\{T\}: Add [^"]+)"\.?$/i.exec(line.trim()) ??
    /^(Enchanted) (?:land|creature|artifact|permanent) has "(\{T\}: Add [^"]+)"\.?$/i.exec(line.trim());
  if (!m) return null;
  const ability = m[2]!;
  if (manaOptions("", ability).length === 0) return null;
  const word = m[1]!.toLowerCase();
  const to = word === "enchanted" ? "enchanted" : word === "permanents" ? "permanent" : ((word.charAt(0).toUpperCase() + word.slice(1, -1)) as "Land" | "Creature" | "Artifact");
  return { to, ability };
}

/**
 * Ce qui se passe quand on engage un permanent pour du mana (capacités de
 * mana déclenchées et remplacements, règle 605.1b et 106.12) :
 * - Mirari's Wake, Zendikar Resurgent : « Whenever you tap a land for mana,
 *   add one mana of any type that land produced. » ;
 * - Mana Flare, Heartbeat of Spring : « Whenever a player taps a land for
 *   mana, that player adds one mana of any type that land produced. » ;
 * - Crypt Ghast : « Whenever you tap a Swamp for mana, add an additional {B}. » ;
 * - Mana Reflection, Nyxbloom Ancient : « If you tap a permanent for mana, it
 *   produces twice (three times) as much of that mana instead. »
 */
export interface ManaTapEffect {
  /** « you » : seulement le contrôleur de la carte ; « player » : tout joueur. */
  who: "you" | "player";
  /** Ce qui est engagé : un type de carte (Land, Creature), « permanent », ou un sous-type (Swamp). */
  source: string;
  /** Mana en plus : un du type produit, un mana donné, ou le total multiplié. */
  add: { kind: "sameType" } | { kind: "mana"; mana: ManaType } | { kind: "multiply"; factor: number };
}

export function manaTapEffect(line: string): ManaTapEffect | null {
  const text = line.trim();
  const source = (word: string) => {
    const w = word.toLowerCase();
    return w === "land" || w === "creature" || w === "artifact" ? w.charAt(0).toUpperCase() + w.slice(1) : w === "permanent" ? "permanent" : word;
  };
  let m = /^Whenever (you|a player) taps? an? (\w+) for mana, (?:that player )?adds? (?:one|an additional one) (?:additional )?mana of any type that \w+ produced\.$/i.exec(text);
  if (m) return { who: m[1]!.toLowerCase() === "you" ? "you" : "player", source: source(m[2]!), add: { kind: "sameType" } };
  m = /^Whenever (you|a player) taps? an? (\w+) for mana, (?:that player )?adds? (?:an|one) additional \{([WUBRGC])\}\.$/i.exec(text);
  if (m) return { who: m[1]!.toLowerCase() === "you" ? "you" : "player", source: source(m[2]!), add: { kind: "mana", mana: m[3] as ManaType } };
  m = /^If you tap an? (\w+) for mana, it produces (twice|three times) as much of that mana instead\.$/i.exec(text);
  if (m) return { who: "you", source: source(m[1]!), add: { kind: "multiply", factor: m[2]!.toLowerCase() === "twice" ? 2 : 3 } };
  return null;
}

/** Le permanent engagé (sa ligne de type) est-il concerné par cet effet ? */
export function manaTapSourceFits(effect: ManaTapEffect, typeLine: string): boolean {
  if (effect.source === "permanent") return true;
  return new RegExp(`\\b${effect.source}\\b`, "i").test(typeLine);
}

/** « Spend this mana only to cast an Elemental spell or activate an ability of an Elemental. » */
function manaRestriction(line: string): ManaRestriction | undefined {
  // « This mana can't be spent to cast a nonartifact spell » (jeton Vibranium) : les sorts d'artefact, et toute capacité.
  const not = /This mana can't be spent to cast (?:a |an )?non(\w+) spells?/i.exec(line);
  if (not) return { subtype: not[1]!.charAt(0).toUpperCase() + not[1]!.slice(1).toLowerCase(), abilities: true, anyAbility: true };
  const m = /Spend this mana only to cast (?:an? )?(?:creature spells? of the chosen type|(\w+) spells?)( or activate (?:an )?abilit(?:y|ies) of)?/i.exec(line);
  if (!m) return undefined;
  return { subtype: m[1] ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : "chosen", abilities: !!m[2] };
}

/** Un symbole d'un coût de mana. */
export type CostSymbol =
  | { kind: "color"; mana: ManaType }
  | { kind: "generic"; amount: number }
  | { kind: "x" }
  /** Hybride : {G/W}. */
  | { kind: "hybrid"; options: ManaType[] }
  /** Hybride à deux génériques : {2/W}. */
  | { kind: "twoOrColor"; mana: ManaType }
  /** Phyrexian : {G/P}, la couleur ou 2 points de vie. */
  | { kind: "phyrexian"; mana: ManaType };

/** Lit un coût comme « {2}{G}{G} », « {X}{R} », « {G/W}{U/P} ». Les symboles inconnus ({S}…) comptent comme génériques. */
export function parseManaCost(cost: string): CostSymbol[] {
  const symbols: CostSymbol[] = [];
  for (const [, raw] of cost.matchAll(/\{([^}]+)\}/g)) {
    const s = raw!.toUpperCase();
    if (/^\d+$/.test(s)) {
      if (Number(s) > 0) symbols.push({ kind: "generic", amount: Number(s) });
    } else if (s === "X") symbols.push({ kind: "x" });
    else if (isManaType(s)) symbols.push({ kind: "color", mana: s });
    else if (/^[WUBRG]\/P$/.test(s) || /^P\/[WUBRG]$/.test(s)) symbols.push({ kind: "phyrexian", mana: s.replace(/\/?P\/?/, "") as ManaType });
    else if (/^2\/[WUBRG]$/.test(s)) symbols.push({ kind: "twoOrColor", mana: s[2] as ManaType });
    else if (/^[WUBRGC]\/[WUBRGC]$/.test(s)) symbols.push({ kind: "hybrid", options: [s[0] as ManaType, s[2] as ManaType] });
    else symbols.push({ kind: "generic", amount: 1 });
  }
  return symbols;
}

/** Ce qui manque pour payer : une couleur précise, l'une de plusieurs, ou du mana quelconque. */
export type ManaNeed = { kind: "color"; options: ManaType[] } | { kind: "any" };

export type PaymentResult =
  | { ok: true; pool: ManaPool; spent: ManaType[]; life: number }
  | { ok: false; need: ManaNeed };

/**
 * Paie un coût avec une réserve (sans la modifier). Les symboles colorés
 * passent d'abord, puis les hybrides, puis le générique avec ce qui reste
 * (l'incolore en premier, puis la couleur la plus abondante).
 */
export function payFromPool(pool: ManaPool, cost: CostSymbol[], x = 0, extraGeneric = 0): PaymentResult {
  const left: ManaPool = { ...pool };
  const spent: ManaType[] = [];
  let life = 0;
  const take = (m: ManaType) => {
    left[m] -= 1;
    spent.push(m);
  };
  for (const s of cost) {
    if (s.kind !== "color") continue;
    if (left[s.mana] < 1) return { ok: false, need: { kind: "color", options: [s.mana] } };
    take(s.mana);
  }
  for (const s of cost) {
    if (s.kind === "hybrid") {
      const best = [...s.options].sort((a, b) => left[b] - left[a])[0]!;
      if (left[best] < 1) return { ok: false, need: { kind: "color", options: s.options } };
      take(best);
    } else if (s.kind === "phyrexian") {
      if (left[s.mana] > 0) take(s.mana);
      else life += 2;
    }
  }
  let generic = x + extraGeneric;
  for (const s of cost) {
    if (s.kind === "generic") generic += s.amount;
    // {2/W} : la couleur si on l'a, sinon deux génériques.
    if (s.kind === "twoOrColor") {
      if (left[s.mana] > 0) take(s.mana);
      else generic += 2;
    }
  }
  for (let i = 0; i < generic; i++) {
    const m = (["C", ...[...MANA_TYPES].filter((t) => t !== "C").sort((a, b) => left[b] - left[a])] as ManaType[]).find(
      (t) => left[t] > 0,
    );
    if (!m) return { ok: false, need: { kind: "any" } };
    take(m);
  }
  return { ok: true, pool: left, spent, life };
}

/** Le coût contient-il {X} ? */
export function hasX(cost: string): boolean {
  return /\{X\}/i.test(cost);
}
