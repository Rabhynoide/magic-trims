import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CENTRAL_DEFAULT_PORT, type CentralGroup, type CentralMember, type ResolvedDeck } from "@magic-trims/core";
import { CentralStore } from "./store.js";

export interface CentralServerOptions {
  /** Port d'écoute (47475 par défaut ; 0 = n'importe quel port libre). */
  port?: number;
  /** Adresse d'écoute (toutes les interfaces par défaut). */
  hostname?: string;
  /** Fichier SQLite (`:memory:` pour les tests). */
  dbPath: string;
}

export interface CentralServer {
  port: number;
  store: CentralStore;
  close(): Promise<void>;
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

/** Démarre le serveur central (API JSON sur HTTP). */
export async function startCentralServer(options: CentralServerOptions): Promise<CentralServer> {
  const store = new CentralStore(options.dbPath);
  const failedJoins = new Map<string, { count: number; since: number }>();

  const http: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) send(res, err.status, { error: err.message });
      else {
        console.error(err);
        send(res, 500, { error: "Erreur interne du serveur central." });
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (path === "/" || path === "/api") {
      return send(res, 200, { service: "magic-trims-central", version: 1 });
    }

    if (path === "/api/join" && method === "POST") {
      const ip = req.socket.remoteAddress ?? "?";
      const now = Date.now();
      const failures = failedJoins.get(ip);
      if (failures && now - failures.since < FAILED_JOIN_WINDOW_MS && failures.count >= MAX_FAILED_JOINS) {
        throw new HttpError(429, "Trop d'essais de code. Réessaie dans quelques minutes.");
      }
      const body = await readJson(req);
      const code = stringField(body, "code", 40);
      const name = cleanName(stringField(body, "name", MAX_NAME));
      const joined = store.join(code, name);
      if (!joined) {
        const current = failures && now - failures.since < FAILED_JOIN_WINDOW_MS ? failures : { count: 0, since: now };
        failedJoins.set(ip, { count: current.count + 1, since: current.since });
        throw new HttpError(404, "Code de groupe inconnu.");
      }
      failedJoins.delete(ip);
      return send(res, 200, joined);
    }

    if (!path.startsWith("/api/")) throw new HttpError(404, "Adresse inconnue.");
    const auth = authenticate(req);

    if (path === "/api/me" && method === "GET") return send(res, 200, auth);

    if (path === "/api/decks" && method === "GET") {
      return send(res, 200, { decks: store.listDecks(auth.group.id) });
    }

    const deckMatch = /^\/api\/decks\/([^/]+)$/.exec(path);
    if (deckMatch) {
      const id = decodeURIComponent(deckMatch[1]!);
      if (id.length > 100) throw new HttpError(400, "Identifiant de deck trop long.");
      if (method === "PUT") {
        const body = await readJson(req);
        const name = cleanName(stringField(body, "name", MAX_NAME));
        const text = stringField(body, "text", MAX_TEXT, true);
        const deck = deckField(body);
        const saved = store.saveDeck(auth.group.id, auth.member, { id, name, text, deck });
        if (saved === "forbidden") throw new HttpError(403, "Ce deck a été partagé par un autre joueur.");
        return send(res, 200, saved);
      }
      if (method === "DELETE") {
        const result = store.deleteDeck(auth.group.id, auth.member.id, id);
        if (result === "missing") throw new HttpError(404, "Ce deck n'est pas partagé.");
        if (result === "forbidden") throw new HttpError(403, "Seul le joueur qui a partagé ce deck peut le retirer.");
        res.writeHead(204).end();
        return;
      }
    }

    throw new HttpError(404, "Adresse inconnue.");
  }

  function authenticate(req: IncomingMessage): { member: CentralMember; group: CentralGroup } {
    const header = req.headers.authorization ?? "";
    const token = /^Bearer (.+)$/.exec(header)?.[1];
    const auth = token ? store.authenticate(token) : null;
    if (!auth) throw new HttpError(401, "Connexion au groupe expirée : rejoins-le à nouveau avec son code.");
    return auth;
  }

  const port = await new Promise<number>((resolve, reject) => {
    http.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Le port ${options.port ?? CENTRAL_DEFAULT_PORT} est déjà utilisé.`)
          : err,
      );
    });
    http.listen(options.port ?? CENTRAL_DEFAULT_PORT, options.hostname, () => {
      const address = http.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    port,
    store,
    async close() {
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      store.close();
    },
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Envoi trop gros.");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
