import { execSync } from "node:child_process";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// L'appli n'a que des devDependencies : tout le code (paquets du dépôt, ws,
// UPnP…) est intégré au bundle, et l'installateur n'embarque aucun node_modules.
/** Commit du code construit : celui de la CI, sinon celui du dépôt local. */
function currentCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  main: {
    define: { __APP_COMMIT__: JSON.stringify(currentCommit()) },
  },
  preload: {
    build: {
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: {
      minify: process.env.MAGIC_DEBUG ? false : "oxc",
      rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
    },
  },
});
