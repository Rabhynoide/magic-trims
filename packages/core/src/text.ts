/** Outils de lecture du texte Oracle, sans dépendance au reste du moteur. */

/**
 * Remplace la carte elle-même par « ~ » : son nom (complet, d'une face, ou
 * court pour un légendaire comme « Vito ») et « this creature », « this
 * artifact »… du texte Oracle moderne. Retire aussi le texte de rappel.
 */
export function selfToTilde(oracleText: string, cardName: string): string {
  const names = [cardName, ...cardName.split(" // "), cardName.split(",")[0]!].filter(Boolean);
  let text = oracleText.replace(/\([^)]*\)/g, "");
  for (const n of names) text = text.split(n).join("~");
  return text.replace(/\bthis (creature|artifact|enchantment|permanent|land|card|planeswalker|spell|Equipment|Aura|Saga|Vehicle)\b/gi, "~");
}

/** Les lignes du texte, sans texte de rappel ni lignes vides. */
/** Les modes (« • … ») rejoignent la ligne « Choose one — » qui les annonce. */
export function joinModes(oracleText: string): string {
  return oracleText.replace(/\n\s*•/g, " •");
}

export function oracleLines(oracleText: string): string[] {
  return joinModes(oracleText)
    .split("\n")
    .map((raw) => raw.replace(/\([^)]*\)/g, "").trim())
    .filter(Boolean);
}

export const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Mots-clés de capacités (noms anglais) en minuscules, séparés par « , » ou « and ». */
export function keywordList(text: string): string[] {
  return text
    .split(/,\s*and\s+|,\s*|\s+and\s+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/** Pseudo-mot-clé donné par un équipement, une aura ou un effet : « can't be blocked ». */
export const CANT_BE_BLOCKED = "can't be blocked";
