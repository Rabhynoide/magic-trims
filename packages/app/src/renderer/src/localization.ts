import { applyLocalization, type CardData, type GameView, type LocalizedCard } from "@magic-trims/core";
import { storage } from "./storage";

/**
 * Langue des cartes, propre à chaque joueur : l'hôte envoie les cartes en
 * anglais, et chaque appli va chercher sur Scryfall leur version imprimée
 * dans la langue choisie (en gardant l'anglais quand elle n'existe pas).
 */
class Localizer {
  lang: string = storage.getCardLang();
  private found = new Map<string, LocalizedCard | null>();
  private queued = new Map<string, CardData>();
  private asked = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private cache: { view: GameView; size: number; version: number; result: GameView } | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify() {
    this.version++;
    for (const l of this.listeners) l();
  }

  setLang(lang: string) {
    if (lang === this.lang) return;
    this.lang = lang;
    storage.setCardLang(lang);
    this.found.clear();
    this.queued.clear();
    this.asked.clear();
    this.notify();
  }

  /** La vue de la partie avec les cartes traduites qu'on connaît déjà. */
  apply(view: GameView): GameView {
    if (this.lang === "en" || !window.magic) return view;
    const size = Object.keys(view.cardData).length;
    const c = this.cache;
    if (c && c.view === view && c.size === size && c.version === this.version) return c.result;

    const cardData: Record<string, CardData> = {};
    for (const [id, card] of Object.entries(view.cardData)) {
      const localized = this.found.get(id);
      if (localized === undefined && !this.asked.has(id)) this.queue(card);
      cardData[id] = applyLocalization(card, localized);
    }
    const result = { ...view, cardData };
    this.cache = { view, size, version: this.version, result };
    return result;
  }

  private queue(card: CardData) {
    this.asked.add(card.id);
    this.queued.set(card.id, card);
    this.timer ??= setTimeout(() => void this.fetch(), 50);
  }

  private async fetch() {
    this.timer = null;
    const lang = this.lang;
    const cards = [...this.queued.values()].map(({ id, oracleId, set, collectorNumber }) => ({
      id,
      oracleId,
      set,
      collectorNumber,
    }));
    this.queued.clear();
    if (cards.length === 0 || !window.magic) return;
    let result: Record<string, LocalizedCard | null>;
    try {
      result = await window.magic.localizeCards(cards, lang);
    } catch (err) {
      // Scryfall injoignable : on garde l'anglais pour cette fois.
      console.warn("Traduction des cartes impossible", err);
      return;
    }
    if (lang !== this.lang) return;
    for (const card of cards) this.found.set(card.id, result[card.id] ?? null);
    this.notify();
  }
}

export const localizer = new Localizer();
