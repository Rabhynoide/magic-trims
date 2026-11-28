import type { CardData } from "@magic-trims/core";

/**
 * Cartes des commandants des préconstruits (pour leur miniature dans la
 * liste des decks). La liste embarquée ne contient que des lignes
 * « 1 Jean-Luc Picard, Luminary (trc) 7 » : l'appli les fait chercher sur
 * Scryfall, en une seule requête groupée, et les garde en cache disque.
 */
class CommanderCards {
  private found = new Map<string, CardData | null>();
  private asked = new Set<string>();
  private queued = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  version = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** La carte de la ligne, si on l'a déjà (sinon elle est demandée). */
  get(line: string): CardData | undefined {
    const card = this.found.get(line);
    if (card !== undefined) return card ?? undefined;
    if (!this.asked.has(line) && window.magic) {
      this.asked.add(line);
      this.queued.add(line);
      this.timer ??= setTimeout(() => void this.fetch(), 50);
    }
    return undefined;
  }

  private async fetch() {
    this.timer = null;
    const lines = [...this.queued];
    this.queued.clear();
    if (lines.length === 0 || !window.magic) return;
    let cards: (CardData | null)[];
    try {
      cards = await window.magic.resolveCards(lines);
    } catch (err) {
      // Scryfall injoignable : pas de miniature, on retentera à la prochaine ouverture.
      console.warn("Commandants des préconstruits introuvables", err);
      for (const l of lines) this.asked.delete(l);
      return;
    }
    lines.forEach((l, i) => this.found.set(l, cards[i] ?? null));
    this.version++;
    for (const l of this.listeners) l();
  }
}

export const commanderCards = new CommanderCards();
