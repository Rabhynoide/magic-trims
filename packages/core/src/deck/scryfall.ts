import type { CardData, CardFace, CardImages } from "../types.js";

/**
 * Accès à l'API Scryfall (https://scryfall.com/docs/api).
 *
 * Scryfall demande au plus 10 requêtes par seconde et un en-tête User-Agent.
 * On regroupe les cartes par paquets de 75 (limite de /cards/collection) et
 * on garde tout en cache pour ne pas redemander une carte déjà connue.
 */

export const SCRYFALL_API = "https://api.scryfall.com";
const COLLECTION_BATCH = 75;
const MIN_DELAY_MS = 110;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Cache de cartes. L'appli fournira une version sur disque. */
export interface CardCache {
  get(key: string): Promise<CardData | undefined>;
  set(key: string, card: CardData): Promise<void>;
}

export class MemoryCardCache implements CardCache {
  private readonly map = new Map<string, CardData>();
  async get(key: string) {
    return this.map.get(key);
  }
  async set(key: string, card: CardData) {
    this.map.set(key, card);
  }
}

export type CardIdentifier =
  | { name: string }
  | { name: string; set: string }
  | { set: string; collector_number: string };

export interface ScryfallClientOptions {
  fetch?: FetchLike;
  cache?: CardCache;
  userAgent?: string;
  /** Pause entre deux requêtes, en millisecondes. */
  delayMs?: number;
}

export class ScryfallClient {
  private readonly fetchFn: FetchLike;
  private readonly cache: CardCache;
  private readonly headers: Record<string, string>;
  private readonly delayMs: number;
  private lastRequest = 0;

