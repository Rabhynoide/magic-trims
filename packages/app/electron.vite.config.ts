import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// L'appli n'a que des devDependencies : tout le code (paquets du dépôt, ws,
// UPnP…) est intégré au bundle, et l'installateur n'embarque aucun node_modules.
export default defineConfig({
  main: {},
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
