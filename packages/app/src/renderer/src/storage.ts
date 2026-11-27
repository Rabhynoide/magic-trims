import type { CentralGroup, CentralMember, ResolvedDeck } from "@magic-trims/core";

/** Petites préférences gardées sur ce PC (nom, decks importés, dernière partie). */

export interface SavedDeck {
  id: string;
  name: string;
  /** Liste d'origine, pour pouvoir la réimporter. */
  text: string;
  deck: ResolvedDeck;
  importedAt: number;
}

export interface LastSession {
  url: string;
  token: string;
  name: string;
  isHost: boolean;
}

/** Connexion au serveur central facultatif (partage de decks). */
export interface CentralSettings {
  url: string;
  token: string;
  member: CentralMember;
  group: CentralGroup;
}

const KEYS = {
  name: "magic-trims.name",
  decks: "magic-trims.decks",
  lastCode: "magic-trims.lastCode",
  session: "magic-trims.session",
  selectedDeck: "magic-trims.selectedDeck",
  cardLang: "magic-trims.cardLang",
  central: "magic-trims.central",
} as const;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Stockage plein ou indisponible : on continue sans mémoriser.
  }
}

export const storage = {
  getName: () => read<string>(KEYS.name, ""),
  setName: (name: string) => write(KEYS.name, name),
  getDecks: () => read<SavedDeck[]>(KEYS.decks, []),
  setDecks: (decks: SavedDeck[]) => write(KEYS.decks, decks),
  getLastCode: () => read<string>(KEYS.lastCode, ""),
  setLastCode: (code: string) => write(KEYS.lastCode, code),
  getSession: () => read<LastSession | null>(KEYS.session, null),
  setSession: (session: LastSession | null) => write(KEYS.session, session),
  getSelectedDeck: () => read<string | null>(KEYS.selectedDeck, null),
  setSelectedDeck: (id: string | null) => write(KEYS.selectedDeck, id),
  /** Langue des cartes (code Scryfall), le français par défaut. */
  getCardLang: () => read<string>(KEYS.cardLang, "fr"),
  setCardLang: (lang: string) => write(KEYS.cardLang, lang),
  getCentral: () => read<CentralSettings | null>(KEYS.central, null),
  setCentral: (central: CentralSettings | null) => write(KEYS.central, central),
};
