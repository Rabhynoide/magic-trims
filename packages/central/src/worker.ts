/**
 * Serveur central sur Cloudflare (offre gratuite, sans carte bancaire) :
 * un Worker reçoit les requêtes et les passe à un unique Durable Object, qui
 * garde les données dans son SQLite intégré. Déploiement : voir
 * docs/serveur-central.md (`npm run central:deploy`).
 */
import { DurableObject } from "cloudflare:workers";
import { createHandler, type CentralHandler } from "./handler.js";
import { CentralStore } from "./store.js";

export interface Env {
  CENTRAL: DurableObjectNamespace<CentralObject>;
  /** Secret défini avec `wrangler secret put ADMIN_KEY`. */
  ADMIN_KEY?: string;
}

export class CentralObject extends DurableObject<Env> {
  private readonly handler: CentralHandler;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    const store = new CentralStore({
      script: (query) => void sql.exec(query),
      all: <T>(query: string, ...params: (string | number | null)[]) =>
        sql.exec(query, ...params).toArray() as unknown as T[],
      run: (query, ...params) => void sql.exec(query, ...params),
    });
    this.handler = createHandler(store, { adminKey: env.ADMIN_KEY });
  }

  override fetch(request: Request): Promise<Response> {
    return this.handler(request, request.headers.get("CF-Connecting-IP") ?? "?");
  }
}

export default {
  fetch(request, env) {
    // Un seul Durable Object pour tous les groupes : le trafic entre amis est minime.
    return env.CENTRAL.get(env.CENTRAL.idFromName("central")).fetch(request);
  },
} satisfies ExportedHandler<Env>;
