import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CENTRAL_DEFAULT_PORT } from "@magic-trims/core";
import { createHandler } from "./handler.js";
import { CentralStore, type Sql } from "./store.js";

/**
 * Serveur central en Node, pour l'essai local et les tests. En production,
 * le même code tourne sur Cloudflare (voir worker.ts).
 */

export interface CentralServerOptions {
  /** Port d'écoute (47475 par défaut ; 0 = n'importe quel port libre). */
  port?: number;
  /** Adresse d'écoute (toutes les interfaces par défaut). */
  hostname?: string;
  /** Fichier SQLite (`:memory:` pour les tests). */
  dbPath: string;
  adminKey?: string;
}

export interface CentralServer {
  port: number;
  store: CentralStore;
  close(): Promise<void>;
}

/** SQLite de Node (`node:sqlite`, Node 22.13 ou plus). */
export function nodeSql(path: string): Sql & { close(): void } {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  return {
    script: (sql) => db.exec(sql),
    all: <T>(sql: string, ...params: (string | number | null)[]) => db.prepare(sql).all(...params) as T[],
    run: (sql, ...params) => void db.prepare(sql).run(...params),
    close: () => db.close(),
  };
}

export async function startCentralServer(options: CentralServerOptions): Promise<CentralServer> {
  const sql = nodeSql(options.dbPath);
  const store = new CentralStore(sql);
  const handler = createHandler(store, { adminKey: options.adminKey });

  const http: Server = createServer((req, res) => {
    void (async () => {
      const response = await handler(await toRequest(req), req.socket.remoteAddress ?? "?");
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    http.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE" ? new Error(`Le port ${options.port ?? CENTRAL_DEFAULT_PORT} est déjà utilisé.`) : err,
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
      sql.close();
    },
  };
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Le gestionnaire refuse au-delà de 2 Mo ; inutile de garder plus en mémoire.
    if (size > 3 * 1024 * 1024) break;
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
  }
  const method = req.method ?? "GET";
  return new Request(`http://localhost${req.url ?? "/"}`, {
    method,
    headers,
    ...(method !== "GET" && method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}),
  });
}