  constructor(options: ScryfallClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.cache = options.cache ?? new MemoryCardCache();
    this.delayMs = options.delayMs ?? MIN_DELAY_MS;
    this.headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": options.userAgent ?? "MagicTrims/0.1",
    };
  }

  /**
   * Récupère plusieurs cartes. Retourne les cartes trouvées (indexées par la
   * clé de leur identifiant) et la liste des identifiants introuvables.
   */
  async getCollection(
    identifiers: CardIdentifier[],
  ): Promise<{ found: Map<string, CardData>; notFound: CardIdentifier[] }> {
    const found = new Map<string, CardData>();
    const missing: CardIdentifier[] = [];
    for (const id of identifiers) {
      const key = identifierKey(id);
      if (found.has(key)) continue;
      const cached = await this.cache.get(key);
      if (cached) found.set(key, cached);
      else if (!missing.some((m) => identifierKey(m) === key)) missing.push(id);
    }

    const notFound: CardIdentifier[] = [];
    for (let i = 0; i < missing.length; i += COLLECTION_BATCH) {
      const batch = missing.slice(i, i + COLLECTION_BATCH);
      const body = await this.request("/cards/collection", {
        method: "POST",
        body: JSON.stringify({ identifiers: batch }),
      });
      const data = (body.data ?? []) as ScryfallCard[];
      const misses = (body.not_found ?? []) as CardIdentifier[];
      const missKeys = new Set(misses.map(identifierKey));
      const requested = batch.filter((id) => !missKeys.has(identifierKey(id)));
      const remaining = [...data];
      requested.forEach((id, index) => {
        // On associe chaque carte reçue à l'identifiant demandé ; à défaut,
        // on se fie à l'ordre (Scryfall répond dans l'ordre de la requête).
        let pos = remaining.findIndex((raw) => matchesIdentifier(raw, id));
        if (pos < 0 && remaining[0] === data[index]) pos = 0;
        if (pos < 0) {
          notFound.push(id);
          return;
        }
        const card = toCardData(remaining.splice(pos, 1)[0]!);
        const key = identifierKey(id);
        found.set(key, card);
        void this.cache.set(key, card);
      });
      notFound.push(...misses);
    }
    return { found, notFound };
  }

  /** Recherche approximative d'une carte par son nom (tolère les fautes). */
  async getByFuzzyName(name: string): Promise<CardData | undefined> {
    try {
      const raw = (await this.request(`/cards/named?fuzzy=${encodeURIComponent(name)}`)) as unknown as ScryfallCard;
      return toCardData(raw);
    } catch (err) {
      if (err instanceof ScryfallError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Recherche de jetons (« t:token name:Soldier »…). */
  async searchTokens(query: string): Promise<CardData[]> {
    try {
      const body = await this.request(`/cards/search?q=${encodeURIComponent(`t:token ${query}`)}&unique=art`);
      return ((body.data ?? []) as ScryfallCard[]).map(toCardData);
    } catch (err) {
      if (err instanceof ScryfallError && err.status === 404) return [];
      throw err;
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const wait = this.lastRequest + this.delayMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequest = Date.now();
    const response = await this.fetchFn(`${SCRYFALL_API}${path}`, { ...init, headers: this.headers });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new ScryfallError(response.status, String(body.details ?? response.statusText));
    }
    return body;
  }
}

export class ScryfallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Scryfall (${status}) : ${message}`);
  }
}

export function identifierKey(id: CardIdentifier): string {
  if ("collector_number" in id) return `set:${id.set.toLowerCase()}#${id.collector_number.toLowerCase()}`;
  if ("set" in id) return `name:${id.name.toLowerCase()}@${id.set.toLowerCase()}`;
  return `name:${id.name.toLowerCase()}`;
}

export function matchesIdentifier(raw: ScryfallCard, id: CardIdentifier): boolean {
  if ("collector_number" in id) {
    return raw.set.toLowerCase() === id.set.toLowerCase() && raw.collector_number.toLowerCase() === id.collector_number.toLowerCase();
  }
  if ("set" in id && raw.set.toLowerCase() !== id.set.toLowerCase()) return false;
  const wanted = id.name.toLowerCase();
  const names = [raw.name, ...(raw.card_faces ?? []).map((f) => f.name)].map((n) => n.toLowerCase());
  return names.includes(wanted);
}

// ---------------------------------------------------------------------------
// Conversion du format Scryfall vers notre format.

/** Champs Scryfall utilisés (le reste est ignoré). */
export interface ScryfallCard {
  id: string;
  oracle_id?: string;
  name: string;
  printed_name?: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors?: string[];
  color_identity?: string[];
  keywords?: string[];
  legalities?: Record<string, string>;
  set: string;
  collector_number: string;
  image_uris?: ScryfallImages;
  card_faces?: ScryfallFace[];
}

interface ScryfallFace {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  oracle_id?: string;
  image_uris?: ScryfallImages;
}

interface ScryfallImages {
  small: string;
  normal: string;
  large: string;
  art_crop?: string;
}

export function toCardData(raw: ScryfallCard): CardData {
  const firstFace = raw.card_faces?.[0];
  const card: CardData = {
    id: raw.id,
    oracleId: raw.oracle_id ?? firstFace?.oracle_id ?? raw.id,
    name: raw.name,
    manaCost: raw.mana_cost ?? firstFace?.mana_cost ?? "",
    manaValue: raw.cmc ?? 0,
    typeLine: raw.type_line ?? firstFace?.type_line ?? "",
    oracleText:
      raw.oracle_text ??
      (raw.card_faces ?? []).map((f) => f.oracle_text ?? "").filter(Boolean).join("\n//\n"),
    colors: raw.colors ?? [],
    colorIdentity: raw.color_identity ?? [],
    keywords: raw.keywords ?? [],
    commanderLegality: raw.legalities?.commander ?? "unknown",
    set: raw.set,
    collectorNumber: raw.collector_number,
  };
  if (raw.printed_name) card.printedName = raw.printed_name;
  if (raw.power !== undefined) card.power = raw.power;
  if (raw.toughness !== undefined) card.toughness = raw.toughness;
  if (raw.loyalty !== undefined) card.loyalty = raw.loyalty;
  const image = toImages(raw.image_uris ?? firstFace?.image_uris);
  if (image) card.image = image;
  if (raw.card_faces && raw.card_faces.length > 1) {
    card.faces = raw.card_faces.map((f) => {
      const face: CardFace = {
        name: f.name,
        manaCost: f.mana_cost ?? "",
        typeLine: f.type_line ?? "",
        oracleText: f.oracle_text ?? "",
      };
      if (f.power !== undefined) face.power = f.power;
      if (f.toughness !== undefined) face.toughness = f.toughness;
      if (f.loyalty !== undefined) face.loyalty = f.loyalty;
      // Cartes scindées ou à aventure : une seule image pour toutes les faces.
      const faceImage = toImages(f.image_uris ?? raw.image_uris);
      if (faceImage) face.image = faceImage;
      return face;
    });
  }
  return card;
}

function toImages(images: ScryfallImages | undefined): CardImages | undefined {
  if (!images) return undefined;
  const result: CardImages = { small: images.small, normal: images.normal, large: images.large };
  if (images.art_crop) result.artCrop = images.art_crop;
  return result;
}
