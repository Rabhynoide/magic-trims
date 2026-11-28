import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import {
  archidektDeckId,
  CentralClient,
  CentralError,
  fetchArchidektDeck,
  parseDeckList,
  resolveDeck,
  ScryfallClient,
  validateCommanderDeck,
  type CardData,
  type CentralConnection,
  type DeckEntry,
  type LocalizedCard,
  type ParsedDeck,
  type ShareDeckInput,
} from "@magic-trims/core";
import { loadSnapshot, startHostServer, type HostServer } from "@magic-trims/host";
import type { AppInfo, CardToLocalize, CentralResult, DeckImportResult, HostInfo } from "../shared/api.js";
import { FileCache, FileCardCache } from "./scryfall-cache.js";
import { setupUpdater } from "./updater.js";

/** Commit du code, inscrit au moment de la construction (voir electron.vite.config.ts). */
declare const __APP_COMMIT__: string;

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

ipcMain.handle("cards:resolve", async (_e, lines: string[]): Promise<(CardData | null)[]> => {
  const entries = lines.map((l) => parseDeckList(l).mainboard[0]);
  const deck = (list: DeckEntry[]): ParsedDeck => ({ commanders: list, mainboard: [], other: [], errors: [] });
  // Une requête groupée remplit le cache, puis chaque ligne est relue depuis le cache.
  await resolveDeck(deck(entries.filter((e) => e !== undefined)), scryfall);
  const result: (CardData | null)[] = [];
  for (const e of entries) {
    result.push(e ? ((await resolveDeck(deck([e]), scryfall)).deck.commanders[0] ?? null) : null);
  }
  await cardCache.flush();
  return result;
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

/**
 * Serveur central facultatif. Les erreurs (serveur injoignable, code faux…)
 * reviennent comme valeur, pour que l'interface affiche un message clair ;
 * rien d'autre dans l'appli n'en dépend.
 */
async function central<T>(run: () => Promise<T>): Promise<CentralResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (err instanceof CentralError) return { ok: false, error: err.message, status: err.status };
    return { ok: false, error: err instanceof Error ? err.message : String(err), status: 0 };
  }
}
const centralClient = (conn: CentralConnection) => new CentralClient({ url: conn.url, token: conn.token });

ipcMain.handle("central:join", (_e, url: string, code: string, name: string) =>
  central(async () => {
    const client = new CentralClient({ url });
    return { ...(await client.join(code, name)), url: client.url };
  }),
);
ipcMain.handle("central:listDecks", (_e, conn: CentralConnection) => central(() => centralClient(conn).listDecks()));
ipcMain.handle("central:shareDeck", (_e, conn: CentralConnection, deck: ShareDeckInput) =>
  central(() => centralClient(conn).shareDeck(deck)),
);
ipcMain.handle("central:unshareDeck", (_e, conn: CentralConnection, id: string) =>
  central(() => centralClient(conn).unshareDeck(id)),
);

ipcMain.handle(
  "app:info",
  (): AppInfo => ({
    version: app.getVersion(),
    ...(__APP_COMMIT__ ? { commit: __APP_COMMIT__ } : {}),
    packaged: app.isPackaged,
  }),
);

/** Avant d'installer une mise à jour : on ferme proprement la partie hébergée et les caches. */
async function shutdown(): Promise<void> {
  await server?.close();
  server = null;
  await cardCache.flush();
  await localizedCache.flush();
}

setupUpdater(shutdown);

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  void shutdown().then(() => app.quit());
});
