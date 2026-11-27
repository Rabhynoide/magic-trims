import { formatForMode, type DeckIssue, type GameModeType } from "@magic-trims/core";
import type { Precon, PreconFile } from "./data/precon-types";
import { storage, type SavedDeck } from "./storage";

export type { Precon };

let loading: Promise<PreconFile> | null = null;

/**
 * Liste des préconstruits officiels. Le fichier (quelques centaines de Ko) est
 * chargé à la première ouverture de l'onglet, pas au démarrage de l'appli.
 */
export function loadPrecons(): Promise<PreconFile> {
  loading ??= import("./data/precons.json").then((m) => m.default as PreconFile);
  return loading;
}

/** Liste texte du deck, lue par l'import habituel (Scryfall). */
export function preconText(p: Precon): string {
  return `Commander\n${p.commanders.join("\n")}\n\nDeck\n${p.cards.join("\n")}\n`;
}

/** Problèmes du deck pour un mode de jeu (calculés à la génération de la liste). */
export function preconIssues(p: Precon, mode: GameModeType): DeckIssue[] {
  return p.issues[formatForMode(mode)];
}

/** Nom du (des) commandant(s), sans quantité ni édition. */
export function preconCommanders(p: Precon): string {
  return p.commanders.map((l) => l.replace(/^\d+\s+/, "").replace(/\s+\([^)]+\)\s+\S+$/, "")).join(" & ");
}

/** Deck déjà ajouté à « Mes decks » depuis ce préconstruit. */
export function savedPrecon(p: Precon): SavedDeck | undefined {
  return storage.getDecks().find((d) => d.preconId === p.id);
}

/**
 * Ajoute le préconstruit à « Mes decks » : ses cartes sont cherchées sur
 * Scryfall comme pour un import collé. S'il a déjà été ajouté, on le reprend.
 */
export async function addPrecon(p: Precon): Promise<{ deck: SavedDeck; missing: string[] }> {
  const existing = savedPrecon(p);
  if (existing) return { deck: existing, missing: [] };
  const api = window.magic;
  if (!api) throw new Error("L'ajout d'un deck n'est possible que dans l'appli Windows.");
  const text = preconText(p);
  const result = await api.importDeck(text);
  const deck: SavedDeck = {
    id: crypto.randomUUID(),
    name: p.name,
    text,
    deck: result.deck,
    importedAt: Date.now(),
    preconId: p.id,
  };
  storage.setDecks([...storage.getDecks(), deck]);
  return { deck, missing: result.unresolved.map((e) => e.name) };
}
