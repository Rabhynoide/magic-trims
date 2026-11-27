/**
 * Outil en ligne de commande du serveur central.
 *
 * Serveur hébergé sur Cloudflare (voir docs/serveur-central.md) :
 *   npm run central -- groupes --distant https://magic-trims-central.xxx.workers.dev --cle CLE
 *   npm run central -- nouveau-groupe "Les amis" --distant https://… --cle CLE
 *
 * Essai local, sans Cloudflare :
 *   npm run central                        démarre un serveur sur ce PC (port 47475)
 *   npm run central -- groupes             groupes de la base locale
 *   npm run central -- nouveau-groupe Nom  crée un groupe dans la base locale
 * Options locales : --port 47475, --base chemin/central.sqlite.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { CENTRAL_DEFAULT_PORT, normalizeCentralUrl } from "@magic-trims/core";
import { CentralStore, type GroupWithCode } from "./store.js";

// Chargé seulement pour la base locale : `node:sqlite` affiche un avertissement inutile sinon.
const local = () => import("./server.js");

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}
const remote = option("--distant") ?? process.env.MAGIC_TRIMS_CENTRAL_URL;
const adminKey = option("--cle") ?? process.env.MAGIC_TRIMS_CENTRAL_ADMIN_KEY;
const port = Number(option("--port") ?? CENTRAL_DEFAULT_PORT);
const dbPath = option("--base") ?? join(homedir(), ".magic-trims", "central.sqlite");
const [command, ...rest] = args;

function printGroups(groups: GroupWithCode[]): void {
  if (groups.length === 0) console.log("  (aucun groupe)");
  for (const g of groups) console.log(`  ${g.code}   ${g.name}`);
}

async function admin<T>(method: string, body?: unknown): Promise<T> {
  if (!adminKey) throw new Error("Indique la clé d'administration avec --cle.");
  const url = normalizeCentralUrl(remote!);
  const res = await fetch(`${url}/api/admin/groups`, {
    method,
    headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).catch(() => {
    throw new Error(`Serveur central injoignable : ${url}`);
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(data?.error ?? `Le serveur a répondu ${res.status}.`);
  return data as T;
}

if (command === "groupes" || command === "nouveau-groupe") {
  try {
    if (command === "nouveau-groupe") {
      const name = rest.join(" ");
      const group = remote
        ? await admin<GroupWithCode>("POST", { name })
        : await local().then(({ nodeSql }) => {
            const sql = nodeSql(dbPath);
            const g = new CentralStore(sql).createGroup(name);
            sql.close();
            return g;
          });
      console.log(`Groupe « ${group.name} » créé. Code à donner aux amis : ${group.code}`);
    } else {
      const groups = remote
        ? (await admin<{ groups: GroupWithCode[] }>("GET")).groups
        : await local().then(({ nodeSql }) => {
            const sql = nodeSql(dbPath);
            const g = new CentralStore(sql).listGroups();
            sql.close();
            return g;
          });
      console.log("Groupes :");
      printGroups(groups);
    }
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else if (command) {
  console.error(`Commande inconnue : ${command}. Commandes : groupes, nouveau-groupe <nom>.`);
  process.exit(1);
}

// Essai local.
const { startCentralServer } = await local();
const server = await startCentralServer({ port, dbPath });
if (server.store.listGroups().length === 0) server.store.createGroup("Mes amis");
console.log(`Serveur central d'essai lancé : http://localhost:${server.port}`);
console.log(`Données : ${dbPath}`);
console.log("\nGroupes (code à donner aux amis) :");
printGroups(server.store.listGroups());
console.log("\nPour un serveur toujours disponible, déploie-le sur Cloudflare (docs/serveur-central.md).");
console.log("Ctrl+C pour arrêter.");

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
