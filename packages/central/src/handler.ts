import type { CentralGroup, CentralMember, ResolvedDeck } from "@magic-trims/core";
import type { CentralStore } from "./store.js";

/**
 * API du serveur central, écrite avec les objets web standard (Request,
 * Response) : la même logique tourne dans le Durable Object de Cloudflare et
 * dans le petit serveur Node d'essai local.
 */

export interface HandlerOptions {
  /** Clé d'administration (création de groupes à distance). Sans clé, ces routes sont fermées. */
  adminKey?: string | undefined;
}

/** Un deck de 100 cartes pèse environ 200 Ko en JSON. */
const MAX_BODY = 2 * 1024 * 1024;
const MAX_NAME = 60;
const MAX_TEXT = 50_000;
/** Essais de code de groupe ratés tolérés par adresse IP et par fenêtre. */
const MAX_FAILED_JOINS = 10;
const FAILED_JOIN_WINDOW_MS = 10 * 60_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export type CentralHandler = (request: Request, clientIp: string) => Promise<Response>;

export function createHandler(store: CentralStore, options: HandlerOptions = {}): CentralHandler {
  const failedJoins = new Map<string, { count: number; since: number }>();

  async function route(request: Request, ip: string): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (path === "/" || path === "/api") return json(200, { service: "magic-trims-central", version: 1 });

    if (path === "/api/join" && method === "POST") {
      const now = Date.now();
      const failures = failedJoins.get(ip);
      const recent = failures && now - failures.since < FAILED_JOIN_WINDOW_MS ? failures : null;
      if (recent && recent.count >= MAX_FAILED_JOINS) {
        throw new HttpError(429, "Trop d'essais de code. Réessaie dans quelques minutes.");
      }
      const body = await readJson(request);
      const code = stringField(body, "code", 40);
      const name = cleanName(stringField(body, "name", MAX_NAME));
      const joined = await store.join(code, name);
      if (!joined) {
        failedJoins.set(ip, { count: (recent?.count ?? 0) + 1, since: recent?.since ?? now });
        throw new HttpError(404, "Code de groupe inconnu.");
      }
      failedJoins.delete(ip);
      return json(200, joined);
    }

    if (path === "/api/admin/groups") {
      const header = request.headers.get("Authorization") ?? "";
      if (!options.adminKey || header !== `Bearer ${options.adminKey}`) {
        throw new HttpError(403, "Clé d'administration absente ou fausse.");
      }
      if (method === "GET") return json(200, { groups: store.listGroups() });
      if (method === "POST") {
        const body = await readJson(request);
        return json(200, store.createGroup(cleanName(stringField(body, "name", MAX_NAME))));
      }
    }

    if (!path.startsWith("/api/")) throw new HttpError(404, "Adresse inconnue.");
    const auth = await authenticate(request);

    if (path === "/api/me" && method === "GET") return json(200, auth);
    if (path === "/api/decks" && method === "GET") return json(200, { decks: store.listDecks(auth.group.id) });

    const deckMatch = /^\/api\/decks\/([^/]+)$/.exec(path);
    if (deckMatch) {
      const id = decodeURIComponent(deckMatch[1]!);
      if (id.length > 100) throw new HttpError(400, "Identifiant de deck trop long.");
      if (method === "PUT") {
        const body = await readJson(request);
        const name = cleanName(stringField(body, "name", MAX_NAME));
        const text = stringField(body, "text", MAX_TEXT, true);
        const saved = store.saveDeck(auth.group.id, auth.member, { id, name, text, deck: deckField(body) });
        if (saved === "forbidden") throw new HttpError(403, "Ce deck a été partagé par un autre joueur.");
        return json(200, saved);
      }
      if (method === "DELETE") {
        const result = store.deleteDeck(auth.group.id, auth.member.id, id);
        if (result === "missing") throw new HttpError(404, "Ce deck n'est pas partagé.");
        if (result === "forbidden") throw new HttpError(403, "Seul le joueur qui a partagé ce deck peut le retirer.");
        return new Response(null, { status: 204 });
      }
    }

    throw new HttpError(404, "Adresse inconnue.");
  }

  async function authenticate(request: Request): Promise<{ member: CentralMember; group: CentralGroup }> {
    const token = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    const auth = token ? await store.authenticate(token) : null;
    if (!auth) throw new HttpError(401, "Connexion au groupe expirée : rejoins-le à nouveau avec son code.");
    return auth;
  }

  return async (request, clientIp) => {
    try {
      return await route(request, clientIp);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: "Erreur interne du serveur central." });
    }
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) throw new HttpError(413, "Envoi trop gros.");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Envoi trop gros.");
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // traité juste en dessous
  }
  throw new HttpError(400, "Requête illisible.");
}

function stringField(body: Record<string, unknown>, key: string, max: number, allowEmpty = false): string {
  const value = body[key];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new HttpError(400, `Champ « ${key} » manquant.`);
  if (value.length > max) throw new HttpError(400, `Champ « ${key} » trop long.`);
  return value;
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function deckField(body: Record<string, unknown>): ResolvedDeck {
  const deck = body.deck as Partial<ResolvedDeck> | undefined;
  if (!deck || typeof deck !== "object" || !Array.isArray(deck.commanders) || !Array.isArray(deck.cards)) {
    throw new HttpError(400, "Deck illisible.");
  }
  return deck as ResolvedDeck;
}
