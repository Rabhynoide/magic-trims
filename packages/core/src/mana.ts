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
