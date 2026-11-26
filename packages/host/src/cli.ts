/**
 * Lance un serveur de partie depuis un terminal, sans l'interface :
 *   npm run host
 * Utile pour vérifier que la box accepte d'ouvrir le port (UPnP) et que les
 * amis arrivent à se connecter.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { startHostServer } from "./server.js";
import { loadSnapshot } from "./persistence.js";

const savePath = join(homedir(), ".magic-trims", "partie-en-cours.json");
const resume = process.argv.includes("--reprendre");

const server = await startHostServer({
  savePath,
  ...(resume ? { restore: await loadSnapshot(savePath) } : {}),
});

console.log(`Serveur de partie lancé sur le port ${server.port}.`);
if (server.upnp.ok) {
  console.log(`Port ouvert sur la box : tes amis peuvent te rejoindre par internet.`);
} else {
  console.log(`La box n'a pas ouvert le port (${server.upnp.reason}).`);
  console.log(`Solutions : un réseau privé virtuel (Radmin VPN, Tailscale) ou une redirection de port manuelle.`);
}
console.log("\nAdresses à donner à tes amis :");
for (const a of server.addresses) console.log(`  ${a.code}   ${a.ip}:${server.port}   (${a.kind})`);
console.log(`\nSauvegarde automatique : ${savePath}`);
console.log("Ctrl+C pour arrêter.");

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
