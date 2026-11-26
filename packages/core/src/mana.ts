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
  const options: ManaType[][] = [];
  const add = (mana: ManaType[]) => {
    if (mana.length > 0 && !options.some((o) => o.join() === mana.join())) options.push(mana);
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
    if (/^one mana of any color\b/i.test(effect)) {
      for (const m of ["W", "U", "B", "R", "G"] as const) add([m]);
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
