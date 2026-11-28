import type {
  AppVersion,
  CardData,
  CentralConnection,
  CentralJoinResult,
  DeckEntry,
  DeckIssue,
  LocalizedCard,
  ResolvedDeck,
  ShareDeckInput,
  SharedDeck,
} from "@magic-trims/core";

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

/** Réponse d'un appel au serveur central : jamais d'exception, pour afficher un message clair. */
export type CentralResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

/** Serveur central facultatif (partage de decks). Les appels passent par le processus principal. */
export interface CentralApi {
  /** Rejoint un groupe ; renvoie aussi l'adresse complétée (port par défaut). */
  join(url: string, code: string, name: string): Promise<CentralResult<CentralJoinResult & { url: string }>>;
  listDecks(conn: CentralConnection): Promise<CentralResult<SharedDeck[]>>;
  shareDeck(conn: CentralConnection, deck: ShareDeckInput): Promise<CentralResult<SharedDeck>>;
  unshareDeck(conn: CentralConnection, id: string): Promise<CentralResult<void>>;
}

/** Où en est la mise à jour de l'appli installée. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  /** À jour (ou vérification impossible, sans gêner le joueur). */
  | { state: "none" }
  | { state: "available"; version: string }
  | { state: "downloading"; version: string; percent: number }
  /** Téléchargée : s'installe au clic (ou tout de suite si le joueur l'a demandé). */
  | { state: "ready"; version: string }
  | { state: "error"; message: string; version?: string }
  /** Appli lancée depuis le code : pas de mise à jour automatique. */
  | { state: "unsupported"; reason: string };

export interface UpdatesApi {
  status(): Promise<UpdateStatus>;
  /** Appelé à chaque changement ; renvoie de quoi se désabonner. */
  onStatus(listener: (status: UpdateStatus) => void): () => void;
  check(): Promise<void>;
  /** Télécharge la nouvelle version, l'installe et relance l'appli. */
  install(): Promise<void>;
}

export interface AppInfo extends AppVersion {
  /** Vrai pour l'appli installée (.exe), faux avec `npm run app`. */
  packaged: boolean;
}

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
  central: CentralApi;
  appInfo(): Promise<AppInfo>;
  updates: UpdatesApi;
}

declare global {
  interface Window {
    magic?: MagicApi;
  }
}
