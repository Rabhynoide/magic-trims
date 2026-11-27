import { contextBridge, ipcRenderer } from "electron";
import type { MagicApi, UpdateStatus } from "../shared/api.js";

const api: MagicApi = {
  startHost: (options) => ipcRenderer.invoke("host:start", options),
  stopHost: () => ipcRenderer.invoke("host:stop"),
  hasSavedGame: () => ipcRenderer.invoke("host:hasSavedGame"),
  importDeck: (text) => ipcRenderer.invoke("deck:import", text),
  searchCards: (query) => ipcRenderer.invoke("cards:search", query),
  localizeCards: (cards, lang) => ipcRenderer.invoke("cards:localize", cards, lang),
  central: {
    join: (url, code, name) => ipcRenderer.invoke("central:join", url, code, name),
    listDecks: (conn) => ipcRenderer.invoke("central:listDecks", conn),
    shareDeck: (conn, deck) => ipcRenderer.invoke("central:shareDeck", conn, deck),
    unshareDeck: (conn, id) => ipcRenderer.invoke("central:unshareDeck", conn, id),
  },
  appInfo: () => ipcRenderer.invoke("app:info"),
  updates: {
    status: () => ipcRenderer.invoke("updates:status"),
    onStatus: (listener) => {
      const handler = (_e: unknown, status: UpdateStatus) => listener(status);
      ipcRenderer.on("updates:status", handler);
      return () => ipcRenderer.off("updates:status", handler);
    },
    check: () => ipcRenderer.invoke("updates:check"),
    install: () => ipcRenderer.invoke("updates:install"),
  },
};

contextBridge.exposeInMainWorld("magic", api);
