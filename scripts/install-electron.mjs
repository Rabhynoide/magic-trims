// Télécharge le binaire d'Electron après `npm install`.
// Les versions récentes de npm ne lancent plus les scripts d'installation des
// dépendances (dont celui d'Electron) : le projet le fait donc lui-même.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) process.exit(0);
const script = "node_modules/electron/install.js";
if (!existsSync(script)) process.exit(0);
const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
process.exit(result.status ?? 1);
