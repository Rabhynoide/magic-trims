import { app, BrowserWindow, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateStatus } from "../shared/api.js";

const { autoUpdater } = electronUpdater;

/** Vérification au démarrage, puis toutes les deux heures. */
const FIRST_CHECK_MS = 3000;
const CHECK_EVERY_MS = 2 * 60 * 60 * 1000;

/**
 * Mise à jour de l'appli installée (.exe) depuis les GitHub Releases du dépôt.
 * Rien n'est téléchargé sans l'accord du joueur : l'interface affiche un
 * bandeau, et le bouton télécharge puis installe la nouvelle version avant de
 * relancer l'appli.
 *
 * Lancée avec `npm run app`, l'appli ne se met pas à jour toute seule (c'est
 * `git pull` qui s'en charge) : l'état reste « unsupported ».
 */
export function setupUpdater(beforeInstall: () => Promise<void>): void {
  let status: UpdateStatus = app.isPackaged
    ? { state: "idle" }
    : { state: "unsupported", reason: "Appli lancée depuis le code (npm run app) : mise à jour par git pull." };
  /** Le joueur a demandé l'installation : on installe dès la fin du téléchargement. */
  let installWanted = false;

  const set = (next: UpdateStatus) => {
    status = next;
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("updates:status", status);
  };

  const install = async () => {
    await beforeInstall();
    // Installation silencieuse dans le même dossier, puis relance de l'appli.
    autoUpdater.quitAndInstall(true, true);
  };

  ipcMain.handle("updates:status", () => status);
  ipcMain.handle("updates:check", () => check());
  ipcMain.handle("updates:install", async () => {
    if (status.state === "ready") return install();
    if ((status.state !== "available" && status.state !== "error") || !status.version) return;
    const version = status.version;
    installWanted = true;
    set({ state: "downloading", version, percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      installWanted = false;
      set({ state: "error", message: errorText(err), version });
    }
  });

  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("checking-for-update", () => {
    if (status.state === "idle" || status.state === "none" || status.state === "error") set({ state: "checking" });
  });
  autoUpdater.on("update-available", (info) => set({ state: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => set({ state: "none" }));
  autoUpdater.on("download-progress", (p) => {
    const version = ("version" in status ? status.version : undefined) ?? "";
    set({ state: "downloading", version, percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    set({ state: "ready", version: info.version });
    if (installWanted) void install();
  });
  // Une vérification ratée (pas d'Internet…) ne dérange pas le joueur ; une
  // installation ratée s'affiche, avec un bouton pour réessayer.
  autoUpdater.on("error", (err) => {
    if (installWanted || status.state === "downloading") {
      installWanted = false;
      set({ state: "error", message: errorText(err), ...("version" in status ? { version: status.version } : {}) });
    } else if (status.state === "checking") set({ state: "none" });
    console.warn("Mise à jour :", errorText(err));
  });

  async function check(): Promise<void> {
    // Pas de nouvelle vérification pendant un téléchargement ou une fois prêt.
    if (status.state === "downloading" || status.state === "ready" || status.state === "unsupported") return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      if (status.state === "checking") set({ state: "none" });
      console.warn("Mise à jour :", errorText(err));
    }
  }

  setTimeout(() => void check(), FIRST_CHECK_MS);
  setInterval(() => void check(), CHECK_EVERY_MS);
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // Les erreurs d'electron-updater peuvent contenir toute une réponse HTTP.
  return text.split("\n")[0]!.slice(0, 200);
}
