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
