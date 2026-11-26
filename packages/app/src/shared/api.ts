import type { CardData, DeckIssue, DeckEntry, LocalizedCard, ResolvedDeck } from "@magic-trims/core";

export interface HostInfo {
  port: number;
  hostKey: string;
  addresses: { ip: string; kind: string; code: string }[];
  upnp: { ok: boolean; publicIp?: string; reason?: string };
}

export interface DeckImportResult {
  deck: ResolvedDeck;
  /** Cartes introuvables sur Scryfall. */
  unresolved: DeckEntry[];
  /** Lignes illisibles. */
  parseErrors: { line: number; text: string }[];
  issues: DeckIssue[];
  /** Nom du deck sur le site d'origine (import par lien). */
  name?: string;
}

export type CardToLocalize = Pick<CardData, "id" | "oracleId" | "set" | "collectorNumber">;

/** Ce que le processus principal d'Electron offre à l'interface (via le preload). */
export interface MagicApi {
  startHost(options: { resume: boolean }): Promise<HostInfo>;
  stopHost(): Promise<void>;
  hasSavedGame(): Promise<boolean>;
  importDeck(text: string): Promise<DeckImportResult>;
  /** Cherche des cartes par nom (jetons, plans, machinations…). */
  searchCards(query: string): Promise<CardData[]>;
  /** Cherche les cartes imprimées dans une langue (`null` : on garde l'anglais). */
  localizeCards(cards: CardToLocalize[], lang: string): Promise<Record<string, LocalizedCard | null>>;
}

declare global {
  interface Window {
    magic?: MagicApi;
  }
}
