import type { ResolvedDeck } from "./deck/resolve.js";

/**
 * Serveur central facultatif : partage de decks entre amis d'un même groupe.
 * Le jeu n'en dépend jamais : s'il est injoignable, seules les fonctions de
 * communauté sont indisponibles.
 */

/** Port du serveur central d'essai local (celui des parties est 47474). */
export const CENTRAL_DEFAULT_PORT = 47475;

export interface CentralMember {
  id: string;
  name: string;
}

export interface CentralGroup {
  id: string;
  name: string;
}

/** Ce que l'appli garde pour se reconnecter au serveur central. */
export interface CentralConnection {
  url: string;
  token: string;
}

export interface CentralJoinResult {
  token: string;
  member: CentralMember;
  group: CentralGroup;
}

/** Deck partagé dans le groupe. */
export interface SharedDeck {
  id: string;
  name: string;
  /** Liste d'origine, pour pouvoir la réimporter. */
  text: string;
  deck: ResolvedDeck;
  owner: CentralMember;
  updatedAt: number;
}

export interface ShareDeckInput {
  id: string;
  name: string;
  text: string;
  deck: ResolvedDeck;
}

export class CentralError extends Error {
  constructor(
    message: string,
    /** Code HTTP (0 : serveur injoignable). */
    readonly status: number,
  ) {
    super(message);
    this.name = "CentralError";
  }
}

/**
 * Complète une adresse saisie par le joueur. Un nom de domaine passe en
 * https (`magic-trims-central.toto.workers.dev` → `https://…`) ; une adresse IP
 * ou `localhost` (serveur d'essai) passe en http sur le port 47475.
 */
export function normalizeCentralUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!url) throw new CentralError("Adresse du serveur central vide.", 400);
  if (!/^https?:\/\//i.test(url)) {
    const host = url.split(/[/:]/)[0]!;
    const local = host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    url = `${local ? "http" : "https"}://${url}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CentralError(`Adresse du serveur central illisible : ${input}`, 400);
  }
  if (!parsed.port && parsed.protocol === "http:") parsed.port = String(CENTRAL_DEFAULT_PORT);
  return parsed.origin;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface CentralClientOptions {
  url: string;
  token?: string;
  /** Délai maximal d'une requête (5 s par défaut). */
  timeoutMs?: number;
  fetch?: FetchFn;
}

/** Petit client HTTP du serveur central. Chaque appel échoue vite et proprement s'il est injoignable. */
export class CentralClient {
  readonly url: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(options: CentralClientOptions) {
    this.url = normalizeCentralUrl(options.url);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Rejoint un groupe avec son code ; renvoie le jeton à garder. */
  join(code: string, name: string): Promise<CentralJoinResult> {
    return this.request("POST", "/api/join", { code, name });
  }

  me(): Promise<{ member: CentralMember; group: CentralGroup }> {
    return this.request("GET", "/api/me");
  }

  listDecks(): Promise<SharedDeck[]> {
    return this.request<{ decks: SharedDeck[] }>("GET", "/api/decks").then((r) => r.decks);
  }

  /** Partage un deck (ou met à jour un deck déjà partagé par ce joueur). */
  shareDeck(deck: ShareDeckInput): Promise<SharedDeck> {
    return this.request("PUT", `/api/decks/${encodeURIComponent(deck.id)}`, {
      name: deck.name,
      text: deck.text,
      deck: deck.deck,
    });
  }

  unshareDeck(id: string): Promise<void> {
    return this.request("DELETE", `/api/decks/${encodeURIComponent(id)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await this.fetchFn(this.url + path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CentralError("Serveur central injoignable. Le jeu reste utilisable sans lui.", 0);
    }
    if (res.status === 204) return undefined as T;
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // Réponse vide ou qui ne vient pas d'un serveur Magic Trims.
    }
    if (!res.ok) {
      const message =
        data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : `Le serveur central a répondu ${res.status}.`;
      throw new CentralError(message, res.status);
    }
    return data as T;
  }
}
