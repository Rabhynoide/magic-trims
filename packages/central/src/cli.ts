/**
 * Serveur central facultatif, à lancer sur un PC toujours allumé ou un serveur :
 *   npm run central                       démarre le serveur
 *   npm run central -- groupes            affiche les groupes et leurs codes
 *   npm run central -- nouveau-groupe Nom crée un groupe d'amis
 * Options : --port 47475, --base chemin/vers/central.sqlite, --upnp (ouvre le port de la box).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describeAddress, lanAddresses, openPort, type PortMapping } from "@magic-trims/host";
import { CENTRAL_DEFAULT_PORT } from "@magic-trims/core";
import { startCentralServer } from "./server.js";
import { CentralStore } from "./store.js";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}
const upnp = args.includes("--upnp");
if (upnp) args.splice(args.indexOf("--upnp"), 1);
const port = Number(option("--port") ?? process.env.MAGIC_TRIMS_CENTRAL_PORT ?? CENTRAL_DEFAULT_PORT);
const dbPath = option("--base") ?? process.env.MAGIC_TRIMS_CENTRAL_DB ?? join(homedir(), ".magic-trims", "central.sqlite");
const [command, ...rest] = args;

function printGroups(store: CentralStore): void {
  for (const g of store.listGroups()) console.log(`  ${g.code}   ${g.name}`);
}

if (command === "groupes" || command === "nouveau-groupe") {
  const store = new CentralStore(dbPath);
  if (command === "nouveau-groupe") {
    const group = store.createGroup(rest.join(" "));
    console.log(`Groupe « ${group.name} » créé. Code à donner aux amis : ${group.code}`);
  } else {
    console.log("Groupes :");
    printGroups(store);
  }
  store.close();
  process.exit(0);
} else if (command) {
  console.error(`Commande inconnue : ${command}. Commandes : groupes, nouveau-groupe <nom>.`);
  process.exit(1);
}

const server = await startCentralServer({ port, dbPath });
if (server.store.listGroups().length === 0) server.store.createGroup("Mes amis");

console.log(`Serveur central lancé sur le port ${server.port}.`);
console.log(`Données : ${dbPath} (copie ce fichier pour faire une sauvegarde).`);
console.log("\nGroupes (code à donner aux amis) :");
printGroups(server.store);

let mapping: PortMapping | null = null;
let refresh: NodeJS.Timeout | null = null;
if (upnp) {
  const open = async () => {
    const result = await openPort(server.port, { description: "Magic Trims (serveur central)" });
    if (result.ok) mapping = result.mapping;
    return result;
  };
  const result = await open();
  if (result.ok) console.log(`\nPort ouvert sur la box. Adresse publique : ${result.mapping.publicIp}:${server.port}`);
  else console.log(`\nLa box n'a pas ouvert le port (${result.reason}).`);
  // Le bail UPnP dure 6 heures : on le renouvelle.
  refresh = setInterval(() => void open(), 5 * 3600_000);
}
console.log("\nAdresses de ce PC :");
for (const ip of lanAddresses()) console.log(`  ${ip}:${server.port}   (${describeAddress(ip)})`);
console.log("Ctrl+C pour arrêter.");

const stop = async () => {
  if (refresh) clearInterval(refresh);
  await (mapping as PortMapping | null)?.close().catch(() => {});
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
