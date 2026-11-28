import type { DeckIssue } from "@magic-trims/core";

/**
 * Deck préconstruit Commander officiel, tel qu'écrit dans precons.json par
 * `npm run precons` (scripts/fetch-precons.ts). Les cartes sont des lignes
 * « 1 Sol Ring (c21) 263 » : l'import Scryfall habituel les lit.
 */
export interface Precon {
  /** Identifiant mtg.wtf : « édition/nom-du-deck ». */
  id: string;
  name: string;
  /** Code de l'édition (« TRC »). */
  set: string;
  setName: string;
  /** Version collector (impressions alternatives) ou classique. */
  edition: "classic" | "collector";
  url: string;
  commanders: string[];
  cards: string[];
  /** Identité couleur, ordre WUBRG. */
  colors: string[];
  /** Résultat de la vérification au moment de la génération. */
  issues: { commander: DeckIssue[]; duel: DeckIssue[] };
  /** Pourquoi la version classique a été gardée plutôt que la collector. */
  note?: string;
}

export interface PreconFile {
  generatedAt: string;
  source: string;
  decks: Precon[];
}

/**
 * Texte Oracle d'une carte des préconstruits (precon-oracle.json, écrit par
 * `npm run precons:oracle`) : juste ce que lit `cardSupport`.
 */
export interface PreconOracleCard {
  /** Nom Oracle, s'il diffère du nom écrit dans la liste du deck. */
  n?: string;
  /** Ligne de type. */
  t: string;
  /** Texte Oracle (absent quand la carte a des faces). */
  o?: string;
  /** Faces : nom, type, texte. */
  f?: { n: string; t: string; o: string }[];
}

export interface PreconOracle {
  generatedAt: string;
  /** Indexé par le nom de la carte tel qu'écrit dans la liste du deck. */
  cards: Record<string, PreconOracleCard>;
}
