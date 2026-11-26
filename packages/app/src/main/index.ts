import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import {
  archidektDeckId,
  fetchArchidektDeck,
  parseDeckList,
  resolveDeck,
  ScryfallClient,
  validateCommanderDeck,
  type LocalizedCard,
} from "@magic-trims/core";
import { loadSnapshot, startHostServer, type HostServer } from "@magic-trims/host";
import type { CardToLocalize, DeckImportResult, HostInfo } from "../shared/api.js";
import { FileCache, FileCardCache } from "./scryfall-cache.js";

const userData = app.getPath("userData");
const savePath = join(userData, "partie-en-cours.json");
const cardCache = new FileCardCache(join(userData, "cache-scryfall.json"));
/** Traductions déjà cherchées (`null` : pas imprimée dans cette langue). */
const localizedCache = new FileCache<LocalizedCard | null>(join(userData, "cache-traductions.json"));
const scryfall = new ScryfallClient({ cache: cardCache, userAgent: `MagicTrims/${app.getVersion()}` });

let server: HostServer | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#14161c",
    title: "Magic Trims",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  // Les liens externes (Scryfall, Moxfield…) s'ouvrent dans le navigateur.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

ipcMain.handle("host:start", async (_e, options: { resume: boolean }): Promise<HostInfo> => {
  if (server) await server.close();
  server = await startHostServer({
    savePath,
    ...(options.resume && existsSync(savePath) ? { restore: await loadSnapshot(savePath) } : {}),
  });
  return { port: server.port, hostKey: server.hostKey, addresses: server.addresses, upnp: server.upnp };
});

ipcMain.handle("host:stop", async () => {
  await server?.close();
  server = null;
});

ipcMain.handle("host:hasSavedGame", async () => {
  if (!existsSync(savePath)) return false;
  try {
    return (await loadSnapshot(savePath)).game !== null;
  } catch {
    return false;
  }
});

ipcMain.handle("deck:import", async (_e, text: string): Promise<DeckImportResult> => {
  // Un lien Archidekt : on va chercher le deck directement.
  const archidektId = archidektDeckId(text);
  let name: string | undefined;
  if (archidektId) {
    const fetched = await fetchArchidektDeck(archidektId);
    name = fetched.name || undefined;
    text = fetched.text;
  }
  const parsed = parseDeckList(text);
  const { deck, unresolved } = await resolveDeck(parsed, scryfall);
  await cardCache.flush();
  return {
    deck,
    unresolved,
    parseErrors: parsed.errors,
    issues: validateCommanderDeck(deck),
    ...(name ? { name } : {}),
  };
});

ipcMain.handle("cards:search", async (_e, query: string) => {
  return scryfall.search(query);
});

ipcMain.handle(
  "cards:localize",
  async (_e, cards: CardToLocalize[], lang: string): Promise<Record<string, LocalizedCard | null>> => {
    const result: Record<string, LocalizedCard | null> = {};
    const missing: CardToLocalize[] = [];
    for (const card of cards) {
      const cached = await localizedCache.get(`${lang}:${card.id}`);
      if (cached !== undefined) result[card.id] = cached;
      else missing.push(card);
    }
    if (missing.length > 0) {
      const found = await scryfall.localize(missing, lang);
      for (const card of missing) {
        const value = found.get(card.id) ?? null;
        result[card.id] = value;
        await localizedCache.set(`${lang}:${card.id}`, value);
      }
    }
    return result;
  },
);

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  void (async () => {
    await server?.close();
    await cardCache.flush();
    await localizedCache.flush();
    app.quit();
  })();
});
